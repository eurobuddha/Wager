/**
 * Wager — ChainMail Messaging Layer
 *
 * Sends encrypted messages on-chain using state port 99.
 * All messages go to a fixed address. Recipients detect messages
 * via coinnotify and attempt decryption — if it decrypts, it's for them.
 *
 * Only requirement to message someone: their Maxima public key (Mx...).
 * Sender's key is automatically embedded in the encryption.
 *
 * Based on PocketShop/miniMerch proven patterns:
 * - Direct hex encoding (no URL-encode layer)
 * - getState99() handles both NOTIFYCOIN object and coins array formats
 */

/* Fixed on-chain address for all Wager ChainMail (hex for "WAGERMAIL") */
var WAGER_MAIL_ADDRESS = "0x57414745524D41494C";

/* Send amount for ChainMail carrier transaction */
var CHAINMAIL_AMOUNT = "0.001";

// -- Hex encode/decode for ChainMail payloads --

function cmTextToHex(str) {
    var hex = '';
    for (var i = 0; i < str.length; i++) {
        hex += str.charCodeAt(i).toString(16).padStart(2, '0');
    }
    return hex;
}

function cmHexToText(hex) {
    if (hex && hex.substring(0, 2) === '0x') hex = hex.substring(2);
    var text = '';
    for (var i = 0; i < hex.length; i += 2) {
        text += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    }
    return text;
}

/**
 * Extract state port 99 data from a coin's state.
 * Handles BOTH formats:
 *   - NOTIFYCOIN: state is object — coin.state[99] or coin.state['99']
 *   - coins command: state is array — [{port:99, data:'0x...'}]
 */
function getState99(state) {
    if (!state) return null;
    if (Array.isArray(state)) {
        for (var i = 0; i < state.length; i++) {
            if (state[i] && (state[i].port === 99 || state[i].port === '99') && state[i].data)
                return state[i].data;
        }
        return null;
    }
    if (typeof state === 'object') {
        return state[99] || state['99'] || null;
    }
    return null;
}

/**
 * Generate a random hex string for deduplication.
 */
function genRandomHex(len) {
    var hex = "";
    var chars = "0123456789ABCDEF";
    for (var i = 0; i < len; i++) {
        hex += chars.charAt(Math.floor(Math.random() * 16));
    }
    return hex;
}

/**
 * Get this node's Maxima details (name + mxpublickey).
 */
function getMyMaximaInfo(callback) {
    MDS.cmd("maxima", function(res) {
        if (res.status) {
            callback({
                name: res.response.name || "Anonymous",
                mxpublickey: res.response.mxpublickey
            });
        } else {
            callback(null);
        }
    });
}

/**
 * Get a fresh signing key and hex payout address.
 */
function getMyKeys(callback) {
    MDS.cmd("getaddress", function(res) {
        if (res.status) {
            callback(res.response.publickey, res.response.address);
        } else {
            callback(null, null);
        }
    });
}

/**
 * Send an encrypted ChainMail message.
 *
 * @param {string} recipientMxKey - Recipient's Maxima public key (Mx...)
 * @param {object} payload - Message data (will be JSON-serialized + encrypted)
 * @param {function} callback(success, error)
 */
function sendChainMail(recipientMxKey, payload, callback) {
    try {
        if (!payload.randomid) {
            payload.randomid = "0x" + genRandomHex(32);
        }

        // Direct hex encoding — no URL-encode layer (miniMerch/PocketShop pattern)
        var hexData = cmTextToHex(JSON.stringify(payload));

        // Encrypt with recipient's Maxima key
        MDS.cmd("maxmessage action:encrypt publickey:" + recipientMxKey + " data:" + hexData, function(encRes) {
            if (!encRes || !encRes.status) {
                MDS.log("ERROR chainmail encrypt: " + JSON.stringify(encRes));
                if (callback) callback(false, "Invalid recipient key or encryption failed");
                return;
            }

            // Build state with encrypted data in port 99
            var state = {};
            state[99] = encRes.response.data;

            // Check mode for send vs sendpoll
            MDS.cmd("checkmode", function(modeRes) {
                var locked = modeRes.response.dblocked;
                var sendCmd = locked ? "send" : "sendpoll";

                var txn = sendCmd + " amount:" + CHAINMAIL_AMOUNT +
                          " address:" + WAGER_MAIL_ADDRESS +
                          " state:" + JSON.stringify(state);

                MDS.cmd(txn, function(txnRes) {
                    if (txnRes.status) {
                        MDS.log("ChainMail sent to " + recipientMxKey.substring(0, 20) + "...");
                        if (callback) callback(true, null, false);
                    } else if (txnRes.pending) {
                        MDS.log("ChainMail pending approval for " + recipientMxKey.substring(0, 20) + "...");
                        if (callback) callback(true, null, true);
                    } else {
                        MDS.log("ERROR chainmail send: " + JSON.stringify(txnRes));
                        if (callback) callback(false, txnRes.error || "Transaction failed", false);
                    }
                });
            });
        });
    } catch (e) {
        MDS.log("ERROR chainmail exception: " + e);
        if (callback) callback(false, "" + e);
    }
}

/**
 * Attempt to decrypt a coin's state[99] data.
 * If decryption succeeds, the message was for us.
 *
 * @param {string} encryptedData - The state[99] value from a coin
 * @param {function} callback(success, message, senderMxKey)
 */
function decryptChainMail(encryptedData, callback) {
    try {
        MDS.cmd("maxmessage action:decrypt data:" + encryptedData, function(decRes) {
            if (!decRes || !decRes.status) {
                if (callback) callback(false, null, null);
                return;
            }

            if (!decRes.response || !decRes.response.message || !decRes.response.message.valid) {
                if (callback) callback(false, null, null);
                return;
            }

            var senderMxKey = decRes.response.message.mxpublickey;
            var hexData = decRes.response.message.data;

            // Direct hex-to-text decode (no URL-decode, no convert command)
            try {
                var jsonStr = cmHexToText(hexData);
                var message = JSON.parse(jsonStr);
                if (callback) callback(true, message, senderMxKey);
            } catch (e) {
                MDS.log("ERROR chainmail parse: " + e);
                if (callback) callback(false, null, null);
            }
        });
    } catch (e) {
        MDS.log("ERROR chainmail decrypt exception: " + e);
        if (callback) callback(false, null, null);
    }
}
