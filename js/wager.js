/**
 * Wager V2 — Transaction Builders
 *
 * All transaction construction for the prediction market:
 *   postBet()        — Create a new bet (send to script address)
 *   fillBet()        — Match an existing bet (phase 0→1)
 *   cancelBet()      — Owner cancels unmatched bet (phase 0)
 *   resolveBet()     — Arbiter declares outcome (phase 1)
 *   timeoutBet()     — Refund both sides after arbiter timeout (phase 1)
 *   collectExpired() — Return expired unmatched bets to owner (phase 0)
 *   refreshCoin()    — Spend and recreate coin to reset @COINAGE (keep alive)
 */

// -- Constants --
var ESCROW_RATE = 0.25; // 25% escrow insurance on top of bet
var REFRESH_AGE = 10;   // blocks before refresh (10 for testing, 1200 for production)
var MY_MXKEY = "";      // This node's Maxima public key
var MY_MXNAME = "";     // This node's Maxima name

// -- Hex encode/decode for proposition text (state port 12) --

function strToHex(str) {
    var hex = "0x";
    for (var i = 0; i < str.length; i++) {
        hex += str.charCodeAt(i).toString(16).toUpperCase().padStart(2, "0");
    }
    return hex;
}

function hexToStr(hex) {
    if (!hex) return "";
    if (hex.startsWith("0x")) hex = hex.substring(2);
    var str = "";
    for (var i = 0; i < hex.length; i += 2) {
        str += String.fromCharCode(parseInt(hex.substring(i, i + 2), 16));
    }
    return str;
}

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

function loadMaximaIdentity(callback) {
    getMyMaximaInfo(function(info) {
        if (info) {
            MY_MXKEY = info.mxpublickey;
            MY_MXNAME = info.name;
            MDS.log("Maxima identity: " + MY_MXNAME + " (" + MY_MXKEY.substring(0, 20) + "...)");
        }
        if (callback) callback();
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
            "7": "" + params.wantstake,
            "12": strToHex(params.market || ""),
            "13": "" + (params.settlement || "0")
        });

        var cmd = "send amount:" + params.stake + " address:" + WAGER_SCRIPT_ADDRESS + " state:" + stateObj;

        var sideLabel = params.side === 1 ? "FOR" : "AGAINST";
        notify("Posting " + sideLabel + " bet: " + params.stake + " MINIMA...", "info");

        MDS.cmd(cmd, function(res) {
            releaseTxnLock();
            if (isPending(res)) {
                notify("PENDING — Approve in MiniHub Pending Actions", "pending");
                callback(false, "pending");
                return;
            }
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
                notify("Bet posted — waiting for confirmation", "ok");
                callback(true, null);
            } else {
                var err = res.error || "Failed to post bet";
                notify("Bet failed — " + err, "err");
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
        var ownerStake = bet.amount;
        var counterStake = bet.wantstake;
        if (!counterStake || parseFloat(counterStake) <= 0) {
            releaseTxnLock();
            notify("No wantstake on bet — cannot fill", "err");
            callback(false, "Missing wantstake");
            return;
        }
        var totalPot = (parseFloat(ownerStake) + parseFloat(counterStake)).toFixed(8);

        notify("Step 1/6 — Creating fill transaction...", "info");

        MDS.cmd("txncreate id:" + txid, function(r0) {
            if (!r0.status) { releaseTxnLock(); notify("txncreate failed", "err"); callback(false, "txncreate failed"); return; }

            notify("Step 2/6 — Adding bet coin as input...", "info");
            MDS.cmd("txninput id:" + txid + " coinid:" + bet.coinid, function(r1) {
                if (!r1.status) { cleanupTxn(txid); notify("Bet input failed", "err"); callback(false, "bet input failed"); return; }

                notify("Step 3/6 — Finding " + counterStake + " MINIMA to fund...", "info");
                findCoins("0x00", counterStake, function(result) {
                    if (!result) { cleanupTxn(txid); notify("Insufficient funds (need " + counterStake + " MINIMA)", "err"); callback(false, "Insufficient funds"); return; }

                    addMultipleInputs(txid, result.coins, 0, function(ok) {
                        if (!ok) { cleanupTxn(txid); notify("Funding input failed", "err"); callback(false, "Funding input failed"); return; }

                        notify("Step 4/6 — Building outputs (pot=" + totalPot + ")...", "info");
                        MDS.cmd("txnoutput id:" + txid + " amount:" + totalPot + " address:" + WAGER_SCRIPT_ADDRESS + " storestate:true", function(r2) {
                            if (!r2.status) { cleanupTxn(txid); notify("Pot output failed", "err"); callback(false, "Pot output failed"); return; }

                            var change = (result.total - parseFloat(counterStake)).toFixed(8);
                            var doSign = function() {
                                setFillState(txid, bet, function(stateOk) {
                                    if (!stateOk) { cleanupTxn(txid); notify("State set failed", "err"); callback(false, "State set failed"); return; }

                                    notify("Step 5/6 — Signing transaction...", "info");
                                    MDS.cmd("txnsign id:" + txid + " publickey:auto", function(signRes) {
                                        if (isPending(signRes)) {
                                            releaseTxnLock();
                                            handlePending(txid, callback);
                                            return;
                                        }
                                        if (!signRes || !signRes.status) {
                                            releaseTxnLock();
                                            var serr = signRes ? signRes.error || "sign failed" : "no response";
                                            notify("Sign failed — " + serr, "err");
                                            MDS.cmd("txndelete id:" + txid);
                                            callback(false, serr);
                                            return;
                                        }

                                        notify("Step 6/6 — Posting to network...", "info");
                                        MDS.cmd("txnbasics id:" + txid, function(br) {
                                            if (!br || !br.status) {
                                                releaseTxnLock();
                                                notify("txnbasics failed: " + (br ? br.error : ""), "err");
                                                MDS.cmd("txndelete id:" + txid);
                                                callback(false, "txnbasics failed");
                                                return;
                                            }
                                            MDS.cmd("txnpost id:" + txid, function(pr) {
                                                releaseTxnLock();
                                                MDS.cmd("txndelete id:" + txid);
                                                if (pr && pr.status) {
                                                    notify("Bet matched! Waiting for confirmation...", "ok");
                                                    callback(true, null);
                                                } else {
                                                    notify("Post failed — " + (pr ? pr.error || "unknown" : "no response"), "err");
                                                    callback(false, pr ? pr.error : "post failed");
                                                }
                                            });
                                        });
                                    });
                                });
                            };

                            if (parseFloat(change) > 0.000001) {
                                MDS.cmd("txnoutput id:" + txid + " amount:" + change + " address:" + MY_HEX_ADDR + " storestate:false", function(r3) {
                                    if (!r3.status) { cleanupTxn(txid); notify("Change output failed", "err"); callback(false, "Change output failed"); return; }
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
    // Use parsed properties — preserving raw hex for port 12 to avoid case mismatch
    var states = {
        0: bet.ownerpk,                 // ownerpk
        1: bet.owneraddr,               // owneraddr
        2: bet.arbpk,                   // arbpk
        3: bet.arbaddr,                 // arbaddr
        4: "1",                          // phase → 1 (matched)
        5: "" + bet.timeout,             // timeout
        6: "" + bet.side,                // side
        7: bet.wantstake,               // wantstake
        8: MY_PUBKEY,                    // counterpk
        9: MY_HEX_ADDR,                 // counteraddr
        10: ownerStake,                  // ownerstake (= @AMOUNT at fill time)
        12: bet.propositionHex || strToHex(bet.proposition || ""), // raw hex preserved
        13: bet.settlement || "0"        // settlement block
    };
    setTxnState(txid, states, callback);
}

// -- Cancel Bet (Phase 0) --
// Owner reclaims unmatched bet. SIGNEDBY(owner) path.

function cancelBet(coinid, callback) {
    acquireTxnLock(function() {
        var txid = "cancel_" + Date.now();
        notify("Cancelling bet...", "info");

        MDS.cmd("txncreate id:" + txid, function(r0) {
            if (!r0.status) { releaseTxnLock(); notify("txncreate failed", "err"); callback(false, "txncreate failed"); return; }

            MDS.cmd("txninput id:" + txid + " coinid:" + coinid, function(r1) {
                if (!r1.status) { cleanupTxn(txid); notify("Input failed", "err"); callback(false, "input failed"); return; }

                MDS.cmd("coins coinid:" + coinid, function(coinRes) {
                    if (!coinRes.status || !coinRes.response || coinRes.response.length === 0) {
                        cleanupTxn(txid); notify("Coin not found", "err"); callback(false, "coin not found"); return;
                    }
                    var coin = coinRes.response[0];
                    var ownerAddr = getStateVal(coin, 1);
                    var amt = coin.amount;

                    MDS.cmd("txnoutput id:" + txid + " amount:" + amt + " address:" + ownerAddr + " storestate:false", function(r2) {
                        if (!r2.status) { cleanupTxn(txid); notify("Output failed", "err"); callback(false, "output failed"); return; }

                        notify("Signing cancel...", "info");
                        MDS.cmd("txnsign id:" + txid + " publickey:" + getStateVal(coin, 0), function(signRes) {
                            if (isPending(signRes)) {
                                releaseTxnLock();
                                handlePending(txid, callback);
                                return;
                            }
                            if (signRes && signRes.status) {
                                MDS.cmd("txnbasics id:" + txid, function(br) {
                                    if (!br || !br.status) {
                                        releaseTxnLock(); notify("txnbasics failed", "err");
                                        MDS.cmd("txndelete id:" + txid); callback(false, "txnbasics failed"); return;
                                    }
                                    MDS.cmd("txnpost id:" + txid, function(pr) {
                                        releaseTxnLock();
                                        MDS.cmd("txndelete id:" + txid);
                                        if (pr && pr.status) {
                                            notify("Bet cancelled", "ok");
                                            callback(true, null);
                                        } else {
                                            notify("Cancel post failed", "err");
                                            callback(false, pr ? pr.error : "post failed");
                                        }
                                    });
                                });
                            } else {
                                releaseTxnLock();
                                notify("Cancel sign failed", "err");
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
// Params: coinid, outcome (1=TRUE/FOR, 0=FALSE/AGAINST), callback(success, error)

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
                        notify("Signing settlement proposal...", "info");
                        MDS.cmd("txnsign id:" + txid + " publickey:auto", function(signRes) {
                            if (isPending(signRes)) {
                                releaseTxnLock();
                                handlePending(txid, callback);
                                return;
                            }
                            if (signRes && signRes.status) {
                                MDS.cmd("txnexport id:" + txid, function(expRes) {
                                    releaseTxnLock();
                                    if (expRes && expRes.status) {
                                        notify("Settlement signed — needs counter-party signature", "warn");
                                        callback(true, null, expRes.response.data);
                                    } else {
                                        notify("Export failed", "err");
                                        MDS.cmd("txndelete id:" + txid);
                                        callback(false, "export failed");
                                    }
                                });
                            } else {
                                releaseTxnLock();
                                notify("Sign failed", "err");
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
    notify("Importing settlement transaction...", "info");
    MDS.cmd("txnimport id:" + txid + " data:" + txnHex, function(r1) {
        if (!r1 || !r1.status) { notify("Import failed", "err"); callback(false, "import failed"); return; }
        notify("Co-signing...", "info");
        MDS.cmd("txnsign id:" + txid + " publickey:auto", function(r2) {
            if (isPending(r2)) {
                handlePending(txid, callback);
                return;
            }
            if (!r2 || !r2.status) { notify("Co-sign failed", "err"); MDS.cmd("txndelete id:" + txid); callback(false, "cosign failed"); return; }
            notify("Posting settlement...", "info");
            MDS.cmd("txnbasics id:" + txid, function(br) {
                if (!br || !br.status) {
                    notify("txnbasics failed", "err");
                    MDS.cmd("txndelete id:" + txid);
                    callback(false, "txnbasics failed");
                    return;
                }
                MDS.cmd("txnpost id:" + txid, function(pr) {
                    MDS.cmd("txndelete id:" + txid);
                    if (pr && pr.status) {
                        notify("Settled — 0% fee!", "ok");
                        callback(true, null);
                    } else {
                        notify("Settlement post failed", "err");
                        callback(false, pr ? pr.error : "post failed");
                    }
                });
            });
        });
    });
}

// -- Resolve Bet (Phase 1) --
// Arbiter declares outcome. 10% of winner's profit as fee.
// Params: coinid, outcome (1=TRUE/FOR wins, 0=FALSE/AGAINST wins, 2=VOID), callback(success, error)

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

                    // TRUE or FALSE wins: 10% of profit as fee
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
                                var label = outcome === 1 ? "TRUE wins" : "FALSE wins";
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
    notify("Signing as arbiter...", "info");
    MDS.cmd("txnsign id:" + txid + " publickey:" + arbPk, function(signRes) {
        if (isPending(signRes)) {
            releaseTxnLock();
            handlePending(txid, callback);
            return;
        }
        if (signRes && signRes.status) {
            notify("Posting resolve — " + label + "...", "info");
            MDS.cmd("txnbasics id:" + txid, function(br) {
                if (!br || !br.status) {
                    releaseTxnLock();
                    notify("txnbasics failed", "err");
                    MDS.cmd("txndelete id:" + txid);
                    callback(false, "txnbasics failed");
                    return;
                }
                MDS.cmd("txnpost id:" + txid, function(pr) {
                    releaseTxnLock();
                    MDS.cmd("txndelete id:" + txid);
                    if (pr && pr.status) {
                        notify("Bet resolved — " + label + "!", "ok");
                        callback(true, null);
                    } else {
                        notify("Resolve post failed", "err");
                        callback(false, pr ? pr.error : "post failed");
                    }
                });
            });
        } else {
            releaseTxnLock();
            notify("Resolve sign failed", "err");
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
        notify("Building timeout refund...", "info");

        MDS.cmd("txncreate id:" + txid, function(r0) {
            if (!r0.status) { releaseTxnLock(); notify("txncreate failed", "err"); callback(false, "txncreate failed"); return; }

            MDS.cmd("txninput id:" + txid + " coinid:" + coinid, function(r1) {
                if (!r1.status) { cleanupTxn(txid); notify("Input failed", "err"); callback(false, "input failed"); return; }

                MDS.cmd("coins coinid:" + coinid, function(coinRes) {
                    if (!coinRes.status || !coinRes.response || coinRes.response.length === 0) {
                        cleanupTxn(txid); notify("Coin not found", "err"); callback(false, "coin not found"); return;
                    }
                    var coin = coinRes.response[0];
                    var ownerStake = getStateVal(coin, 10);
                    var ownerAddr = getStateVal(coin, 1);
                    var counterAddr = getStateVal(coin, 9);
                    var counterStake = (parseFloat(coin.amount) - parseFloat(ownerStake)).toFixed(8);

                    MDS.cmd("txnoutput id:" + txid + " amount:" + ownerStake + " address:" + ownerAddr + " storestate:false", function(r2) {
                        if (!r2.status) { cleanupTxn(txid); notify("Owner output failed", "err"); callback(false, "owner output failed"); return; }

                        MDS.cmd("txnoutput id:" + txid + " amount:" + counterStake + " address:" + counterAddr + " storestate:false", function(r3) {
                            if (!r3.status) { cleanupTxn(txid); notify("Counter output failed", "err"); callback(false, "counter output failed"); return; }

                            notify("Posting timeout refund...", "info");
                            MDS.cmd("txnbasics id:" + txid, function(br) {
                                if (!br || !br.status) {
                                    releaseTxnLock(); notify("txnbasics failed", "err");
                                    MDS.cmd("txndelete id:" + txid); callback(false, "txnbasics failed"); return;
                                }
                                MDS.cmd("txnpost id:" + txid, function(pr) {
                                    releaseTxnLock();
                                    MDS.cmd("txndelete id:" + txid);
                                    if (pr && pr.status) {
                                        notify("Bet timed out — both sides refunded", "ok");
                                        callback(true, null);
                                    } else {
                                        notify("Timeout post failed", "err");
                                        callback(false, pr ? pr.error : "post failed");
                                    }
                                });
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

                    MDS.cmd("txnbasics id:" + txid, function(br) {
                        if (!br || !br.status) { MDS.cmd("txndelete id:" + txid); callback(false); return; }
                        MDS.cmd("txnpost id:" + txid, function(pr) {
                            MDS.cmd("txndelete id:" + txid);
                            callback(pr && pr.status);
                        });
                    });
                });
            });
        });
    });
}

// -- Refresh Coin (keep alive across cascade) --
// Spends and recreates coin at same address with identical state. Resets @COINAGE.
// Phase 0: owner signs. Phase 1: owner OR counter signs.
// STATE(14) = 1 tells the contract this is a refresh, not a cancel.

function refreshCoin(coin, callback) {
    var txid = "refresh_" + Date.now();
    var phase = getStateVal(coin, 4);
    var sigKey = null;

    // Find a key we own that can sign
    if (isMyKey(getStateVal(coin, 0))) {
        sigKey = getStateVal(coin, 0); // owner
    } else if (phase === "1" && isMyKey(getStateVal(coin, 8))) {
        sigKey = getStateVal(coin, 8); // counter
    }
    if (!sigKey) {
        MDS.log("Refresh: no signing key for coin " + coin.coinid.substring(0, 20));
        if (callback) callback(false);
        return;
    }

    MDS.log("Refreshing coin " + coin.coinid.substring(0, 20) + "... age=" + (coin.age || "?"));
    notify("Refreshing bet (age " + (coin.age || "?") + " blocks)...", "info");

    MDS.cmd("txncreate id:" + txid, function(r0) {
        if (!r0.status) { MDS.log("Refresh txncreate failed"); if (callback) callback(false); return; }

        MDS.cmd("txninput id:" + txid + " coinid:" + coin.coinid, function(r1) {
            if (!r1.status) { MDS.cmd("txndelete id:" + txid); if (callback) callback(false); return; }

            // Output: same amount, same address, storestate:true
            MDS.cmd("txnoutput id:" + txid + " amount:" + coin.amount + " address:" + WAGER_SCRIPT_ADDRESS + " storestate:true", function(r2) {
                if (!r2.status) { MDS.cmd("txndelete id:" + txid); if (callback) callback(false); return; }

                // Copy all state ports from the coin + set port 14 = 1 (refresh flag)
                var states = {};
                coin.state.forEach(function(s) { states[s.port] = s.data; });
                states[14] = "1"; // refresh flag

                setTxnState(txid, states, function(stateOk) {
                    if (!stateOk) { MDS.cmd("txndelete id:" + txid); if (callback) callback(false); return; }

                    MDS.cmd("txnsign id:" + txid + " publickey:" + sigKey, function(sr) {
                        if (!sr || !sr.status) {
                            MDS.log("Refresh sign failed");
                            MDS.cmd("txndelete id:" + txid);
                            if (callback) callback(false);
                            return;
                        }

                        MDS.cmd("txnbasics id:" + txid, function(br) {
                            if (!br || !br.status) {
                                MDS.log("Refresh basics failed");
                                MDS.cmd("txndelete id:" + txid);
                                if (callback) callback(false);
                                return;
                            }

                            MDS.cmd("txnpost id:" + txid, function(pr) {
                                MDS.cmd("txndelete id:" + txid);
                                if (pr && pr.status) {
                                    notify("Bet refreshed — coin age reset", "ok");
                                    MDS.log("Refreshed coin " + coin.coinid.substring(0, 20));
                                    if (callback) callback(true);
                                } else {
                                    MDS.log("Refresh post failed: " + (pr ? pr.error : ""));
                                    notify("Refresh failed", "err");
                                    if (callback) callback(false);
                                }
                            });
                        });
                    });
                });
            });
        });
    });
}

// Scan all contract coins and refresh any that are getting stale
function refreshStaleCoins(callback) {
    if (!WAGER_SCRIPT_ADDRESS) { if (callback) callback(); return; }

    MDS.cmd("coins address:" + WAGER_SCRIPT_ADDRESS, function(res) {
        if (!res.status || !res.response) { if (callback) callback(); return; }

        var stale = [];
        res.response.forEach(function(coin) {
            var age = parseInt(coin.age) || 0;
            if (age >= REFRESH_AGE && parseFloat(coin.amount) > 0.001) {
                var phase = getStateVal(coin, 4);
                var canSign = isMyKey(getStateVal(coin, 0));
                if (phase === "1") canSign = canSign || isMyKey(getStateVal(coin, 8));
                if (canSign) stale.push(coin);
            }
        });

        if (stale.length === 0) { if (callback) callback(); return; }

        MDS.log("Found " + stale.length + " stale coin(s) to refresh");
        notify("Refreshing " + stale.length + " stale bet(s)...", "info");

        // Refresh one at a time to avoid conflicts
        var idx = 0;
        function next() {
            if (idx >= stale.length) { if (callback) callback(); return; }
            refreshCoin(stale[idx], function() {
                idx++;
                setTimeout(next, 2000); // pause between refreshes
            });
        }
        next();
    });
}

// -- Load On-Chain Bets --
// Scans all coins at script address, categorizes by phase.

function refreshBets(callback) {
    if (!WAGER_SCRIPT_ADDRESS) { if (callback) callback(); return; }

    MDS.cmd("coins address:" + WAGER_SCRIPT_ADDRESS, function(res) {
        if (!res.status) { if (callback) callback(); return; }

        var allCoins = res.response || [];
        OPEN_BETS = [];
        MATCHED_BETS = [];

        allCoins.forEach(function(coin) {
            if (coin.spent) return;
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
        proposition: hexToStr(getStateVal(coin, 12)),
        propositionHex: getStateVal(coin, 12),
        settlement: getStateVal(coin, 13),
        isMine: isMyKey(getStateVal(coin, 0)),
        isMyCounter: isMyKey(getStateVal(coin, 8)),
        isMyArb: isMyKey(getStateVal(coin, 2)),
        created: coin.created || "0",
        age: parseInt(coin.age) || 0
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
    MDS.cmd("coins sendable:true tokenid:" + tokenid, function(res) {
        if (!res.status || !res.response || res.response.length === 0) {
            notify("No sendable coins found (need " + minAmount + ")", "err");
            callback(null);
            return;
        }
        var needed = parseFloat(minAmount);
        var available = res.response.filter(function(c) { return parseFloat(c.amount) > 0; });
        var total = 0;
        available.forEach(function(c) { total += parseFloat(c.amount); });
        notify("Found " + available.length + " coins, total " + total.toFixed(4) + " (need " + needed.toFixed(4) + ")", "info");
        if (total < needed) { callback(null); return; }

        var sorted = available.sort(function(a, b) { return parseFloat(b.amount) - parseFloat(a.amount); });
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

// Odds as simplified whole number ratio want:bet — "20 wants 10" = 1:2, "30 wants 90" = 3:1
function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }
function calcOdds(betAmt, wantAmt) {
    var b = Math.round(parseFloat(betAmt) * 100);
    var w = Math.round(parseFloat(wantAmt) * 100);
    if (b <= 0 || w <= 0) return "—";
    var g = gcd(w, b);
    return (w / g) + ':' + (b / g);
}

function calcCounterOdds(betAmt, wantAmt) {
    return calcOdds(wantAmt, betAmt);
}

// -- ChainMail Messaging --

function notifyArbiter(betid, arbMxKey, market, stake, callback) {
    if (!arbMxKey) { if (callback) callback(false); return; }
    sendChainMail(arbMxKey, {
        type: "BET_CREATED",
        betid: betid,
        market: market,
        stake: stake,
        sender_name: MY_MXNAME,
        sender_mxkey: MY_MXKEY
    }, function(ok) { if (callback) callback(ok); });
}

function notifyBetMatched(betid, pot, ownerMxKey, arbMxKey, callback) {
    var payload = {
        type: "BET_MATCHED",
        betid: betid,
        pot: pot,
        counter_mxkey: MY_MXKEY,
        owner_mxkey: ownerMxKey,
        sender_name: MY_MXNAME
    };
    var sent = 0, total = 0;
    function done() { sent++; if (sent >= total && callback) callback(true); }

    if (ownerMxKey) { total++; sendChainMail(ownerMxKey, payload, done); }
    if (arbMxKey) { total++; sendChainMail(arbMxKey, payload, done); }
    if (total === 0 && callback) callback(true);
}

function sendSettlePropose(counterMxKey, betid, outcome, txnHex, callback) {
    if (!counterMxKey) { if (callback) callback(false, "No counter Mx key"); return; }
    sendChainMail(counterMxKey, {
        type: "SETTLE_PROPOSE",
        betid: betid,
        outcome: outcome,
        txnhex: txnHex,
        sender_name: MY_MXNAME,
        sender_mxkey: MY_MXKEY
    }, function(ok, err) { if (callback) callback(ok, err); });
}

function sendSettleAccept(proposerMxKey, betid, callback) {
    if (!proposerMxKey) { if (callback) callback(false); return; }
    sendChainMail(proposerMxKey, {
        type: "SETTLE_ACCEPT",
        betid: betid,
        sender_name: MY_MXNAME
    }, function(ok) { if (callback) callback(ok); });
}

function sendSettleReject(proposerMxKey, arbMxKey, betid, callback) {
    var payload = {
        type: "SETTLE_REJECT",
        betid: betid,
        sender_name: MY_MXNAME
    };
    if (proposerMxKey) sendChainMail(proposerMxKey, payload);

    // Also notify arbiter of dispute
    if (arbMxKey) {
        sendChainMail(arbMxKey, {
            type: "DISPUTE",
            betid: betid,
            sender_name: MY_MXNAME,
            sender_mxkey: MY_MXKEY
        }, function(ok) { if (callback) callback(ok); });
    } else {
        if (callback) callback(true);
    }
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