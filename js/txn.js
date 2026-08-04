/**
 * ============================================================================
 * WAGER — Transaction Builders Module
 * ============================================================================
 *
 * PURPOSE:
 *   All on-chain transaction construction for the prediction market.
 *   Each function builds a Minima transaction with the correct inputs,
 *   outputs, state variables, and signatures, then posts to the network.
 *
 * TRANSACTION BUILDERS:
 *   postBet(params, cb)              — Create a new bet (send to script address)
 *   fillBet(bet, cb)                 — Match an existing bet (phase 0→1)
 *   cancelBet(coinid, cb)            — Owner cancels unmatched bet (phase 0)
 *   selfSettle(coinid, outcome, cb)  — Build partially-signed settlement (both sign)
 *   cosignAndPost(txnHex, sigKey, cb)— Co-sign imported tx and post
 *   resolveBet(coinid, outcome, cb)  — Arbiter declares outcome (10% fee)
 *   timeoutBet(coinid, cb)           — Refund both after timeout (MAST path)
 *   collectExpired(coinid, cb)       — Return expired open bets to owner
 *
 * HELPERS:
 *   generateBetId()                  — Unique hex ID for bet DB records
 *   setFillState(txid, bet, cb)      — Set all state ports for fill transaction
 *   setTxnState(txid, states, cb)    — Set multiple state ports sequentially
 *   findCoins(tokenid, amount, cb)   — Find sendable coins totaling >= amount
 *   addMultipleInputs(txid, coins, idx, cb) — Add array of coins as inputs
 *   findCoinByIdOnChain(coinid, cb)  — Find coin by ID at contract address
 *   cleanupTxn(txid)                 — Release lock + delete transaction
 *
 * MATH:
 *   calcOdds(bet, want)              — Simplified ratio (e.g. "2:1")
 *   calcCounterOdds(bet, want)       — Inverse odds
 *   gcd(a, b)                        — Greatest common divisor
 *
 * CHAINMAIL NOTIFICATION WRAPPERS:
 *   notifyArbiter(...)               — BET_CREATED to arbiter
 *   notifyBetMatched(...)            — BET_MATCHED to owner + arbiter
 *   sendSettlePropose(...)           — SETTLE_PROPOSE to counterparty
 *   sendSettleAccept(...)            — SETTLE_ACCEPT to proposer
 *   sendSettleReject(...)            — SETTLE_REJECT to proposer + DISPUTE to arbiter
 *
 * TRANSACTION PATTERNS (from minima-tx skill):
 *   Standard: txncreate → txninput → txnoutput → txnstate → txnsign → txnbasics → txnpost
 *   Self-settle proposer: txncreate → txninput → txnoutput → txnstate → txnsign → txnexport (NO basics)
 *   Self-settle co-signer: txnimport → txnsign → txnbasics → txnpost (basics ONCE, by last signer)
 *
 * SECURITY NOTES:
 *   - ALL transactions set STATE(14)=0. The KISS VM crashes on unset STATE ports.
 *   - Self-settle signs with the SPECIFIC key from coin state (port 0 or 8),
 *     never publickey:auto. auto doesn't find the right key for script addresses.
 *   - fillBet fetches the coin FRESH before building the tx to handle stale coinids.
 *   - cosignAndPost calls txnbasics exactly once (the co-signer's responsibility).
 *   - txndelete is called on ALL error paths to prevent locking input coins.
 *   - The escrow math: each side locks bet × 1.25. Escrow = lock / 5.
 *     Self-settle: winner gets pot - loserEscrow, loser gets loserEscrow back.
 *     Arbiter: winner gets 90%, arbiter gets 10%, loser gets nothing.
 *     Void: each gets their lock back, 0% fee.
 *
 * DEPENDENCIES:
 *   - identity.js (MY_PUBKEY, MY_HEX_ADDR, MY_MXKEY, MY_MXNAME, isMyKey, strToHex)
 *   - state.js (ESCROW_RATE, REFRESH_AGE, getStateVal, parseBetCoin, OPEN_BETS)
 *   - contract.js (WAGER_SCRIPT_ADDRESS, MAST_*_SCRIPT, MAST_*_PROOF)
 *   - chainmail.js (sendChainMail)
 *   - db.js (insertBet, logTx, insertMessage)
 *
 * LOADED BY:
 *   - index.html (browser context, after state.js)
 *   - service.js via MDS.load (background context, for refreshCoin reuse - future)
 * ============================================================================
 */


// ============================================================================
// TRANSACTION LOCK — Serializes on-chain operations
// ============================================================================

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

// ============================================================================
// TRANSACTION BUILDERS
// ============================================================================

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
            "13": "" + (params.settlement || "0"),
            "15": strToHex(MY_MXKEY || ""),
            "17": strToHex(params.arbitermxkey || "")
        });

        var cmd = "send amount:" + params.stake + " address:" + WAGER_SCRIPT_ADDRESS + " state:" + stateObj;

        var sideLabel = params.side === 1 ? "TRUE" : "FALSE";
        var betOnly = (parseFloat(params.stake) / (1 + ESCROW_RATE)).toFixed(2);
        var escrowAmt = (parseFloat(params.stake) - parseFloat(betOnly)).toFixed(2);
        notify("Posting " + sideLabel + ": " + betOnly + " + " + escrowAmt + " honesty escrow = " + parseFloat(params.stake).toFixed(2) + " MINIMA locked", "info");

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
                    ownermxkey: MY_MXKEY,
                    phase: 0,
                    timeout: params.timeout,
                    myrole: "owner",
                    status: "OPEN"
                });
                notify("Bet submitted — waiting for on-chain confirmation (~2 min)...", "info");
                logTx("POST", params.stake, "OUT", params.market, (params.side === 1 ? "FOR" : "AGAINST") + " wants " + params.wantstake);
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

        // Fetch coin FRESH to avoid stale coinid (auto-refresh changes coinid)
        notify("Step 1/6 — Verifying bet coin...", "info");
        findCoinByIdOnChain(bet.coinid, function(freshCoin) {
            if (!freshCoin) {
                // Coinid changed — try to find by proposition
                MDS.cmd("coins address:" + WAGER_SCRIPT_ADDRESS, function(cres) {
                    var found = null;
                    if (cres.status && cres.response) {
                        cres.response.forEach(function(c) {
                            if (c.spent) return;
                            var p = getStateVal(c, 4);
                            if (p !== "0") return;
                            var prop = hexToStr(getStateVal(c, 12));
                            if (prop === bet.proposition && getStateVal(c, 6) === "" + bet.side) found = c;
                        });
                    }
                    if (found) {
                        bet = parseBetCoin(found);
                        doFillWithBet();
                    } else {
                        releaseTxnLock(); notify("Bet coin not found — may have been refreshed or taken", "err");
                        callback(false, "coin not found"); return;
                    }
                });
            } else {
                doFillWithBet();
            }
        });

        function doFillWithBet() {
        var ownerStake = bet.amount;
        var counterStake = bet.wantstake;
        if (!counterStake || parseFloat(counterStake) <= 0) {
            releaseTxnLock();
            notify("No wantstake on bet — cannot fill", "err");
            callback(false, "Missing wantstake");
            return;
        }
        var totalPot = (parseFloat(ownerStake) + parseFloat(counterStake)).toFixed(8);

        notify("Step 2/6 — Creating fill transaction...", "info");

        MDS.cmd("txncreate id:" + txid, function(r0) {
            if (!r0.status) { releaseTxnLock(); notify("txncreate failed", "err"); callback(false, "txncreate failed"); return; }

            notify("Step 3/6 — Adding bet coin as input...", "info");
            MDS.cmd("txninput id:" + txid + " coinid:" + bet.coinid, function(r1) {
                if (!r1.status) { cleanupTxn(txid); notify("Bet input failed", "err"); callback(false, "bet input failed"); return; }

                notify("Step 4/7 — Finding " + counterStake + " MINIMA to fund...", "info");
                findCoins("0x00", counterStake, function(result) {
                    if (!result) { cleanupTxn(txid); notify("Insufficient funds (need " + counterStake + " MINIMA)", "err"); callback(false, "Insufficient funds"); return; }

                    addMultipleInputs(txid, result.coins, 0, function(ok) {
                        if (!ok) { cleanupTxn(txid); notify("Funding input failed", "err"); callback(false, "Funding input failed"); return; }

                        notify("Step 5/7 — Building outputs (pot=" + totalPot + ")...", "info");
                        MDS.cmd("txnoutput id:" + txid + " amount:" + totalPot + " address:" + WAGER_SCRIPT_ADDRESS + " storestate:true", function(r2) {
                            if (!r2.status) { cleanupTxn(txid); notify("Pot output failed", "err"); callback(false, "Pot output failed"); return; }

                            var change = (result.total - parseFloat(counterStake)).toFixed(8);
                            var doSign = function() {
                                setFillState(txid, bet, function(stateOk) {
                                    if (!stateOk) { cleanupTxn(txid); notify("State set failed", "err"); callback(false, "State set failed"); return; }

                                    notify("Step 6/7 — Signing transaction...", "info");
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

                                        notify("Step 7/7 — Posting to network...", "info");
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
                                                    var myBetOnly = (parseFloat(counterStake) / (1 + ESCROW_RATE)).toFixed(2);
                                                    var myEscrow = (parseFloat(counterStake) - parseFloat(myBetOnly)).toFixed(2);
                                                    var mySide = bet.side === 1 ? "FALSE" : "TRUE";
                                                    notify("Filled " + mySide + ": " + myBetOnly + " + " + myEscrow + " escrow = " + parseFloat(counterStake).toFixed(2) + " locked. Confirming on-chain (1-3 blocks).", "pending");
                                                    logTx("FILL", counterStake, "OUT", bet.proposition || "", "Matched bet — pot " + totalPot);
                                                    // Store filler's bet record in DB (critical for MxKey delivery)
                                                    insertBet({
                                                        betid: bet.coinid,
                                                        market: bet.proposition || "",
                                                        arbpk: bet.arbpk || "", arbaddr: bet.arbaddr || "",
                                                        side: bet.side === 1 ? 0 : 1,
                                                        ownerstake: bet.amount,
                                                        counterstake: counterStake,
                                                        ownerpk: bet.ownerpk, owneraddr: bet.owneraddr,
                                                        ownermxkey: bet.ownermxkey || "",
                                                        counterpk: MY_PUBKEY, counteraddr: MY_HEX_ADDR,
                                                        countermxkey: MY_MXKEY,
                                                        phase: 1, timeout: bet.timeout || 5000,
                                                        myrole: "counter", status: "MATCHED"
                                                    });
                                                    // Notify owner + arbiter via ChainMail
                                                    var ownerMx = bet.ownermxkey || "";
                                                    var arbMx = bet.arbitermxkey || "";
                                                    if (ownerMx || arbMx) {
                                                        notifyBetMatched(bet.coinid, totalPot, ownerMx, arbMx, bet.proposition || "");
                                                    }
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
    } // doFillWithBet
    }); // acquireTxnLock
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
        13: bet.settlement || "0",       // settlement block
        14: "0",                         // refresh flag (must be set — Java VM crashes on unset STATE)
        15: bet.ownermxkey || "",         // owner's Maxima key (for ChainMail)
        16: strToHex(MY_MXKEY || ""),     // counter's Maxima key (hex-encoded, for ChainMail)
        17: bet.arbitermxkeyHex || ""     // arbiter's Maxima key (preserved from post)
    };
    setTxnState(txid, states, callback);
}

// -- Cancel Bet (Phase 0) --
// Owner reclaims unmatched bet. SIGNEDBY(owner) path.

function cancelBet(coinid, callback) {
    acquireTxnLock(function() {
        var txid = "cancel_" + Date.now();
        notify("Cancelling bet...", "info");

        // Fetch coin FIRST to verify it still exists (auto-refresh may have changed coinid)
        findCoinByIdOnChain(coinid, function(coin) {
            if (!coin) {
                // Coinid changed — try to find by proposition in OPEN_BETS
                var bet = OPEN_BETS ? OPEN_BETS.find(function(b) { return b.coinid === coinid; }) : null;
                if (!bet) {
                    releaseTxnLock(); notify("Coin not found — may have been refreshed", "err"); callback(false, "coin not found"); return;
                }
            }
            var actualCoinid = coin ? coin.coinid : coinid;
            var ownerAddr = coin ? getStateVal(coin, 1) : (bet ? bet.owneraddr : "");
            var amt = coin ? coin.amount : (bet ? bet.amount : "0");

        MDS.cmd("txncreate id:" + txid, function(r0) {
            if (!r0.status) { releaseTxnLock(); notify("txncreate failed", "err"); callback(false, "txncreate failed"); return; }

            MDS.cmd("txninput id:" + txid + " coinid:" + actualCoinid, function(r1) {
                if (!r1.status) { cleanupTxn(txid); notify("Input failed — coin may have been refreshed", "err"); callback(false, "input failed"); return; }

                    MDS.cmd("txnoutput id:" + txid + " amount:" + amt + " address:" + ownerAddr + " storestate:false", function(r2) {
                        if (!r2.status) { cleanupTxn(txid); notify("Output failed", "err"); callback(false, "output failed"); return; }

                        notify("Signing cancel...", "info");
                        var sigKey = coin ? getStateVal(coin, 0) : "auto";
                        MDS.cmd("txnsign id:" + txid + " publickey:" + sigKey, function(signRes) {
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
        }); // findCoinByIdOnChain
    }); // acquireTxnLock
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

                findCoinByIdOnChain(coinid, function(coin) {
                    if (!coin) {
                        cleanupTxn(txid); callback(false, "coin not found"); return;
                    }
                    var totalPot = parseFloat(coin.amount);
                    var ownerSide = parseInt(getStateVal(coin, 6));
                    var ownerAddr = getStateVal(coin, 1);
                    var counterAddr = getStateVal(coin, 9);

                    var ownerLock = parseFloat(getStateVal(coin, 10));
                    var counterLock = totalPot - ownerLock;
                    var isVoid = (outcome === 2);

                    var out0Addr, out0Amt, out1Addr, out1Amt;
                    if (isVoid) {
                        // Void: each side gets their lock back, 0% fee
                        out0Addr = ownerAddr;  out0Amt = ownerLock.toFixed(8);
                        out1Addr = counterAddr; out1Amt = counterLock.toFixed(8);
                    } else {
                        // Win/lose: winner gets pot - loser's escrow, loser gets escrow back
                        var ownerWins = (outcome === ownerSide);
                        var loserLock = ownerWins ? counterLock : ownerLock;
                        var loserEscrow = Math.floor((loserLock / 5) * 1e8) / 1e8;
                        out0Addr = ownerWins ? ownerAddr : counterAddr;
                        out0Amt = (totalPot - loserEscrow).toFixed(8);
                        out1Addr = ownerWins ? counterAddr : ownerAddr;
                        out1Amt = loserEscrow.toFixed(8);
                    }

                    // Output 0
                    MDS.cmd("txnoutput id:" + txid + " amount:" + out0Amt + " address:" + out0Addr + " storestate:false", function(r2) {
                        if (!r2.status) { cleanupTxn(txid); callback(false, "output 0 failed"); return; }

                    // Output 1
                    MDS.cmd("txnoutput id:" + txid + " amount:" + out1Amt + " address:" + out1Addr + " storestate:false", function(r2b) {
                        if (!r2b.status) { cleanupTxn(txid); callback(false, "output 1 failed"); return; }

                        // STATE(11)=outcome (required by contract VERIFYOUT) + STATE(14)=0
                        MDS.cmd("txnstate id:" + txid + " port:11 value:" + outcome, function() {
                        MDS.cmd("txnstate id:" + txid + " port:14 value:0", function() {

                        // Void (outcome=2) uses MAST leaf — attach proof
                        function afterMastVoid() {

                        // Sign with our SPECIFIC key — NO txnbasics here (co-signer does it once before post)
                        var myKey = isMyKey(getStateVal(coin, 0)) ? getStateVal(coin, 0) : getStateVal(coin, 8);
                        if (!isMyKey(myKey)) { MDS.log("WARNING: neither owner nor counter key is ours"); }
                        notify("Signing settlement proposal...", "info");
                        MDS.cmd("txnsign id:" + txid + " publickey:" + myKey, function(signRes) {
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
                    } // afterMastVoid

                    if (isVoid) {
                        var ms = {}; ms[MAST_VOID_SCRIPT] = MAST_VOID_PROOF;
                        MDS.cmd("txnscript id:" + txid + " scripts:" + JSON.stringify(ms), function(mr) {
                            if (!mr || !mr.status) { cleanupTxn(txid); callback(false, "MAST void proof failed"); return; }
                            afterMastVoid();
                        });
                    } else {
                        afterMastVoid();
                    }

                    }); // txnstate port:14
                    }); // txnstate port:11
                    }); // txnoutput 1
                    });
                });
            });
        });
    });
}

// Co-sign and post a self-settle transaction (called by the counter-party)
// sigKey = the specific public key this node must sign with (port 0 or 8 from the coin)
function cosignAndPost(txnHex, sigKey, callback) {
    if (!sigKey) { notify("No signing key available", "err"); callback(false, "no signing key"); return; }
    var txid = "cosign_" + Date.now();
    notify("Importing settlement transaction...", "info");
    MDS.cmd("txnimport id:" + txid + " data:" + txnHex, function(r1) {
        if (!r1 || !r1.status) { notify("Import failed", "err"); callback(false, "import failed"); return; }
        notify("Co-signing with " + sigKey.substring(0, 16) + "...", "info");
        MDS.cmd("txnsign id:" + txid + " publickey:" + sigKey, function(r2) {
            if (isPending(r2)) {
                handlePending(txid, callback);
                return;
            }
            if (!r2 || !r2.status) { notify("Co-sign failed", "err"); MDS.cmd("txndelete id:" + txid); callback(false, "cosign failed"); return; }
            notify("Posting settlement...", "info");
            MDS.cmd("txnbasics id:" + txid, function(br) {
            if (!br || !br.status) { MDS.log("SETTLE txnbasics failed: " + JSON.stringify(br)); MDS.cmd("txndelete id:" + txid); callback(false, "txnbasics failed"); return; }
            MDS.cmd("txnpost id:" + txid, function(pr) {
                MDS.cmd("txndelete id:" + txid);
                if (pr && pr.status) {
                    // Don't claim "Settled" — txnpost success = mempool only, not on-chain
                    callback(true, null);
                } else {
                    var errMsg = pr ? pr.error : "post failed";
                    if (errMsg && (errMsg.indexOf("not found") >= 0 || errMsg.indexOf("does not exist") >= 0)) {
                        notify("Proposal expired — coin was refreshed. Ask counterparty to re-propose.", "err");
                        callback(false, "stale proposal");
                    } else {
                        notify("Settlement post failed: " + errMsg, "err");
                        callback(false, errMsg);
                    }
                }
            });
            }); // txnbasics
        });
    });
}

// -- Resolve Bet (Phase 1) --
// Arbiter declares outcome. Fee = 10% of total pot.
// Params: coinid, outcome (1=TRUE/FOR wins, 0=FALSE/AGAINST wins), callback(success, error)
// VOID removed from contract — handled via self-settle (both sign, 0% fee).

function resolveBet(coinid, outcome, callback) {
    acquireTxnLock(function() {
        var txid = "resolve_" + Date.now();
        notify("Building resolve transaction...", "info");

        MDS.cmd("txncreate id:" + txid, function(r0) {
            if (!r0.status) { releaseTxnLock(); notify("txncreate failed", "err"); callback(false, "txncreate failed"); return; }

            MDS.cmd("txninput id:" + txid + " coinid:" + coinid, function(r1) {
                if (!r1.status) { cleanupTxn(txid); notify("Input failed", "err"); callback(false, "input failed"); return; }

                findCoinByIdOnChain(coinid, function(coin) {
                    if (!coin) {
                        cleanupTxn(txid); notify("Coin not found", "err"); callback(false, "coin not found"); return;
                    }
                    var totalPot = parseFloat(coin.amount);
                    var ownerSide = parseInt(getStateVal(coin, 6));
                    var ownerAddr = getStateVal(coin, 1);
                    var counterAddr = getStateVal(coin, 9);
                    var arbAddr = getStateVal(coin, 3);
                    var arbPk = getStateVal(coin, 2);

                    // Fee = 10% of total pot (matches contract: f=@AMOUNT/10)
                    var fee = Math.floor((totalPot / 10) * 1e8) / 1e8;
                    var winnings = (totalPot - fee).toFixed(8);
                    var feeStr = fee.toFixed(8);
                    var winnerAddr = (outcome === ownerSide) ? ownerAddr : counterAddr;

                    notify("Resolve: winner gets " + winnings + ", arbiter fee " + feeStr, "info");

                    // Output 0 (@INPUT): winnings to winner
                    MDS.cmd("txnoutput id:" + txid + " amount:" + winnings + " address:" + winnerAddr + " storestate:false", function(r2) {
                        if (!r2.status) { cleanupTxn(txid); notify("Winner output failed", "err"); callback(false, "winner output failed"); return; }

                        // Output 1 (@INPUT+1): fee to arbiter
                        MDS.cmd("txnoutput id:" + txid + " amount:" + feeStr + " address:" + arbAddr + " storestate:false", function(r3) {
                            if (!r3.status) { cleanupTxn(txid); notify("Fee output failed", "err"); callback(false, "fee output failed"); return; }

                            // Set STATE(11)=outcome AND STATE(14)=0 (Java VM requires all STATE ports set)
                            MDS.cmd("txnstate id:" + txid + " port:11 value:" + outcome, function(r4) {
                                if (!r4.status) { cleanupTxn(txid); callback(false, "state 11 failed"); return; }
                                MDS.cmd("txnstate id:" + txid + " port:14 value:0", function(r5) {
                                    if (!r5.status) { cleanupTxn(txid); callback(false, "state 14 failed"); return; }
                                    var label = outcome === 1 ? "TRUE wins" : "FALSE wins";
                                    signAndPostArbiter(txid, arbPk, label, callback);
                                });
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

                findCoinByIdOnChain(coinid, function(coin) {
                    if (!coin) {
                        cleanupTxn(txid); notify("Coin not found", "err"); callback(false, "coin not found"); return;
                    }
                    var ownerStake = getStateVal(coin, 10);
                    var ownerAddr = getStateVal(coin, 1);
                    var counterAddr = getStateVal(coin, 9);
                    var counterStake = (parseFloat(coin.amount) - parseFloat(ownerStake)).toFixed(8);

                    MDS.cmd("txnoutput id:" + txid + " amount:" + ownerStake + " address:" + ownerAddr + " storestate:false", function(r2) {
                        if (!r2.status) { cleanupTxn(txid); notify("Owner output failed", "err"); callback(false, "owner output failed"); return; }

                        MDS.cmd("txnoutput id:" + txid + " amount:" + counterStake + " address:" + counterAddr + " storestate:false", function(r3) {
                            if (!r3.status) { cleanupTxn(txid); notify("Counter output failed", "err"); callback(false, "counter output failed"); return; }

                            // Must set STATE(14)=0 — Java VM crashes on unset STATE ports
                            MDS.cmd("txnstate id:" + txid + " port:14 value:0", function() {

                            // Attach MAST proof for timeout path (V3 contract)
                            var mastScripts = {};
                            mastScripts[MAST_TIMEOUT_SCRIPT] = MAST_TIMEOUT_PROOF;
                            MDS.cmd("txnscript id:" + txid + " scripts:" + JSON.stringify(mastScripts), function(ms) {
                            if (!ms || !ms.status) { cleanupTxn(txid); notify("MAST proof failed", "err"); callback(false, "MAST failed"); return; }

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
                            }); // txnscript MAST
                            }); // txnstate port:14
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

            findCoinByIdOnChain(coinid, function(coin) {
                if (!coin) {
                    MDS.cmd("txndelete id:" + txid); callback(false); return;
                }
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

// ============================================================================
// HELPERS — Coin selection, state setting, cleanup
// ============================================================================

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

// Find a coin by coinid — uses coins address: (works on all nodes) not coins coinid: (fails on trackall-discovered coins)
function findCoinByIdOnChain(coinid, callback) {
    MDS.cmd("coins address:" + WAGER_SCRIPT_ADDRESS, function(res) {
        if (!res.status || !res.response) { callback(null); return; }
        for (var i = 0; i < res.response.length; i++) {
            if (res.response[i].coinid === coinid) { callback(res.response[i]); return; }
        }
        callback(null);
    });
}

function cleanupTxn(txid) {
    releaseTxnLock();
    MDS.cmd("txndelete id:" + txid);
}


// ============================================================================
// MATH — Odds calculation
// ============================================================================

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

// ============================================================================
// CHAINMAIL NOTIFICATION WRAPPERS
// ============================================================================

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

function notifyBetMatched(betid, pot, ownerMxKey, arbMxKey, market, callback) {
    var payload = {
        type: "BET_MATCHED",
        betid: betid,
        pot: pot,
        market: market || "",
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

function sendSettlePropose(counterMxKey, betid, outcome, txnHex, proposition, callback) {
    if (!counterMxKey) { if (callback) callback(false, "No counter Mx key"); return; }
    sendChainMail(counterMxKey, {
        type: "SETTLE_PROPOSE",
        betid: betid,
        outcome: outcome,
        txnhex: txnHex,
        proposition: proposition || "",
        sender_name: MY_MXNAME,
        sender_mxkey: MY_MXKEY
    }, function(ok, err) { if (callback) callback(ok, err); });
}

function sendSettleAccept(proposerMxKey, betid, proposition, outcome, callback) {
    if (!proposerMxKey) { if (callback) callback(false); return; }
    sendChainMail(proposerMxKey, {
        type: "SETTLE_ACCEPT",
        betid: betid,
        proposition: proposition || "",
        outcome: outcome,
        sender_name: MY_MXNAME
    }, function(ok) { if (callback) callback(ok); });
}

function sendSettleReject(proposerMxKey, arbMxKey, betid, proposition, callback) {
    var payload = {
        type: "SETTLE_REJECT",
        betid: betid,
        proposition: proposition || "",
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
