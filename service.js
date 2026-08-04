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
MDS.load("./js/identity.js");
MDS.load("./js/state.js");
MDS.load("./js/txn.js");

// Track current block for computing coin age (coins response has 'created' but not 'age')
var SERVICE_BLOCK = 0;

function coinAge(coin) {
    if (coin.age !== undefined && coin.age !== null) return parseInt(coin.age) || 0;
    if (SERVICE_BLOCK > 0 && coin.created) return Math.max(0, SERVICE_BLOCK - parseInt(coin.created));
    return 0;
}

MDS.init(function(msg) {

    // Use independent if blocks (not else if) — mInbox/PocketShop pattern
    // Events fire independently, else-if can block later handlers

    if (msg.event === "inited") {
        MDS.cmd("block", function(br) { if (br.status) SERVICE_BLOCK = parseInt(br.response.block) || 0; });
        initDB(function() {
            registerContract(function() {
                loadWalletKeys(function() {
                    loadSettlePending(function() {
                        MDS.cmd("coinnotify action:add address:" + WAGER_MAIL_ADDRESS, function() {
                            COINNOTIFY_SET = true;
                            MDS.log("Wager service started. Contract=" + WAGER_SCRIPT_ADDRESS + " Mail=" + WAGER_MAIL_ADDRESS);
                        });
                        syncBetCoins();
                        scanUnprocessedMail();
                    });
                });
            });
        });
    }

    if (msg.event === "NOTIFYCOIN") {
        var notifyCoin = msg.data && msg.data.coin;
        if (notifyCoin) {
            var coinAddr = notifyCoin.address || (msg.data && msg.data.address) || "";
            if (coinAddr === WAGER_MAIL_ADDRESS) {
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
    }

    if (msg.event === "NEWBLOCK") {
        try { SERVICE_BLOCK = parseInt(msg.data.txpow.header.block) || SERVICE_BLOCK; } catch(e) {}
        if (!WAGER_SCRIPT_ADDRESS) {
            registerContract();
        }
        ensureCoinNotify();
        checkAndRefreshCoins();
    }

    if (msg.event === "MDS_TIMER_10SECONDS") {
        syncBetCoins();
        ensureCoinNotify();
        scanUnprocessedMail();
        // Expire stale settle-pending entries (>30 min)
        var now = Date.now();
        var expired = false;
        for (var prop in SETTLE_PENDING) {
            if (now - SETTLE_PENDING[prop] > SETTLE_PENDING_TTL) { delete SETTLE_PENDING[prop]; expired = true; }
        }
        if (expired) persistSettlePending();
    }

    if (msg.event === "MDSCOMMS") {
        if (!msg.data.public) {
            try {
                var req = JSON.parse(msg.data.message);
                if (req.action === "refresh") syncBetCoins();
                if (req.action === "settle_pending" && req.proposition) {
                    SETTLE_PENDING[req.proposition] = Date.now();
                    persistSettlePending();
                }
                if (req.action === "settle_cleared" && req.proposition) {
                    delete SETTLE_PENDING[req.proposition];
                    persistSettlePending();
                }
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
        else if (message.type === "CHAT_MESSAGE") handleChatMessage(message, senderMxKey);
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

    // Update MxKeys — match by betid OR market (betid=coinid from filler, doesn't match owner's generated betid)
    if (message.counter_mxkey) {
        var ck = message.counter_mxkey.replace(/'/g, "''");
        MDS.sql("UPDATE bets SET countermxkey='" + ck + "' WHERE betid='" + (message.betid || "").replace(/'/g, "''") + "'");
        if (message.market) {
            MDS.sql("UPDATE bets SET countermxkey='" + ck + "' WHERE market='" + (message.market || "").replace(/'/g, "''") + "' AND countermxkey=''");
        }
    }
    if (message.owner_mxkey) {
        var ok = message.owner_mxkey.replace(/'/g, "''");
        MDS.sql("UPDATE bets SET ownermxkey='" + ok + "' WHERE betid='" + (message.betid || "").replace(/'/g, "''") + "'");
        if (message.market) {
            MDS.sql("UPDATE bets SET ownermxkey='" + ok + "' WHERE market='" + (message.market || "").replace(/'/g, "''") + "' AND ownermxkey=''");
        }
    }
}

/**
 * Bettor proposes an outcome with a partially signed transaction.
 */
function handleSettlePropose(message, senderMxKey) {
    var outcomeLabel = parseInt(message.outcome) === 1 ? "TRUE" : "FALSE";
    MDS.log("SETTLE_PROPOSE: " + outcomeLabel + " proposed for bet " + (message.betid || "?"));
    MDS.notify("Counterparty proposes " + outcomeLabel + " — open Wager to Accept (0% fee) or Reject");
    if (message.proposition) { SETTLE_PENDING[message.proposition] = Date.now(); persistSettlePending(); }
}

/**
 * Other bettor accepted and posted the settlement. 0% fee.
 */
function handleSettleAccept(message, senderMxKey) {
    MDS.log("SETTLE_ACCEPT: bet " + (message.betid || "?") + " settled by agreement");
    MDS.notify("Counterparty accepted — settled at 0% fee! Winnings confirming on-chain...");
    if (message.proposition) { delete SETTLE_PENDING[message.proposition]; persistSettlePending(); }
}

/**
 * Other bettor rejected the proposed outcome.
 */
function handleSettleReject(message, senderMxKey) {
    MDS.log("SETTLE_REJECT: bet " + (message.betid || "?") + " — counterparty disagrees");
    MDS.notify("Settlement rejected — awaiting arbiter");
    if (message.proposition) { delete SETTLE_PENDING[message.proposition]; persistSettlePending(); }
}

/**
 * Arbiter receives dispute notification.
 */
function handleDispute(message, senderMxKey) {
    MDS.log("DISPUTE: arbiter must resolve bet " + (message.betid || "?"));
    MDS.notify("Dispute! You must resolve a bet. Open Wager to decide.");
}

/**
 * Bettor-to-bettor chat message.
 */
function handleChatMessage(message, senderMxKey) {
    var sender = message.sender_name || "Bettor";
    var text = (message.message || "").substring(0, 100);
    MDS.log("CHAT from " + sender + ": " + text);
    MDS.notify(sender + ": " + text);
}

/**
 * Ensure coinnotify is registered for ChainMail address.
 * Re-registers on every NEWBLOCK in case it was lost after update/restart.
 */
// Propositions with active settle proposals — don't refresh these coins
// Keys = proposition text, values = timestamp (ms). Expires after 30 min.
var SETTLE_PENDING = {};
var SETTLE_PENDING_TTL = 1800000; // 30 minutes
var SETTLE_PENDING_KEY = "wager_settle_pending";

function persistSettlePending() {
    try { MDS.keypair.set(SETTLE_PENDING_KEY, JSON.stringify(SETTLE_PENDING)); } catch(e) {}
}
function loadSettlePending(callback) {
    MDS.keypair.get(SETTLE_PENDING_KEY, function(val) {
        if (val && val.value) {
            try {
                var loaded = JSON.parse(val.value);
                var now = Date.now();
                for (var p in loaded) {
                    if (now - loaded[p] < SETTLE_PENDING_TTL) SETTLE_PENDING[p] = loaded[p];
                }
            } catch(e) {}
        }
        if (callback) callback();
    });
}

// Re-register coinnotify periodically — registrations can be lost on MDS update
var COINNOTIFY_LAST = 0;
function ensureCoinNotify() {
    if (!WAGER_MAIL_ADDRESS) return;
    var now = Date.now();
    if (now - COINNOTIFY_LAST < 300000) return; // Re-register every 5 minutes
    MDS.cmd("coinnotify action:add address:" + WAGER_MAIL_ADDRESS, function(res) {
        if (res && res.status) {
            COINNOTIFY_LAST = now;
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
        // Process recent unspent coins — coinAge() handles missing .age field
        var recent = res.response.filter(function(c) {
            if (c.spent) return false;
            var age = coinAge(c);
            return age === 0 || age < 50;
        });
        if (recent.length > 0) MDS.log("Scanning " + recent.length + " recent mail coin(s)...");
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

    // HOUSEKEEPING FIX: Check permission mode before attempting txnsign.
    // In "read" mode, every txnsign creates a pending action in MiniHub.
    // At REFRESH_AGE=1200, this would create one pending action per day per coin.
    // Skip auto-refresh entirely if not in write/bypass mode.
    MDS.cmd("checkmode", function(modeRes) {
        if (modeRes && modeRes.response && modeRes.response.mode === "READ") {
            MDS.log("Skipping auto-refresh — app is in READ mode (would create pending actions)");
            return;
        }
        doRefreshCoins();
    });
}

function doRefreshCoins() {

    // Read settle-pending from shared keypair (app.js writes, service.js reads)
    MDS.keypair.get("wager_settle_pending", function(spVal) {
        var settlePending = {};
        try { if (spVal && spVal.value) settlePending = JSON.parse(spVal.value); } catch(e) {}

    MDS.cmd("coins address:" + WAGER_SCRIPT_ADDRESS, function(res) {
        if (!res.status || !res.response) return;

        var stale = [];
        res.response.forEach(function(coin) {
            var age = coinAge(coin);
            if (age >= REFRESH_AGE && parseFloat(coin.amount) > 0.001) {
                var ownerKey = getStateVal(coin, 0);
                var phase = getStateVal(coin, 4);
                var canSign = isMyKey(ownerKey);
                if (phase === "1") {
                    // Skip refresh if a settle proposal is pending for this coin's proposition
                    var prop = hexToStr(getStateVal(coin, 12));
                    if (prop && settlePending[prop]) return;
                    var counterKey = getStateVal(coin, 8);
                    canSign = canSign || isMyKey(counterKey);
                }
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
                            // Phase 1 refresh needs MAST proof (V3 contract)
                            var phase = getStateVal(coin, 4);
                            function afterMast() {
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
                                            MDS.log("Auto-refreshed: " + coin.coinid.substring(0, 16) + " (age was " + coinAge(coin) + ")");
                                        } else {
                                            MDS.log("Auto-refresh post failed: " + (pr ? pr.error : ""));
                                        }
                                        idx++;
                                        setTimeout(refreshNext, 2000);
                                    });
                                });
                            });
                            } // afterMast

                            if (phase === "1") {
                                // Attach MAST proof for phase 1 refresh
                                var mastScripts = {};
                                mastScripts[MAST_REFRESH_SCRIPT] = MAST_REFRESH_PROOF;
                                MDS.cmd("txnscript id:" + txid + " scripts:" + JSON.stringify(mastScripts), function(ms) {
                                    if (!ms || !ms.status) {
                                        MDS.log("MAST script attach failed: " + (ms ? ms.error : ""));
                                        MDS.cmd("txndelete id:" + txid); idx++; refreshNext(); return;
                                    }
                                    afterMast();
                                });
                            } else {
                                afterMast(); // Phase 0 — no MAST needed
                            }
                        }

                        setNextState();
                    });
                });
            });
        }

        refreshNext();
    });
    }); // keypair get
}