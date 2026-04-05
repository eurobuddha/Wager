/**
 * Wager — Transaction Builders
 *
 * All transaction construction for the prediction market:
 *   postBet()      — Create a new bet (send to script address)
 *   fillBet()      — Match an existing bet (phase 0→1)
 *   cancelBet()    — Owner cancels unmatched bet (phase 0)
 *   resolveBet()   — Arbiter declares outcome (phase 1)
 *   timeoutBet()   — Refund both sides after arbiter timeout (phase 1)
 *   collectExpired() — Return expired unmatched bets to owner (phase 0)
 */

// -- Constants --
var ESCROW_RATE = 0.25; // 25% escrow insurance on top of bet

// -- Identity --
var MY_PUBKEY = "";
var MY_HEX_ADDR = "";
var MY_ADDR = "";
var MY_KEYS = {};

// -- State --
var BETS = [];
var OPEN_BETS = [];
var MY_BETS = [];
var MATCHED_BETS = [];
var CURRENT_BLOCK = 0;

// -- Transaction lock (from Escrow pattern) --
var TXN_LOCKED = false;
var TXN_QUEUE = [];

function acquireTxnLock(fn) {
    if (TXN_LOCKED) { TXN_QUEUE.push(fn); return; }
    TXN_LOCKED = true;
    fn();
}

function releaseTxnLock() {
    TXN_LOCKED = false;
    if (TXN_QUEUE.length > 0) {
        acquireTxnLock(TXN_QUEUE.shift());
    }
}

// -- Identity Loading (from Limit pattern) --

function loadIdentity(callback) {
    MDS.keypair.get("wager_pubkey", function(kres) {
        if (kres.status && kres.value && kres.value.length > 10) {
            MY_PUBKEY = kres.value;
            MDS.keypair.get("wager_hexaddr", function(k2) {
                MY_HEX_ADDR = (k2.status && k2.value) ? k2.value : "";
                MDS.keypair.get("wager_miniaddr", function(k3) {
                    MY_ADDR = (k3.status && k3.value) ? k3.value : MY_HEX_ADDR;
                    if (MY_PUBKEY && MY_HEX_ADDR) { callback(); return; }
                    fetchAndStoreIdentity(callback);
                });
            });
            return;
        }
        fetchAndStoreIdentity(callback);
    });
}

function fetchAndStoreIdentity(callback) {
    MDS.cmd("getaddress", function(res) {
        if (!res.status) { callback(); return; }
        MY_PUBKEY = res.response.publickey;
        MY_HEX_ADDR = res.response.address;
        MY_ADDR = res.response.miniaddress;
        MDS.keypair.set("wager_pubkey", MY_PUBKEY, function() {
            MDS.keypair.set("wager_hexaddr", MY_HEX_ADDR, function() {
                MDS.keypair.set("wager_miniaddr", MY_ADDR, function() { callback(); });
            });
        });
    });
}

function loadWalletKeys(callback) {
    MDS.cmd("keys", function(res) {
        try {
            if (res && res.status && res.response) {
                var list = res.response.keys || res.response;
                if (Array.isArray(list)) {
                    for (var i = 0; i < list.length; i++) {
                        var pk = list[i].publickey || list[i];
                        if (pk && typeof pk === "string") MY_KEYS[pk] = true;
                    }
                }
            }
        } catch(e) { MDS.log("Keys error: " + e); }
        if (MY_PUBKEY) MY_KEYS[MY_PUBKEY] = true;
        MDS.log("Wallet keys loaded: " + Object.keys(MY_KEYS).length);
        if (callback) callback();
    });
}

function isMyKey(pubkey) {
    return MY_KEYS[pubkey] === true;
}

// -- Generate Bet ID --

function generateBetId() {
    return "0x" + Date.now().toString(16) + Math.random().toString(16).substring(2, 10);
}

// -- Post Bet (Phase 0) --
// Creates a new bet at the script address
// Params: market (string), side (1=YES, 0=NO), stake (string), wantstake (string),
//         arbpk, arbaddr, timeout (blocks), callback(success, error)

function postBet(params, callback) {
    acquireTxnLock(function() {
        var betid = generateBetId();

        var stateObj = JSON.stringify({
            "0": MY_PUBKEY,
            "1": MY_HEX_ADDR,
            "2": params.arbpk,
            "3": params.arbaddr,
            "4": "0",
            "5": "" + params.timeout,
            "6": "" + params.side,
            "7": "" + params.wantstake
        });

        var cmd = "send amount:" + params.stake + " address:" + WAGER_SCRIPT_ADDRESS + " state:" + stateObj;

        MDS.log("POST BET: " + cmd);
        logActivity("Posting " + (params.side === 1 ? "BACK" : "LAY") + " bet — " + params.stake + " MINIMA at " + calcOdds(params.stake, params.wantstake) + "x", "info");

        MDS.cmd(cmd, function(res) {
            releaseTxnLock();
            if (res.status) {
                // Record in local DB
                insertBet({
                    betid: betid,
                    market: params.market,
                    arbpk: params.arbpk,
                    arbaddr: params.arbaddr,
                    arbname: params.arbname || "",
                    side: params.side,
                    ownerstake: params.stake,
                    counterstake: params.wantstake,
                    ownerpk: MY_PUBKEY,
                    owneraddr: MY_HEX_ADDR,
                    phase: 0,
                    timeout: params.timeout,
                    myrole: "owner",
                    status: "OPEN"
                });
                logActivity("Bet posted — waiting for confirmation", "ok");
                callback(true, null);
            } else {
                var err = res.error || "Failed to post bet";
                logActivity("Bet failed — " + err, "err");
                callback(false, err);
            }
        });
    });
}

// -- Fill Bet (Phase 0→1) --
// Counter matches an existing bet. Constructs multi-input/output transaction.
// Params: bet (coin object with state), callback(success, error)

function fillBet(bet, callback) {
    acquireTxnLock(function() {
        var txid = "fill_" + Date.now();
        var ownerStake = bet.amount;               // coin amount = owner's stake
        var counterStake = getStateVal(bet, 7);     // wantstake from state
        var totalPot = (parseFloat(ownerStake) + parseFloat(counterStake)).toFixed(8);

        MDS.log("FILL BET: ownerStake=" + ownerStake + " counterStake=" + counterStake + " total=" + totalPot);
        logActivity("Filling bet — putting up " + counterStake + " MINIMA", "info");

        MDS.cmd("txncreate id:" + txid, function(r0) {
            if (!r0.status) { releaseTxnLock(); callback(false, "txncreate failed"); return; }

            // Input 0: the bet coin at script address
            MDS.cmd("txninput id:" + txid + " coinid:" + bet.coinid, function(r1) {
                if (!r1.status) { cleanupTxn(txid); callback(false, "bet input failed"); return; }

                // Find coins to cover counter stake
                findCoins("0x00", counterStake, function(result) {
                    if (!result) { cleanupTxn(txid); callback(false, "Insufficient funds (need " + counterStake + " MINIMA)"); return; }

                    addMultipleInputs(txid, result.coins, 0, function(ok) {
                        if (!ok) { cleanupTxn(txid); callback(false, "Funding input failed"); return; }

                        // Output 0: total pot back to script address (storestate:true for phase transition)
                        MDS.cmd("txnoutput id:" + txid + " amount:" + totalPot + " address:" + WAGER_SCRIPT_ADDRESS + " storestate:true", function(r2) {
                            if (!r2.status) { cleanupTxn(txid); callback(false, "Pot output failed"); return; }

                            // Output 1: change back to filler (if any)
                            var change = (result.total - parseFloat(counterStake)).toFixed(8);
                            var doSign = function() {
                                // Set state: preserve 0-3, set 4=1 (phase), preserve 5-7, add 8-10
                                setFillState(txid, bet, function(stateOk) {
                                    if (!stateOk) { cleanupTxn(txid); callback(false, "State set failed"); return; }

                                    logActivity("Signing fill transaction...", "info");
                                    MDS.cmd("txnsign id:" + txid + " publickey:auto", function(signRes) {
                                        if (signRes && signRes.status) {
                                            MDS.cmd("txnbasics id:" + txid + ";txnpost id:" + txid, function(postArr) {
                                                releaseTxnLock();
                                                var rp = Array.isArray(postArr) ? postArr[postArr.length - 1] : postArr;
                                                if (rp && rp.status) {
                                                    logActivity("Bet matched! Waiting for confirmation...", "ok");
                                                    callback(true, null);
                                                } else {
                                                    logActivity("Fill post failed — " + (rp ? rp.error || "unknown" : "no response"), "err");
                                                    callback(false, rp ? rp.error : "post failed");
                                                }
                                            });
                                        } else {
                                            releaseTxnLock();
                                            var serr = signRes ? signRes.error || "sign failed" : "no response";
                                            logActivity("Sign failed — " + serr, "err");
                                            MDS.cmd("txndelete id:" + txid);
                                            callback(false, serr);
                                        }
                                    });
                                });
                            };

                            if (parseFloat(change) > 0.000001) {
                                MDS.cmd("txnoutput id:" + txid + " amount:" + change + " address:" + MY_HEX_ADDR + " storestate:false", function(r3) {
                                    if (!r3.status) { cleanupTxn(txid); callback(false, "Change output failed"); return; }
                                    doSign();
                                });
                            } else { doSign(); }
                        });
                    });
                });
            });
        });
    });
}

function setFillState(txid, bet, callback) {
    var ownerStake = bet.amount;
    // Preserve ports 0-3 from the bet coin, set 4=1, preserve 5-7, add 8-10
    var states = {
        0: getStateVal(bet, 0),         // ownerpk
        1: getStateVal(bet, 1),         // owneraddr
        2: getStateVal(bet, 2),         // arbpk
        3: getStateVal(bet, 3),         // arbaddr
        4: "1",                          // phase → 1 (matched)
        5: getStateVal(bet, 5),         // timeout
        6: getStateVal(bet, 6),         // side
        7: getStateVal(bet, 7),         // wantstake
        8: MY_PUBKEY,                    // counterpk
        9: MY_HEX_ADDR,                 // counteraddr
        10: ownerStake                   // ownerstake (= @AMOUNT at fill time)
    };
    setTxnState(txid, states, callback);
}

// -- Cancel Bet (Phase 0) --
// Owner reclaims unmatched bet. SIGNEDBY(owner) path.

function cancelBet(coinid, callback) {
    acquireTxnLock(function() {
        var txid = "cancel_" + Date.now();

        MDS.cmd("txncreate id:" + txid, function(r0) {
            if (!r0.status) { releaseTxnLock(); callback(false, "txncreate failed"); return; }

            MDS.cmd("txninput id:" + txid + " coinid:" + coinid, function(r1) {
                if (!r1.status) { cleanupTxn(txid); callback(false, "input failed"); return; }

                // Get coin details for amount and owner address
                MDS.cmd("coins coinid:" + coinid, function(coinRes) {
                    if (!coinRes.status || !coinRes.response || coinRes.response.length === 0) {
                        cleanupTxn(txid); callback(false, "coin not found"); return;
                    }
                    var coin = coinRes.response[0];
                    var ownerAddr = getStateVal(coin, 1);
                    var amt = coin.amount;

                    MDS.cmd("txnoutput id:" + txid + " amount:" + amt + " address:" + ownerAddr + " storestate:false", function(r2) {
                        if (!r2.status) { cleanupTxn(txid); callback(false, "output failed"); return; }

                        MDS.cmd("txnsign id:" + txid + " publickey:" + getStateVal(coin, 0), function(signRes) {
                            if (signRes && signRes.status) {
                                MDS.cmd("txnbasics id:" + txid + ";txnpost id:" + txid, function(postArr) {
                                    releaseTxnLock();
                                    var rp = Array.isArray(postArr) ? postArr[postArr.length - 1] : postArr;
                                    if (rp && rp.status) {
                                        logActivity("Bet cancelled", "ok");
                                        callback(true, null);
                                    } else {
                                        logActivity("Cancel post failed", "err");
                                        callback(false, rp ? rp.error : "post failed");
                                    }
                                });
                            } else {
                                releaseTxnLock();
                                logActivity("Cancel sign failed", "err");
                                MDS.cmd("txndelete id:" + txid);
                                callback(false, signRes ? signRes.error : "sign failed");
                            }
                        });
                    });
                });
            });
        });
    });
}

// -- Self-Settle (Phase 1) --
// Both bettors agree on outcome — no arbiter needed, 0% fee.
// Requires BOTH parties to sign (2-of-2 MULTISIG path).
// The JS builds the payout transaction; both sign sequentially.
// Params: coinid, outcome (1=BACK, 0=LAY), callback(success, error)

function selfSettle(coinid, outcome, callback) {
    acquireTxnLock(function() {
        var txid = "settle_" + Date.now();

        MDS.cmd("txncreate id:" + txid, function(r0) {
            if (!r0.status) { releaseTxnLock(); callback(false, "txncreate failed"); return; }

            MDS.cmd("txninput id:" + txid + " coinid:" + coinid, function(r1) {
                if (!r1.status) { cleanupTxn(txid); callback(false, "input failed"); return; }

                MDS.cmd("coins coinid:" + coinid, function(coinRes) {
                    if (!coinRes.status || !coinRes.response || coinRes.response.length === 0) {
                        cleanupTxn(txid); callback(false, "coin not found"); return;
                    }
                    var coin = coinRes.response[0];
                    var totalPot = parseFloat(coin.amount);
                    var ownerSide = parseInt(getStateVal(coin, 6));
                    var ownerAddr = getStateVal(coin, 1);
                    var counterAddr = getStateVal(coin, 9);

                    var winnerAddr = (outcome === ownerSide) ? ownerAddr : counterAddr;

                    // Single output — winner takes all, 0% fee
                    MDS.cmd("txnoutput id:" + txid + " amount:" + totalPot.toFixed(8) + " address:" + winnerAddr + " storestate:false", function(r2) {
                        if (!r2.status) { cleanupTxn(txid); callback(false, "output failed"); return; }

                        // Sign with auto (our key — first signature)
                        MDS.cmd("txnsign id:" + txid + " publickey:auto", function(signRes) {
                            if (signRes && signRes.status) {
                                // Export for counter-party to co-sign
                                MDS.cmd("txnexport id:" + txid, function(expRes) {
                                    releaseTxnLock();
                                    if (expRes && expRes.status) {
                                        logActivity("Self-settle signed — needs counter-party signature", "warn");
                                        callback(true, null, expRes.response.data);
                                    } else {
                                        logActivity("Export failed", "err");
                                        MDS.cmd("txndelete id:" + txid);
                                        callback(false, "export failed");
                                    }
                                });
                            } else {
                                releaseTxnLock();
                                MDS.cmd("txndelete id:" + txid);
                                callback(false, signRes ? signRes.error : "sign failed");
                            }
                        });
                    });
                });
            });
        });
    });
}

// Co-sign and post a self-settle transaction (called by the counter-party)
function cosignAndPost(txnHex, callback) {
    var txid = "cosign_" + Date.now();
    MDS.cmd("txnimport id:" + txid + " data:" + txnHex, function(r1) {
        if (!r1 || !r1.status) { callback(false, "import failed"); return; }
        MDS.cmd("txnsign id:" + txid + " publickey:auto", function(r2) {
            if (!r2 || !r2.status) { MDS.cmd("txndelete id:" + txid); callback(false, "cosign failed"); return; }
            MDS.cmd("txnbasics id:" + txid + ";txnpost id:" + txid, function(postArr) {
                var rp = Array.isArray(postArr) ? postArr[postArr.length - 1] : postArr;
                if (rp && rp.status) {
                    logActivity("Self-settle posted — 0% fee!", "ok");
                    callback(true, null);
                } else {
                    MDS.cmd("txndelete id:" + txid);
                    callback(false, rp ? rp.error : "post failed");
                }
            });
        });
    });
}

// -- Resolve Bet (Phase 1) --
// Arbiter declares outcome. 10% of winner's profit as fee.
// Params: coinid, outcome (1=BACK wins, 0=LAY wins, 2=VOID), callback(success, error)

function resolveBet(coinid, outcome, callback) {
    acquireTxnLock(function() {
        var txid = "resolve_" + Date.now();

        MDS.cmd("txncreate id:" + txid, function(r0) {
            if (!r0.status) { releaseTxnLock(); callback(false, "txncreate failed"); return; }

            MDS.cmd("txninput id:" + txid + " coinid:" + coinid, function(r1) {
                if (!r1.status) { cleanupTxn(txid); callback(false, "input failed"); return; }

                MDS.cmd("coins coinid:" + coinid, function(coinRes) {
                    if (!coinRes.status || !coinRes.response || coinRes.response.length === 0) {
                        cleanupTxn(txid); callback(false, "coin not found"); return;
                    }
                    var coin = coinRes.response[0];
                    var totalPot = parseFloat(coin.amount);
                    var ownerStake = parseFloat(getStateVal(coin, 10));
                    var ownerSide = parseInt(getStateVal(coin, 6));
                    var ownerAddr = getStateVal(coin, 1);
                    var counterAddr = getStateVal(coin, 9);
                    var arbAddr = getStateVal(coin, 3);
                    var arbPk = getStateVal(coin, 2);

                    // VOID: 10% of pot to arbiter, 90% refund proportionally
                    if (outcome === 2) {
                        var voidFee = Math.floor((totalPot / 10) * 1e8) / 1e8;
                        var ownerRefund = Math.floor((ownerStake - ownerStake / 10) * 1e8) / 1e8;
                        var counterRefund = Math.floor((totalPot - voidFee - ownerRefund) * 1e8) / 1e8;

                        MDS.log("VOID: fee=" + voidFee + " ownerRefund=" + ownerRefund + " counterRefund=" + counterRefund);

                        MDS.cmd("txnoutput id:" + txid + " amount:" + ownerRefund.toFixed(8) + " address:" + ownerAddr + " storestate:false", function(r2) {
                            if (!r2.status) { cleanupTxn(txid); callback(false, "owner refund output failed"); return; }
                            MDS.cmd("txnoutput id:" + txid + " amount:" + counterRefund.toFixed(8) + " address:" + counterAddr + " storestate:false", function(r3) {
                                if (!r3.status) { cleanupTxn(txid); callback(false, "counter refund output failed"); return; }
                                MDS.cmd("txnoutput id:" + txid + " amount:" + voidFee.toFixed(8) + " address:" + arbAddr + " storestate:false", function(r4) {
                                    if (!r4.status) { cleanupTxn(txid); callback(false, "fee output failed"); return; }
                                    MDS.cmd("txnstate id:" + txid + " port:11 value:2", function(r5) {
                                        if (!r5.status) { cleanupTxn(txid); callback(false, "state failed"); return; }
                                        signAndPostArbiter(txid, arbPk, "Bet voided", callback);
                                    });
                                });
                            });
                        });
                        return;
                    }

                    // BACK or LAY wins: 10% of profit as fee
                    var profit, winnerAddr;
                    if (outcome === ownerSide) {
                        profit = totalPot - ownerStake;
                        winnerAddr = ownerAddr;
                    } else {
                        profit = ownerStake;
                        winnerAddr = counterAddr;
                    }
                    var fee = Math.floor((profit / 10) * 1e8) / 1e8;
                    var winnings = (totalPot - fee).toFixed(8);
                    var feeStr = fee.toFixed(8);

                    MDS.log("RESOLVE: outcome=" + outcome + " profit=" + profit + " fee=" + feeStr + " winner=" + winnerAddr);

                    // Output 0 (@INPUT): winnings to winner
                    MDS.cmd("txnoutput id:" + txid + " amount:" + winnings + " address:" + winnerAddr + " storestate:false", function(r2) {
                        if (!r2.status) { cleanupTxn(txid); callback(false, "winner output failed"); return; }

                        // Output 1 (@INPUT+1): fee to arbiter
                        MDS.cmd("txnoutput id:" + txid + " amount:" + feeStr + " address:" + arbAddr + " storestate:false", function(r3) {
                            if (!r3.status) { cleanupTxn(txid); callback(false, "fee output failed"); return; }

                            MDS.cmd("txnstate id:" + txid + " port:11 value:" + outcome, function(r4) {
                                if (!r4.status) { cleanupTxn(txid); callback(false, "state set failed"); return; }
                                var label = outcome === 1 ? "BACK wins" : "LAY wins";
                                signAndPostArbiter(txid, arbPk, label, callback);
                            });
                        });
                    });
                });
            });
        });
    });
}

// -- Arbiter sign + post helper --

function signAndPostArbiter(txid, arbPk, label, callback) {
    MDS.cmd("txnsign id:" + txid + " publickey:" + arbPk, function(signRes) {
        if (signRes && signRes.status) {
            MDS.cmd("txnbasics id:" + txid + ";txnpost id:" + txid, function(postArr) {
                releaseTxnLock();
                var rp = Array.isArray(postArr) ? postArr[postArr.length - 1] : postArr;
                if (rp && rp.status) {
                    logActivity("Bet resolved — " + label + "!", "ok");
                    callback(true, null);
                } else {
                    logActivity("Resolve post failed", "err");
                    callback(false, rp ? rp.error : "post failed");
                }
            });
        } else {
            releaseTxnLock();
            logActivity("Resolve sign failed", "err");
            MDS.cmd("txndelete id:" + txid);
            callback(false, signRes ? signRes.error : "sign failed");
        }
    });
}

// -- Timeout Refund (Phase 1) --
// Either party triggers refund when arbiter disappears.

function timeoutBet(coinid, callback) {
    acquireTxnLock(function() {
        var txid = "timeout_" + Date.now();

        MDS.cmd("txncreate id:" + txid, function(r0) {
            if (!r0.status) { releaseTxnLock(); callback(false, "txncreate failed"); return; }

            MDS.cmd("txninput id:" + txid + " coinid:" + coinid, function(r1) {
                if (!r1.status) { cleanupTxn(txid); callback(false, "input failed"); return; }

                MDS.cmd("coins coinid:" + coinid, function(coinRes) {
                    if (!coinRes.status || !coinRes.response || coinRes.response.length === 0) {
                        cleanupTxn(txid); callback(false, "coin not found"); return;
                    }
                    var coin = coinRes.response[0];
                    var ownerStake = getStateVal(coin, 10);
                    var ownerAddr = getStateVal(coin, 1);
                    var counterAddr = getStateVal(coin, 9);
                    var counterStake = (parseFloat(coin.amount) - parseFloat(ownerStake)).toFixed(8);

                    MDS.log("TIMEOUT: ownerStake=" + ownerStake + " counterStake=" + counterStake);

                    // Output 0 (@INPUT): owner gets their stake back
                    MDS.cmd("txnoutput id:" + txid + " amount:" + ownerStake + " address:" + ownerAddr + " storestate:false", function(r2) {
                        if (!r2.status) { cleanupTxn(txid); callback(false, "owner output failed"); return; }

                        // Output 1 (@INPUT+1): counter gets their stake back
                        MDS.cmd("txnoutput id:" + txid + " amount:" + counterStake + " address:" + counterAddr + " storestate:false", function(r3) {
                            if (!r3.status) { cleanupTxn(txid); callback(false, "counter output failed"); return; }

                            // No signature needed for timeout path — @COINAGE check only
                            MDS.cmd("txnbasics id:" + txid + ";txnpost id:" + txid, function(postArr) {
                                releaseTxnLock();
                                var rp = Array.isArray(postArr) ? postArr[postArr.length - 1] : postArr;
                                if (rp && rp.status) {
                                    logActivity("Bet timed out — both sides refunded", "ok");
                                    callback(true, null);
                                } else {
                                    logActivity("Timeout post failed", "err");
                                    callback(false, rp ? rp.error : "post failed");
                                }
                            });
                        });
                    });
                });
            });
        });
    });
}

// -- Collect Expired (Phase 0, @COINAGE GT 1500) --
// Anyone can return expired unmatched bets to their owners.

function collectExpired(coinid, callback) {
    var txid = "collect_" + Date.now();

    MDS.cmd("txncreate id:" + txid, function(r0) {
        if (!r0.status) { callback(false); return; }

        MDS.cmd("txninput id:" + txid + " coinid:" + coinid, function(r1) {
            if (!r1.status) { MDS.cmd("txndelete id:" + txid); callback(false); return; }

            MDS.cmd("coins coinid:" + coinid, function(coinRes) {
                if (!coinRes.status || !coinRes.response || coinRes.response.length === 0) {
                    MDS.cmd("txndelete id:" + txid); callback(false); return;
                }
                var coin = coinRes.response[0];
                var ownerAddr = getStateVal(coin, 1);
                var amt = coin.amount;

                MDS.cmd("txnoutput id:" + txid + " amount:" + amt + " address:" + ownerAddr + " storestate:false", function(r2) {
                    if (!r2.status) { MDS.cmd("txndelete id:" + txid); callback(false); return; }

                    // No signature needed — COINAGE path
                    MDS.cmd("txnbasics id:" + txid + ";txnpost id:" + txid, function(postArr) {
                        var rp = Array.isArray(postArr) ? postArr[postArr.length - 1] : postArr;
                        callback(rp && rp.status);
                    });
                });
            });
        });
    });
}

// -- Refresh On-Chain Bets --
// Scans all coins at script address, categorizes by phase.

function refreshBets(callback) {
    if (!WAGER_SCRIPT_ADDRESS) { if (callback) callback(); return; }

    MDS.cmd("coins address:" + WAGER_SCRIPT_ADDRESS, function(res) {
        if (!res.status) { if (callback) callback(); return; }

        var allCoins = res.response || [];
        OPEN_BETS = [];
        MATCHED_BETS = [];

        allCoins.forEach(function(coin) {
            var phase = parseInt(getStateVal(coin, 4)) || 0;
            var parsed = parseBetCoin(coin);

            if (phase === 0) {
                OPEN_BETS.push(parsed);
            } else if (phase === 1) {
                MATCHED_BETS.push(parsed);
            }
        });

        MDS.log("Refreshed: " + OPEN_BETS.length + " open, " + MATCHED_BETS.length + " matched");
        if (callback) callback();
    });
}

function parseBetCoin(coin) {
    return {
        coinid: coin.coinid,
        amount: coin.amount,
        phase: parseInt(getStateVal(coin, 4)) || 0,
        ownerpk: getStateVal(coin, 0),
        owneraddr: getStateVal(coin, 1),
        arbpk: getStateVal(coin, 2),
        arbaddr: getStateVal(coin, 3),
        timeout: parseInt(getStateVal(coin, 5)) || 5000,
        side: parseInt(getStateVal(coin, 6)),
        wantstake: getStateVal(coin, 7),
        counterpk: getStateVal(coin, 8),
        counteraddr: getStateVal(coin, 9),
        ownerstake: getStateVal(coin, 10),
        isMine: isMyKey(getStateVal(coin, 0)),
        isMyCounter: isMyKey(getStateVal(coin, 8)),
        isMyArb: isMyKey(getStateVal(coin, 2)),
        created: coin.created || "0"
    };
}

// -- Helpers --

function getStateVal(coin, port) {
    if (!coin.state) return "";
    for (var i = 0; i < coin.state.length; i++) {
        if (coin.state[i].port === port) return coin.state[i].data;
    }
    return "";
}

function setTxnState(txid, states, callback) {
    var ports = Object.keys(states);
    var idx = 0;
    function next() {
        if (idx >= ports.length) { callback(true); return; }
        var port = ports[idx++];
        MDS.cmd("txnstate id:" + txid + " port:" + port + " value:" + states[port], function(res) {
            if (!res.status) { callback(false); return; }
            next();
        });
    }
    next();
}

function findCoins(tokenid, minAmount, callback) {
    MDS.cmd("coins relevant:true sendable:true tokenid:" + tokenid, function(res) {
        if (!res.status || !res.response || res.response.length === 0) { callback(null); return; }
        var needed = parseFloat(minAmount);
        var sorted = res.response.slice().sort(function(a, b) { return parseFloat(b.amount) - parseFloat(a.amount); });
        if (parseFloat(sorted[0].amount) >= needed) { callback({ coins: [sorted[0]], total: parseFloat(sorted[0].amount) }); return; }
        var selected = [], sum = 0;
        for (var i = 0; i < sorted.length; i++) {
            selected.push(sorted[i]); sum += parseFloat(sorted[i].amount);
            if (sum >= needed) { callback({ coins: selected, total: sum }); return; }
        }
        callback(null);
    });
}

function addMultipleInputs(txid, coins, idx, callback) {
    if (idx >= coins.length) { callback(true); return; }
    MDS.cmd("txninput id:" + txid + " coinid:" + coins[idx].coinid, function(res) {
        if (!res.status) { callback(false); return; }
        addMultipleInputs(txid, coins, idx + 1, callback);
    });
}

function cleanupTxn(txid) {
    releaseTxnLock();
    MDS.cmd("txndelete id:" + txid);
}

function calcOdds(myStake, counterStake) {
    var total = parseFloat(myStake) + parseFloat(counterStake);
    return (total / parseFloat(myStake)).toFixed(2);
}

function calcCounterOdds(myStake, counterStake) {
    var total = parseFloat(myStake) + parseFloat(counterStake);
    return (total / parseFloat(counterStake)).toFixed(2);
}

// -- Escrow Helpers --
// Locked amount = bet * 1.25. Actual bet = locked / 1.25 = locked * 0.8

function lockedToBet(locked) {
    return parseFloat(locked) / (1 + ESCROW_RATE);
}

function lockedToEscrow(locked) {
    return parseFloat(locked) - lockedToBet(locked);
}

// Self-settle payout calculation:
// Winner gets: both bets + own escrow. Loser gets: own escrow back.
function selfSettlePayouts(pot, ownerLocked, ownerWins) {
    var counterLocked = parseFloat(pot) - parseFloat(ownerLocked);
    var ownerBet = lockedToBet(ownerLocked);
    var counterBet = lockedToBet(counterLocked);
    var ownerEscrow = lockedToEscrow(ownerLocked);
    var counterEscrow = lockedToEscrow(counterLocked);

    if (ownerWins) {
        return {
            winner: ownerBet + counterBet + ownerEscrow,   // both bets + own escrow
            loser: counterEscrow,                            // loser gets escrow back
            winnerAddr: "owner",
            loserAddr: "counter"
        };
    } else {
        return {
            winner: ownerBet + counterBet + counterEscrow,
            loser: ownerEscrow,
            winnerAddr: "counter",
            loserAddr: "owner"
        };
    }
}