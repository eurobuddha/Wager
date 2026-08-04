/**
 * ============================================================================
 * WAGER — State Management Module
 * ============================================================================
 *
 * PURPOSE:
 *   Central source of truth for all bet data. Loads coins from the blockchain,
 *   parses them into structured objects, matches incoming settlement proposals,
 *   and handles the dual-propose auto-settle optimization.
 *
 *   This module owns the bet arrays that the UI reads from. No other module
 *   should modify OPEN_BETS, MATCHED_BETS, or PENDING_PROPOSALS directly.
 *
 * GLOBALS EXPORTED (read by app.js for rendering, service.js for refresh):
 *   OPEN_BETS          — Array of parsed phase-0 (unmatched) bet objects
 *   MATCHED_BETS       — Array of parsed phase-1 (matched) bet objects
 *   CURRENT_BLOCK      — Current block height (updated on NEWBLOCK)
 *   PENDING_PROPOSALS   — Map of coinid → settlement proposal data
 *   SENT_PROPOSALS      — Map of proposition → {outcome, coinid} for dual-propose detection
 *   ESCROW_RATE         — 0.25 (25% escrow on top of bet amount)
 *   REFRESH_AGE         — Blocks before auto-refresh (10 for testing, 1200 for production)
 *
 * FUNCTIONS EXPORTED:
 *   refreshBets(callback)               — Load all coins from contract, parse into arrays
 *   refreshBetsAndProposals(callback)    — refreshBets + match proposals + auto-accept
 *   autoAcceptDualProposals()            — If both sides proposed same outcome, auto-cosign
 *   parseBetCoin(coin)                   — Parse raw coin object into structured bet
 *   getStateVal(coin, port)              — Read a state variable from a coin's state array
 *   enrichMxKeys(callback)              — Fill in missing MxKeys from the bets DB
 *
 * SECURITY NOTES:
 *   - parseBetCoin determines ownership via isMyKey() from identity.js.
 *     The isMine/isMyCounter/isMyArb flags drive which UI actions are available.
 *     A false negative here means the user can't declare or settle their own bet.
 *
 *   - autoAcceptDualProposals automatically co-signs when both parties propose
 *     the same outcome. This is safe because the co-signed transaction enforces
 *     the correct payout structure via VERIFYOUT in the contract. A malicious
 *     proposal with wrong outputs would fail on-chain validation.
 *
 *   - PENDING_PROPOSALS stores the txnhex from received settlement proposals.
 *     This txnhex is a partially-signed transaction. When accepted, it's imported,
 *     co-signed with the local key, and posted. The contract's VERIFYOUT constraints
 *     ensure the payout matches the declared outcome — the txnhex cannot steal funds.
 *
 * DEPENDENCIES:
 *   - identity.js (isMyKey, hexToStr, strToHex, MY_MXKEY)
 *   - contract.js (WAGER_SCRIPT_ADDRESS)
 *   - db.js (loadPendingProposals, insertMessage)
 *   - txn.js (cosignAndPost, sendSettleAccept — for auto-accept)
 *   - chainmail.js (for notification in auto-accept path)
 *
 * LOADED BY:
 *   - index.html (browser context, after identity.js, before txn.js)
 *   - service.js via MDS.load (background context, for parseBetCoin, getStateVal)
 * ============================================================================
 */

// ============================================================================
// GLOBALS — Bet state arrays
// ============================================================================

/** All phase-0 (open/unmatched) bets at the contract address */
var OPEN_BETS = [];

/** All phase-1 (matched) bets at the contract address */
var MATCHED_BETS = [];

/** Current blockchain block height, updated on every NEWBLOCK event */
var CURRENT_BLOCK = 0;

/**
 * Map of coinid → proposal data from incoming SETTLE_PROPOSE messages.
 * Populated by refreshBetsAndProposals from the messages DB.
 * Used by app.js to render Accept/Reject buttons on bet cards.
 * Structure: { outcome, txnhex, sender_mxkey, sender_name, randomid }
 */
var PENDING_PROPOSALS = {};

/**
 * Map of proposition → {outcome, coinid} for proposals WE sent.
 * Used by autoAcceptDualProposals to detect when both sides proposed
 * the same outcome, enabling automatic co-signing.
 * In-memory only — cleared on page reload. This is intentional:
 * if the app restarts, the user sees the Accept/Reject UI instead.
 */
var SENT_PROPOSALS = {};

// ============================================================================
// CONSTANTS
// ============================================================================

/** Escrow rate: 25% on top of the bet amount. Lock = bet × 1.25 */
var ESCROW_RATE = 0.25;

/**
 * Auto-refresh threshold in blocks.
 * Coins older than this get refreshed to survive Minima's cascade compression.
 * 10 for testing (~8 min), 1200 for production (~20 hours).
 * Cascade sweeps coins at ~2048 blocks — refresh must happen before that.
 */
var REFRESH_AGE = 1200;  // ~1 day at 50s/block. Was 10 for testing — caused 1400+ pending actions.


// ============================================================================
// COIN PARSING — Convert raw Minima coin objects to structured bet data
// ============================================================================

/**
 * Parse a raw coin object from MDS.cmd("coins address:...") into a
 * structured bet object with computed fields.
 *
 * This is the canonical bet representation used throughout the app.
 * Every field is documented because other modules depend on them.
 *
 * COIN STATE PORT LAYOUT (from contract.js):
 *   0  = ownerpk       — Owner's signing public key
 *   1  = owneraddr     — Owner's payout address
 *   2  = arbpk         — Arbiter's signing public key
 *   3  = arbaddr       — Arbiter's payout address
 *   4  = phase         — 0=open, 1=matched
 *   5  = timeout       — Blocks before timeout refund
 *   6  = side          — 1=FOR, 0=AGAINST (owner's side)
 *   7  = wantstake     — Amount counter must put up (with escrow)
 *   8  = counterpk     — Counter's signing public key (set at fill)
 *   9  = counteraddr   — Counter's payout address (set at fill)
 *   10 = ownerstake    — Owner's lock amount (= @AMOUNT at fill time)
 *   11 = outcome       — Settlement outcome (set during self-settle/arbiter)
 *   12 = proposition   — Hex-encoded market description text
 *   13 = settlement    — Target block number, 0=anytime
 *   14 = refresh flag  — 1=refresh tx (used by MAST refresh path)
 *   15 = ownermxkey    — Owner's Maxima key (hex-encoded)
 *   16 = countermxkey  — Counter's Maxima key (hex-encoded)
 *   17 = arbitermxkey  — Arbiter's Maxima key (hex-encoded)
 *
 * @param {Object} coin — Raw coin from MDS coins command
 * @returns {Object} — Structured bet object
 */
function parseBetCoin(coin) {
    return {
        // -- On-chain identifiers --
        coinid: coin.coinid,
        amount: coin.amount,                                    // Total locked (with escrow)
        phase: parseInt(getStateVal(coin, 4)) || 0,             // 0=open, 1=matched

        // -- Owner identity (set at post time) --
        ownerpk: getStateVal(coin, 0),
        owneraddr: getStateVal(coin, 1),

        // -- Arbiter identity (set at post time) --
        arbpk: getStateVal(coin, 2),
        arbaddr: getStateVal(coin, 3),

        // -- Bet parameters --
        timeout: parseInt(getStateVal(coin, 5)) || 5000,
        side: parseInt(getStateVal(coin, 6)),                   // 1=FOR, 0=AGAINST
        wantstake: getStateVal(coin, 7),                        // Counter's required lock

        // -- Counter identity (set at fill time) --
        counterpk: getStateVal(coin, 8),
        counteraddr: getStateVal(coin, 9),

        // -- Amounts --
        ownerstake: getStateVal(coin, 10),                      // Owner's lock = @AMOUNT at fill

        // -- Proposition (the market question) --
        proposition: hexToStr(getStateVal(coin, 12)),            // Human-readable text
        propositionHex: getStateVal(coin, 12),                   // Raw hex (for state preservation)

        // -- Settlement --
        settlement: getStateVal(coin, 13),                       // Target block, 0=anytime

        // -- Maxima keys (for ChainMail messaging) --
        // Each key is hex-encoded on-chain via strToHex(MxKey).
        // We decode and validate: must start with "Mx" to be valid.
        // If corrupted (old builds stored raw RSA bytes), returns "".
        // enrichMxKeys() fills in missing keys from the bets DB as fallback.
        ownermxkey: (function() {
            var k = hexToStr(getStateVal(coin, 15));
            return k && k.substring(0, 2) === "Mx" ? k : "";
        })(),
        countermxkey: (function() {
            var k = hexToStr(getStateVal(coin, 16));
            return k && k.substring(0, 2) === "Mx" ? k : "";
        })(),
        arbitermxkey: (function() {
            var k = hexToStr(getStateVal(coin, 17));
            return k && k.substring(0, 2) === "Mx" ? k : "";
        })(),
        arbitermxkeyHex: getStateVal(coin, 17),                  // Raw hex for state preservation

        // -- Ownership flags --
        // Determined by isMyKey() from identity.js against ALL 64 wallet keys.
        // These flags drive which UI actions are available for this bet.
        isMine: isMyKey(getStateVal(coin, 0)),                   // Am I the owner?
        isMyCounter: isMyKey(getStateVal(coin, 8)),              // Am I the counter?
        isMyArb: isMyKey(getStateVal(coin, 2)),                  // Am I the arbiter?

        // -- Metadata --
        created: coin.created || "0",
        age: (function() {
            var a = parseInt(coin.age);
            if (!isNaN(a)) return a;
            if (CURRENT_BLOCK > 0 && coin.created) return Math.max(0, CURRENT_BLOCK - parseInt(coin.created));
            return 0;
        })()
    };
}

/**
 * Read a state variable from a coin's state array.
 *
 * Minima coins store state as an array of {port, data} objects.
 * This helper finds the entry matching the requested port number.
 *
 * NOTE: NOTIFYCOIN delivers state as an object ({99: "data"}),
 * while the coins command delivers it as an array ([{port:99, data:"..."}]).
 * This function handles the ARRAY format only. For NOTIFYCOIN format,
 * use getState99() in chainmail.js which handles both.
 *
 * @param {Object} coin — Raw coin object with .state array
 * @param {number} port — State port number (0-255)
 * @returns {string} — State value, or "" if not found
 */
function getStateVal(coin, port) {
    if (!coin.state) return "";
    for (var i = 0; i < coin.state.length; i++) {
        if (coin.state[i].port === port) return coin.state[i].data;
    }
    return "";
}


// ============================================================================
// BET LOADING — Sync on-chain state into local arrays
// ============================================================================

/**
 * Load all coins at the contract address and categorize by phase.
 *
 * Phase 0 = open/unmatched bets (on the noticeboard)
 * Phase 1 = matched bets (locked, awaiting settlement)
 *
 * After loading, calls enrichMxKeys to fill in any missing Maxima keys
 * from the bets database (ports 15-17 may be corrupted on old bets).
 *
 * Called by: refreshBetsAndProposals (below), service.js syncBetCoins
 * Modifies: OPEN_BETS, MATCHED_BETS (global arrays)
 *
 * @param {function} callback — Called when loading complete
 */
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

        // Fill in missing MxKeys from DB (on-chain ports 15-17 are unreliable on old bets)
        enrichMxKeys(function() {
            if (callback) callback();
        });
    });
}

/**
 * Fill in missing Maxima keys from the bets database.
 *
 * When a bet is posted (postBet) or filled (fillBet), the MxKeys are stored
 * in the bets DB table. When BET_MATCHED ChainMail arrives, the counter's
 * MxKey is also stored. This function reads those stored keys and applies
 * them to MATCHED_BETS entries where the on-chain port data is missing.
 *
 * WHY: On-chain state ports 15-17 are unreliable because:
 *   1. Old builds stored raw RSA bytes instead of hex-encoded Mx addresses
 *   2. The MiniDapp reinstall wipes the keypair, changing MY_MXKEY
 *   3. The filler's MxKey depends on their app version at fill time
 *
 * The DB is the reliable source — it stores MxKeys as clean Mx strings.
 *
 * Matching strategy:
 *   1. Try matching by coinid (exact, but fails after auto-refresh changes coinid)
 *   2. Fallback: match by proposition text (market name, stable across refreshes)
 *
 * @param {function} callback — Called when enrichment complete
 */
function enrichMxKeys(callback) {
    if (MATCHED_BETS.length === 0) { callback(); return; }

    MDS.sql("SELECT betid, ownermxkey, countermxkey, arbitermxkey, market FROM bets WHERE ownermxkey != '' OR countermxkey != '' OR arbitermxkey != ''", function(res) {
        var dbKeys = {};
        if (res.status && res.rows) {
            res.rows.forEach(function(r) {
                // H2 returns column names in UPPERCASE
                var entry = {
                    owner: r.OWNERMXKEY || "",
                    counter: r.COUNTERMXKEY || "",
                    arbiter: r.ARBITERMXKEY || ""
                };
                if (r.MARKET) dbKeys[r.MARKET] = entry;     // Match by proposition text
                if (r.BETID) dbKeys[r.BETID] = entry;       // Match by coinid/betid
            });
        }
        MATCHED_BETS.forEach(function(bet) {
            var stored = dbKeys[bet.coinid] || dbKeys[bet.proposition] || null;
            if (stored) {
                if (!bet.ownermxkey && stored.owner) bet.ownermxkey = stored.owner;
                if (!bet.countermxkey && stored.counter) bet.countermxkey = stored.counter;
                if (!bet.arbitermxkey && stored.arbiter) bet.arbitermxkey = stored.arbiter;
            }
        });
        callback();
    });
}


// ============================================================================
// PROPOSAL MANAGEMENT — Match received proposals to bets
// ============================================================================

/**
 * Refresh all bet data and match pending settlement proposals.
 *
 * This is the main "sync" function called by the UI after any state change.
 * It refreshes on-chain bets, loads received SETTLE_PROPOSE messages from the
 * messages DB, matches them to the correct bet by coinid or proposition text,
 * and checks for dual-propose auto-settlement.
 *
 * Called by: initApp, NEWBLOCK handler, after post/fill/cancel/settle actions
 *
 * @param {function} callback — Called when complete (usually renderCurrentView)
 */
function refreshBetsAndProposals(callback) {
    refreshBets(function() {
        loadPendingProposals(function(rows) {
            PENDING_PROPOSALS = {};
            rows.forEach(function(row) {
                try {
                    var data = JSON.parse(row.DATA);
                    var proposalBetid = data.betid || "";

                    // Strategy 1: Direct coinid match
                    var matchedBet = MATCHED_BETS.find(function(b) {
                        return b.coinid === proposalBetid;
                    });

                    // Strategy 2: Match by proposition text (coinid changes after auto-refresh)
                    if (!matchedBet && data.proposition) {
                        matchedBet = MATCHED_BETS.find(function(b) {
                            return b.proposition === data.proposition;
                        });
                    }

                    // No last-resort fallback — stale proposals from old bets
                    // must NOT attach to unrelated matched bets (bug from v1.1.5)

                    if (matchedBet) {
                        PENDING_PROPOSALS[matchedBet.coinid] = {
                            outcome: data.outcome,
                            txnhex: data.txnhex,
                            sender_mxkey: data.sender_mxkey || row.SENDER_MXKEY || "",
                            sender_name: data.sender_name || row.SENDER_NAME || "",
                            randomid: row.RANDOMID
                        };
                    }
                } catch(e) {}
            });

            // Check if we can auto-settle (both sides proposed same outcome)
            autoAcceptDualProposals();
            if (callback) callback();
        });
    });
}

/**
 * Automatically co-sign a settlement when both parties proposed the same outcome.
 *
 * Scenario: Alice proposes TRUE, Bob proposes TRUE independently (before seeing
 * Alice's proposal). Both proposals are stored. When Bob's app refreshes, it
 * detects that SENT_PROPOSALS has TRUE and PENDING_PROPOSALS has TRUE from Alice.
 * It auto-cosigns Alice's proposal — no manual Accept needed.
 *
 * SAFETY: If both nodes auto-accept simultaneously, one succeeds and the other
 * fails (coin already spent). The failure is harmless — next refresh cleans up.
 *
 * SECURITY: The co-signed transaction has VERIFYOUT constraints enforced by the
 * contract. The auto-accept cannot produce a different payout than what the
 * contract allows for the declared outcome. A malicious txnhex would fail on-chain.
 *
 * Called by: refreshBetsAndProposals (above), after populating PENDING_PROPOSALS
 * Depends on: cosignAndPost, sendSettleAccept from txn.js (via app.js wrappers)
 */
function autoAcceptDualProposals() {
    Object.keys(PENDING_PROPOSALS).forEach(function(coinid) {
        var proposal = PENDING_PROPOSALS[coinid];
        if (!proposal || !proposal.txnhex) return;

        var bet = MATCHED_BETS.find(function(b) { return b.coinid === coinid; });
        if (!bet || !bet.proposition) return;

        var sent = SENT_PROPOSALS[bet.proposition];
        if (!sent) return;

        // Both sides proposed the same outcome — auto-cosign
        if (parseInt(sent.outcome) === parseInt(proposal.outcome)) {
            var outcomeLabel = parseInt(proposal.outcome) === 2 ? "VOID" :
                               parseInt(proposal.outcome) === 1 ? "TRUE" : "FALSE";
            notify("Both sides proposed " + outcomeLabel + " — auto-settling...", "ok");

            // Sign with the specific key from the coin state (not MY_PUBKEY)
            var sigKey = bet.isMyCounter ? bet.counterpk : bet.ownerpk;
            delete SENT_PROPOSALS[bet.proposition]; // Prevent re-trigger on next refresh

            cosignAndPost(proposal.txnhex, sigKey, function(ok, err) {
                if (ok) {
                    var ownerSide = bet.side;
                    var outcomeNum = parseInt(proposal.outcome);
                    var iWin = (bet.isMine && outcomeNum === ownerSide) ||
                               (bet.isMyCounter && outcomeNum !== ownerSide);
                    var resultMsg = iWin ? "You WIN — winnings incoming (~2 min)" :
                                          "You LOSE — settled at 0% fee";
                    notify("Auto-settled: " + outcomeLabel + ". " + resultMsg, iWin ? "ok" : "warn");
                    logTx("SETTLE", bet.amount || "?", iWin ? "IN" : "OUT",
                           bet.proposition || "", "Auto-settled " + outcomeLabel + " — " + resultMsg);
                    if (proposal.sender_mxkey) sendSettleAccept(proposal.sender_mxkey, coinid, bet.proposition, parseInt(proposal.outcome));

                    // Clear settle-pending flag via shared keypair (not MDSCOMMS)
                    if (bet.proposition) {
                        MDS.keypair.get("wager_settle_pending", function(val) {
                            try {
                                var sp = val && val.value ? JSON.parse(val.value) : {};
                                delete sp[bet.proposition];
                                MDS.keypair.set("wager_settle_pending", JSON.stringify(sp));
                            } catch(e) {}
                        });
                    }

                    clearProposal(proposal.randomid);
                    refreshBetsAndProposals(renderCurrentView);
                } else {
                    notify("Auto-settle: " + (err || "already settled"), "info");
                }
            });
        }
    });
}
