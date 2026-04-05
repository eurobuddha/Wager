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

MDS.init(function(msg) {

    if (msg.event === "inited") {
        initDB(function() {
            registerContract(function() {
                MDS.cmd("coinnotify action:add address:" + WAGER_MAIL_ADDRESS, function() {
                    MDS.log("Wager service started. Contract=" + WAGER_SCRIPT_ADDRESS + " Mail=" + WAGER_MAIL_ADDRESS);
                });
                syncBetCoins();
            });
        });
    }

    else if (msg.event === "NOTIFYCOIN") {
        if (msg.data.address === WAGER_MAIL_ADDRESS && msg.data.coin && msg.data.coin.state[99]) {
            decryptChainMail(msg.data.coin.state[99], function(success, message, senderMxKey) {
                if (success && message) {
                    processMessage(message, senderMxKey);
                }
            });
        }
    }

    else if (msg.event === "NEWBLOCK") {
        if (!WAGER_SCRIPT_ADDRESS) {
            registerContract();
        }
    }

    else if (msg.event === "MDS_TIMER_60SECONDS") {
        syncBetCoins();
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
    MDS.log("SETTLE_PROPOSE: " + (message.outcome === 1 ? "BACK" : "LAY") + " wins proposed for bet " + (message.betid || "?"));
    MDS.notify("Settlement proposed: " + (message.outcome === 1 ? "BACK" : "LAY") + " wins — review in Wager app");
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