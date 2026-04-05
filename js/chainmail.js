/**
 * Wager — ChainMail Messaging Layer (adapted from Escrow)
 *
 * Sends encrypted messages on-chain using state port 99.
 * All messages go to a fixed address. Recipients detect messages
 * via coinnotify and attempt decryption — if it decrypts, it's for them.
 *
 * Only requirement to message someone: their Maxima public key (Mx...).
 * Sender's key is automatically embedded in the encryption.
 */

/* Fixed on-chain address for all Wager ChainMail (hex for "WAGERMAIL") */
var WAGER_MAIL_ADDRESS = "0x57414745524D41494C";

/* Send amount for ChainMail carrier transaction */
var CHAINMAIL_AMOUNT = "0.001";

/**
 * URL-safe encoding for command transport.
 */
function URLencodeString(str) {
    return encodeURIComponent(str).split("'").join("%27");
}

function URLdecodeString(str) {
    return decodeURIComponent(str).split("%27").join("'");
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
        /* Add a random ID for deduplication */
        if (!payload.randomid) {
            payload.randomid = "0x" + genRandomHex(32);
        }

        /* JSON → URL-encoded string → hex */
        var strVersion = URLencodeString(JSON.stringify(payload));

        MDS.cmd('convert from:string to:hex data:"' + strVersion + '"', function(convRes) {
            if (!convRes.status) {
                MDS.log("ERROR chainmail convert: " + JSON.stringify(convRes));
                if (callback) callback(false, "Failed to encode message");
                return;
            }

            var hexData = convRes.response.conversion;

            /* Encrypt with recipient's Maxima key */
            MDS.cmd("maxmessage action:encrypt publickey:" + recipientMxKey + " data:" + hexData, function(encRes) {
                if (!encRes.status) {
                    MDS.log("ERROR chainmail encrypt: " + JSON.stringify(encRes));
                    if (callback) callback(false, "Invalid recipient key or encryption failed");
                    return;
                }

                /* Build state with encrypted data in port 99 */
                var state = {};
                state[99] = encRes.response.data;

                /* Check mode: sendpoll for normal, send for locked nodes */
                MDS.cmd("checkmode", function(modeRes) {
                    var locked = modeRes.response.dblocked;
                    var readmode = !modeRes.response.writemode;

                    /* sendpoll doesn't work through pending if node is locked */
                    var sendCmd = locked ? "send" : "sendpoll";

                    var txn = sendCmd + " amount:" + CHAINMAIL_AMOUNT +
                              " address:" + WAGER_MAIL_ADDRESS +
                              " state:" + JSON.stringify(state);

                    MDS.cmd(txn, function(txnRes) {
                        if (txnRes.status) {
                            MDS.log("ChainMail sent to " + recipientMxKey.substring(0, 20) + "...");
                            if (callback) callback(true, null, false);
                        } else if (txnRes.pending) {
                            /* READ mode — tx is pending user approval */
                            MDS.log("ChainMail pending approval for " + recipientMxKey.substring(0, 20) + "...");
                            if (callback) callback(true, null, true);
                        } else {
                            MDS.log("ERROR chainmail send: " + JSON.stringify(txnRes));
                            if (locked && !readmode) {
                                if (callback) callback(false, "Node is locked. Unlock your node or use the Pending MiniDapp.", false);
                            } else {
                                if (callback) callback(false, txnRes.error || "Transaction failed", false);
                            }
                        }
                    });
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
            if (!decRes.status) {
                /* Not for us — ignore */
                if (callback) callback(false, null, null);
                return;
            }

            /* Check signature validity */
            if (!decRes.response.message.valid) {
                MDS.log("WARN: Invalid signature on ChainMail message");
                if (callback) callback(false, null, null);
                return;
            }

            /* Extract sender's Mx public key (for replies) */
            var senderMxKey = decRes.response.message.mxpublickey;
            var hexData = decRes.response.message.data;

            /* Hex → string → JSON */
            MDS.cmd("convert from:HEX to:string data:" + hexData, function(convRes) {
                if (!convRes.status) {
                    if (callback) callback(false, null, null);
                    return;
                }

                try {
                    var jsonStr = URLdecodeString(convRes.response.conversion);
                    var message = JSON.parse(jsonStr);
                    if (callback) callback(true, message, senderMxKey);
                } catch (e) {
                    MDS.log("ERROR chainmail parse: " + e);
                    if (callback) callback(false, null, null);
                }
            });
        });
    } catch (e) {
        MDS.log("ERROR chainmail decrypt exception: " + e);
        if (callback) callback(false, null, null);
    }
}
