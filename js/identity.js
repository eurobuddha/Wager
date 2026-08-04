/**
 * ============================================================================
 * WAGER — Identity & Key Management Module
 * ============================================================================
 *
 * PURPOSE:
 *   Manages this node's cryptographic identity on the Minima network.
 *   All signing keys, wallet addresses, and Maxima messaging keys are
 *   loaded and stored here. Other modules reference these globals to
 *   determine ownership of coins and to sign transactions.
 *
 * GLOBALS EXPORTED (used by txn.js, state.js, app.js, service.js):
 *   MY_PUBKEY    — This node's primary public key (from getaddress)
 *   MY_HEX_ADDR  — This node's hex wallet address (for receiving payouts)
 *   MY_ADDR      — This node's Mx-format address (human-readable)
 *   MY_KEYS      — Map of ALL 64 wallet public keys → true (for isMyKey lookups)
 *   MY_MXKEY     — This node's Maxima public key (for encrypted ChainMail)
 *   MY_MXNAME    — This node's Maxima display name
 *
 * FUNCTIONS EXPORTED:
 *   loadIdentity(callback)        — Load or create the primary signing identity
 *   loadMaximaIdentity(callback)  — Load Maxima messaging identity
 *   loadWalletKeys(callback)      — Load all 64 wallet keys into MY_KEYS
 *   isMyKey(pubkey)               — Check if a public key belongs to this wallet
 *   strToHex(str)                 — Convert ASCII string to 0x hex (for state ports)
 *   hexToStr(hex)                 — Convert 0x hex back to ASCII string
 *
 * SECURITY NOTES:
 *   - MY_PUBKEY is persisted in MDS.keypair to survive MiniDapp restarts.
 *     WARNING: getaddress returns a DIFFERENT random key each call.
 *     We store the first one and reuse it. If keypair is wiped (reinstall),
 *     a new key is generated. Old bets using the previous key will show
 *     isMine=false — this is expected and handled by enrichMxKeys in state.js.
 *
 *   - isMyKey checks ALL 64 wallet keys, not just MY_PUBKEY. This is critical
 *     because bet coins store the key that was active at post/fill time,
 *     which may differ from the current MY_PUBKEY after a reinstall.
 *
 *   - strToHex/hexToStr are used for state port encoding (ports 12, 15, 16, 17).
 *     Port 12 = proposition text, ports 15-17 = Maxima keys. These must round-trip
 *     losslessly for ASCII text. Non-ASCII characters will corrupt.
 *
 * DEPENDENCIES:
 *   - MDS.keypair (persistent key-value storage)
 *   - MDS.cmd("getaddress") (wallet address generation)
 *   - MDS.cmd("keys") (list all wallet public keys)
 *   - getMyMaximaInfo() from chainmail.js (Maxima identity lookup)
 *
 * LOADED BY:
 *   - index.html (browser context, before state.js and txn.js)
 *   - service.js via MDS.load("./js/identity.js") (background context)
 * ============================================================================
 */

// ============================================================================
// GLOBALS — Identity state for this node
// ============================================================================

/** Primary public key used for posting bets (stored in coin state port 0 or 8) */
var MY_PUBKEY = "";

/** Hex wallet address for receiving payouts (stored in coin state port 1 or 9) */
var MY_HEX_ADDR = "";

/** Mx-format wallet address (human-readable, for display only) */
var MY_ADDR = "";

/**
 * Map of ALL wallet public keys → true.
 * Minima wallets have 64 default keys. We load all of them so that
 * isMyKey() can identify coins from any key, not just the current MY_PUBKEY.
 * This is essential because getaddress returns a different key each call —
 * bets may have been created with any of the 64 keys.
 */
var MY_KEYS = {};

/** Maxima public key for encrypted ChainMail messaging (Mx... format) */
var MY_MXKEY = "";

/** Maxima display name (set by user in Maxima settings) */
var MY_MXNAME = "";


// ============================================================================
// HEX ENCODING — Single implementation used by all modules
// ============================================================================

/**
 * Convert an ASCII string to 0x-prefixed hex representation.
 * Used for storing proposition text (port 12) and Maxima keys (ports 15-17)
 * in on-chain state variables.
 *
 * Example: strToHex("hello") → "0x68656C6C6F"
 *
 * WARNING: Only works correctly for ASCII characters (0-127).
 * Non-ASCII will produce incorrect hex that won't round-trip through hexToStr.
 *
 * @param {string} str — ASCII string to encode
 * @returns {string} — 0x-prefixed uppercase hex string
 */
function strToHex(str) {
    var hex = "0x";
    for (var i = 0; i < str.length; i++) {
        hex += str.charCodeAt(i).toString(16).toUpperCase().padStart(2, "0");
    }
    return hex;
}

/**
 * Convert 0x-prefixed hex string back to ASCII.
 * Inverse of strToHex. Used when reading proposition text and Maxima keys
 * from on-chain coin state.
 *
 * Example: hexToStr("0x68656C6C6F") → "hello"
 *
 * @param {string} hex — Hex string, with or without 0x prefix
 * @returns {string} — Decoded ASCII string, or "" if input is empty/null
 */
function hexToStr(hex) {
    if (!hex) return "";
    if (hex.startsWith("0x")) hex = hex.substring(2);
    var str = "";
    for (var i = 0; i < hex.length; i += 2) {
        str += String.fromCharCode(parseInt(hex.substring(i, i + 2), 16));
    }
    return str;
}


// ============================================================================
// IDENTITY LOADING — Called during app initialization
// ============================================================================

/**
 * Load or create the primary signing identity for this node.
 *
 * First checks MDS.keypair for a previously stored key (survives restarts).
 * If not found, calls getaddress to generate a new one and stores it.
 *
 * IMPORTANT: getaddress returns a different random key from the 64-key wallet
 * each time it's called. We store the first one we get and reuse it forever.
 * This ensures MY_PUBKEY is consistent across sessions for the same install.
 * A MiniDapp reinstall wipes keypair storage, generating a new identity.
 *
 * Called by: initApp() in app.js, and service.js init
 * Sets: MY_PUBKEY, MY_HEX_ADDR, MY_ADDR
 *
 * @param {function} callback — Called when identity is loaded (no arguments)
 */
function loadIdentity(callback) {
    MDS.keypair.get("wager_pubkey", function(kres) {
        if (kres.status && kres.value && kres.value.length > 10) {
            // Previously stored identity found — load all three fields
            MY_PUBKEY = kres.value;
            MDS.keypair.get("wager_hexaddr", function(k2) {
                MY_HEX_ADDR = (k2.status && k2.value) ? k2.value : "";
                MDS.keypair.get("wager_miniaddr", function(k3) {
                    MY_ADDR = (k3.status && k3.value) ? k3.value : MY_HEX_ADDR;
                    if (MY_PUBKEY && MY_HEX_ADDR) { callback(); return; }
                    // Stored key exists but address missing — re-fetch
                    fetchAndStoreIdentity(callback);
                });
            });
            return;
        }
        // No stored identity — first run or reinstall
        fetchAndStoreIdentity(callback);
    });
}

/**
 * Generate a new identity from getaddress and persist it.
 * Called internally by loadIdentity when no stored identity exists.
 *
 * WARNING: This creates a NEW identity. Any bets posted with the old
 * identity will show isMine=false. The 64-key wallet still owns the old
 * keys (isMyKey will find them), but MY_PUBKEY won't match.
 *
 * @param {function} callback — Called when stored (no arguments)
 */
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

/**
 * Load this node's Maxima messaging identity.
 * Maxima is Minima's encrypted messaging layer. The MxKey is used for
 * point-to-point ChainMail communication between bettors and arbiters.
 *
 * Called by: initApp() in app.js (after loadIdentity)
 * Sets: MY_MXKEY, MY_MXNAME
 * Depends on: getMyMaximaInfo() from chainmail.js
 *
 * @param {function} callback — Called when loaded (no arguments)
 */
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

/**
 * Load ALL 64 wallet public keys into MY_KEYS map.
 *
 * This is critical for isMyKey() — the function that determines coin ownership.
 * Minima wallets have 64 default signing keys. When a bet is posted or filled,
 * the active key at that moment is stored in the coin's state (port 0 or 8).
 * After a reinstall, MY_PUBKEY changes, but the wallet still owns all 64 keys.
 * By loading all keys, we can correctly identify coins from any session.
 *
 * Called by: initApp() in app.js, and service.js init
 * Sets: MY_KEYS (map of pubkey → true)
 * Uses: MDS.cmd("keys") which returns {response: {keys: [{publickey: "0x..."}]}}
 *
 * NOTE: H2 database returns column names in UPPERCASE. The keys command
 * returns a JSON object, not SQL, so casing is as-is from Minima.
 *
 * @param {function} callback — Called when all keys loaded (no arguments)
 */
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
        // Also add MY_PUBKEY in case it's not in the keys list
        // (shouldn't happen, but defensive)
        if (MY_PUBKEY) MY_KEYS[MY_PUBKEY] = true;
        MDS.log("Wallet keys loaded: " + Object.keys(MY_KEYS).length);
        if (callback) callback();
    });
}


// ============================================================================
// KEY OWNERSHIP CHECK — Used by state.js parseBetCoin and txn.js signing
// ============================================================================

/**
 * Check if a public key belongs to this node's wallet.
 *
 * This is the fundamental ownership check. Used by:
 *   - parseBetCoin() in state.js → sets isMine, isMyCounter, isMyArb
 *   - selfSettle() in txn.js → determines which key to sign with
 *   - checkAndRefreshCoins() in service.js → determines if we can refresh
 *
 * SECURITY: This checks against ALL 64 wallet keys, not just MY_PUBKEY.
 * This prevents false negatives after reinstalls where MY_PUBKEY changes
 * but the wallet still owns the key stored in the coin state.
 *
 * @param {string} pubkey — The public key to check (0x hex format)
 * @returns {boolean} — true if this wallet owns the key
 */
function isMyKey(pubkey) {
    return MY_KEYS[pubkey] === true;
}
