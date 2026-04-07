/**
 * Wager — Background Service
 *
 * Registers the prediction market contract, tracks coins,
 * and listens for ChainMail messages via coinnotify.
 *
 * Message types:
 *   BET_CREATED     — Poster notifies arbiter of new market
 *   BET_MATCHED     — Filler notifies poster + arbiter that bet is live
 *   SETTLE_PROPOSE  — Bettor proposes outcome with partially signed tx
 *   SETTLE_ACCEPT   — Other bettor co-signed and posted (0% fee)
 *   SETTLE_REJECT   — Other bettor disagrees, escalate to arbiter
 *   DISPUTE         — Bettor notifies arbiter to resolve
 */

MDS.load("./js/chainmail.js");
MDS.load("./js/db.js");
MDS.load("./js/contract.js");
MDS.load("./js/wager.js");

MDS.init(function(msg) {

    if (msg.event === "inited") {
        initDB(function() {
            registerContract(function() {
                loadWalletKeys(function() {
                    MDS.cmd("coinnotify action:add address:" + WAGER_MAIL_ADDRESS, function() {
                        COINNOTIFY_SET = true;
                        MDS.log("Wager service started. Contract=" + WAGER_SCRIPT_ADDRESS + " Mail=" + WAGER_MAIL_ADDRESS);
                    });
                    syncBetCoins();
                    scanUnprocessedMail();
                });
            });
        });
    }

    else if (msg.event === "NOTIFYCOIN") {
        var notifyCoin = msg.data && msg.data.coin;
        if (notifyCoin && msg.data.address === WAGER_MAIL_ADDRESS) {
            var state99data = getState99(notifyCoin.state);
            if (state99data) {
                MDS.log("NOTIFYCOIN: found state99, attempting decrypt...");
                decryptChainMail(state99data, function(success, message, senderMxKey) {
                    if (success && message) {
                        processMessage(message, senderMxKey);
                    }
                });
            }
        }
    }

    else if (msg.event === "NEWBLOCK") {
        if (!WAGER_SCRIPT_ADDRESS) {
            registerContract();
        }
        // Ensure coinnotify is registered (lost after update/restart)
        ensureCoinNotify();
        // Auto-refresh stale coins to keep them alive across cascade
        checkAndRefreshCoins();
    }

    else if (msg.event === "MDS_TIMER_60SECONDS") {
        syncBetCoins();
        ensureCoinNotify();
        scanUnprocessedMail();
    }

    else if (msg.event === "MDSCOMMS") {
        if (!msg.data.public) {
            try {
                var req = JSON.parse(msg.data.message);
                if (req.action === "refresh") syncBetCoins();
            } catch (e) {}
        }
    }
});

/**
 * Process a decrypted ChainMail message.
 */
function processMessage(message, senderMxKey) {
    if (!message.randomid || !message.type) return;

    messageExists(message.randomid, function(exists) {
        if (exists) return;

        MDS.log("Processing " + message.type + " from " + (senderMxKey || "").substring(0, 20) + "...");

        insertMessage({
            randomid: message.randomid,
            betid: message.betid || "",
            type: message.type,
            sender_mxkey: senderMxKey || "",
            sender_name: message.sender_name || "",
            data: JSON.stringify(message),
            direction: "received"
        });

        if (message.type === "BET_CREATED") handleBetCreated(message, senderMxKey);
        else if (message.type === "BET_MATCHED") handleBetMatched(message, senderMxKey);
        else if (message.type === "SETTLE_PROPOSE") handleSettlePropose(message, senderMxKey);
        else if (message.type === "SETTLE_ACCEPT") handleSettleAccept(message, senderMxKey);
        else if (message.type === "SETTLE_REJECT") handleSettleReject(message, senderMxKey);
        else if (message.type === "DISPUTE") handleDispute(message, senderMxKey);
    });
}

/**
 * Arbiter receives notification they've been selected for a new market.
 */
function handleBetCreated(message, senderMxKey) {
    MDS.log("BET_CREATED: arbiter selected for bet " + (message.betid || "?"));
    MDS.notify("New bet created — you are the arbiter");
}

/**
 * All parties notified that bet is now matched and live.
 */
function handleBetMatched(message, senderMxKey) {
    MDS.log("BET_MATCHED: bet " + (message.betid || "?") + " is live");
    MDS.notify("Bet matched! Pot: " + (message.pot || "?") + " MINIMA");

    if (message.betid && message.counter_mxkey) {
        updateBetMxKeys(message.betid, "countermxkey", message.counter_mxkey);
    }
    if (message.betid && message.owner_mxkey) {
        updateBetMxKeys(message.betid, "ownermxkey", message.owner_mxkey);
    }
}

/**
 * Bettor proposes an outcome with a partially signed transaction.
 */
function handleSettlePropose(message, senderMxKey) {
    MDS.log("SETTLE_PROPOSE: " + (message.outcome === 1 ? "TRUE" : "FALSE") + " proposed for bet " + (message.betid || "?"));
    MDS.notify("Settlement proposed: " + (message.outcome === 1 ? "TRUE" : "FALSE") + " — review in Wager app");
}

/**
 * Other bettor accepted and posted the settlement. 0% fee.
 */
function handleSettleAccept(message, senderMxKey) {
    MDS.log("SETTLE_ACCEPT: bet " + (message.betid || "?") + " settled by agreement");
    MDS.notify("Bet settled by agreement — 0% fee!");
}

/**
 * Other bettor rejected the proposed outcome.
 */
function handleSettleReject(message, senderMxKey) {
    MDS.log("SETTLE_REJECT: bet " + (message.betid || "?") + " — counterparty disagrees");
    MDS.notify("Settlement rejected — awaiting arbiter");
}

/**
 * Arbiter receives dispute notification.
 */
function handleDispute(message, senderMxKey) {
    MDS.log("DISPUTE: arbiter must resolve bet " + (message.betid || "?"));
    MDS.notify("Dispute! You must resolve a bet. Open Wager to decide.");
}

/**
 * Ensure coinnotify is registered for ChainMail address.
 * Re-registers on every NEWBLOCK in case it was lost after update/restart.
 */
var COINNOTIFY_SET = false;
function ensureCoinNotify() {
    if (COINNOTIFY_SET || !WAGER_MAIL_ADDRESS) return;
    MDS.cmd("coinnotify action:add address:" + WAGER_MAIL_ADDRESS, function(res) {
        if (res && res.status) {
            COINNOTIFY_SET = true;
            MDS.log("ChainMail coinnotify registered: " + WAGER_MAIL_ADDRESS);
        }
    });
}

/**
 * Scan for unprocessed ChainMail — catches messages missed during downtime/update.
 */
function scanUnprocessedMail() {
    if (!WAGER_MAIL_ADDRESS) return;
    MDS.cmd("coins address:" + WAGER_MAIL_ADDRESS, function(res) {
        if (!res.status || !res.response) return;
        // Only process recent coins (age < 50 blocks = ~40 min)
        var recent = res.response.filter(function(c) { return parseInt(c.age) < 50 && !c.spent; });
        recent.forEach(function(coin) {
            var state99 = getState99(coin.state);
            if (state99) {
                decryptChainMail(state99, function(success, message, senderMxKey) {
                    if (success && message) {
                        processMessage(message, senderMxKey);
                    }
                });
            }
        });
    });
}

/**
 * Sync on-chain bet coins with local DB.
 */
function syncBetCoins() {
    if (!WAGER_SCRIPT_ADDRESS) return;

    MDS.cmd("coins address:" + WAGER_SCRIPT_ADDRESS, function(res) {
        if (!res.status) return;
        var coins = res.response || [];
        MDS.log("Sync: " + coins.length + " coins at contract");
    });
}

/**
 * Check for stale coins and refresh them to keep alive across cascade.
 * Called on every NEWBLOCK. Refreshes coins older than REFRESH_AGE blocks.
 */
var REFRESH_RUNNING = false;

function checkAndRefreshCoins() {
    if (!WAGER_SCRIPT_ADDRESS || REFRESH_RUNNING) return;

    MDS.cmd("coins address:" + WAGER_SCRIPT_ADDRESS, function(res) {
        if (!res.status || !res.response) return;

        var stale = [];
        res.response.forEach(function(coin) {
            var age = parseInt(coin.age) || 0;
            if (age >= REFRESH_AGE && parseFloat(coin.amount) > 0.001) {
                var ownerKey = getStateVal(coin, 0);
                var counterKey = getStateVal(coin, 8);
                var phase = getStateVal(coin, 4);
                var canSign = isMyKey(ownerKey);
                if (phase === "1") canSign = canSign || isMyKey(counterKey);
                if (canSign) stale.push(coin);
            }
        });

        if (stale.length === 0) return;

        REFRESH_RUNNING = true;
        MDS.log("Auto-refresh: " + stale.length + " stale coin(s) found");

        var idx = 0;
        function refreshNext() {
            if (idx >= stale.length) { REFRESH_RUNNING = false; return; }
            var coin = stale[idx];
            var sigKey = isMyKey(getStateVal(coin, 0)) ? getStateVal(coin, 0) : getStateVal(coin, 8);
            var txid = "autorefresh_" + Date.now();

            MDS.cmd("txncreate id:" + txid, function(r0) {
                if (!r0.status) { idx++; refreshNext(); return; }

                MDS.cmd("txninput id:" + txid + " coinid:" + coin.coinid, function(r1) {
                    if (!r1.status) { MDS.cmd("txndelete id:" + txid); idx++; refreshNext(); return; }

                    MDS.cmd("txnoutput id:" + txid + " amount:" + coin.amount + " address:" + WAGER_SCRIPT_ADDRESS + " storestate:true", function(r2) {
                        if (!r2.status) { MDS.cmd("txndelete id:" + txid); idx++; refreshNext(); return; }

                        // Copy all state + set missing ports to 0 + port 14 = 1 (refresh flag)
                        var ports = [];
                        var setPorts = {};
                        coin.state.forEach(function(s) { ports.push(s.port + ":" + s.data); setPorts[s.port] = true; });
                        // Ensure ALL ports 0-16 exist — Java VM crashes on unset STATE
                        for (var p = 0; p <= 16; p++) {
                            if (!setPorts[p]) ports.push(p + ":0");
                        }
                        // Override port 14 = 1 (refresh flag)
                        ports.push("14:1");

                        var pidx = 0;
                        function setNextState() {
                            if (pidx >= ports.length) { doSign(); return; }
                            var parts = ports[pidx].split(":");
                            var p = parts[0];
                            var v = parts.slice(1).join(":");
                            MDS.cmd("txnstate id:" + txid + " port:" + p + " value:" + v, function() {
                                pidx++;
                                setNextState();
                            });
                        }

                        function doSign() {
                            MDS.cmd("txnsign id:" + txid + " publickey:" + sigKey, function(sr) {
                                if (!sr || !sr.status) {
                                    MDS.log("Auto-refresh sign failed for " + coin.coinid.substring(0, 16));
                                    MDS.cmd("txndelete id:" + txid);
                                    idx++;
                                    refreshNext();
                                    return;
                                }
                                MDS.cmd("txnbasics id:" + txid, function(br) {
                                    if (!br || !br.status) {
                                        MDS.cmd("txndelete id:" + txid);
                                        idx++;
                                        refreshNext();
                                        return;
                                    }
                                    MDS.cmd("txnpost id:" + txid, function(pr) {
                                        MDS.cmd("txndelete id:" + txid);
                                        if (pr && pr.status) {
                                            MDS.log("Auto-refreshed: " + coin.coinid.substring(0, 16) + " (age was " + coin.age + ")");
                                        } else {
                                            MDS.log("Auto-refresh post failed: " + (pr ? pr.error : ""));
                                        }
                                        idx++;
                                        setTimeout(refreshNext, 2000);
                                    });
                                });
                            });
                        }

                        setNextState();
                    });
                });
            });
        }

        refreshNext();
    });
}