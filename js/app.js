/**
 * ============================================================================
 * WAGER — Application UI Module
 * ============================================================================
 *
 * PURPOSE:
 *   UI rendering, user actions, and event dispatch.
 *   No business logic — delegates to identity.js, state.js, txn.js.
 *
 * DEPENDS ON:
 *   contract.js, chainmail.js, db.js, identity.js, state.js, txn.js
 *   (all loaded before this file in index.html)
 * ============================================================================
 */

// -- Views --
var CURRENT_VIEW = "markets";
// PENDING_PROPOSALS, SENT_PROPOSALS, OPEN_BETS, MATCHED_BETS — from state.js
// MY_PUBKEY, MY_HEX_ADDR, MY_MXKEY, MY_MXNAME — from identity.js
// ESCROW_RATE, REFRESH_AGE — from state.js

// -- Dual notification: persistent log + urgent toasts --
// The log panel (always visible at top) is the source of truth.
// Toasts appear for urgent events (proposals, settlements) and auto-dismiss.

function notify(msg, type) {
    type = type || "info";

    // 1. Always write to persistent log panel
    var logEntries = document.getElementById("logEntries");
    if (logEntries) {
        var now = new Date();
        var ts = now.getHours().toString().padStart(2,"0") + ":" + now.getMinutes().toString().padStart(2,"0");
        var row = document.createElement("div");
        row.className = "logrow logrow--" + type;
        row.innerHTML = '<span class="logrow__time">' + ts + '</span><span class="logrow__msg">' + esc(msg) + '</span>';
        // Prepend (newest first)
        if (logEntries.firstChild) logEntries.insertBefore(row, logEntries.firstChild);
        else logEntries.appendChild(row);
        // Cap at 50 entries
        while (logEntries.children.length > 50) logEntries.removeChild(logEntries.lastChild);
    }

    // 2. For urgent events, also show a toast (auto-dismiss after 8s)
    var urgent = (type === "ok" || type === "err" || type === "pending");
    if (urgent) {
        var container = document.getElementById("toastContainer");
        if (container) {
            var toast = document.createElement("div");
            toast.className = "toast toast--" + type;
            toast.innerHTML = '<span>' + esc(msg) + '</span>';
            container.appendChild(toast);
            setTimeout(function() {
                toast.classList.add("removing");
                setTimeout(function() { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
            }, 8000);
            while (container.children.length > 3) container.removeChild(container.firstChild);
        }
    }

    // 3. Persist to DB
    logActivity(msg, type);
}

// -- Pending Transaction Handling --
var PENDING_TXID = null;
var PENDING_CALLBACK = null;

function handlePending(txid, cb) {
    PENDING_TXID = txid;
    PENDING_CALLBACK = cb;
    notify("PENDING — Open Pending Actions in MiniHub to approve", "pending");
}

function completePending() {
    if (!PENDING_TXID) return;
    var txid = PENDING_TXID;
    var cb = PENDING_CALLBACK;
    PENDING_TXID = null;
    PENDING_CALLBACK = null;
    notify("Pending approved — completing transaction...", "info");
    MDS.cmd("txnbasics id:" + txid, function(br) {
        if (!br || !br.status) {
            notify("txnbasics failed: " + (br ? br.error : "no response"), "err");
            MDS.cmd("txndelete id:" + txid);
            if (cb) cb(false, "txnbasics failed after pending");
            return;
        }
        MDS.cmd("txnpost id:" + txid, function(pr) {
            MDS.cmd("txndelete id:" + txid);
            if (pr && pr.status) {
                notify("Transaction posted! Waiting for confirmation...", "ok");
                if (cb) cb(true, null);
            } else {
                notify("Post failed: " + (pr ? pr.error : "no response"), "err");
                if (cb) cb(false, pr ? pr.error : "post failed");
            }
        });
    });
}

function isPending(res) {
    if (res && res.pending === true) return true;
    if (res && res.status === false && res.error && res.error.indexOf("pending") >= 0) return true;
    return false;
}

// -- Init --
MDS.init(function(msg) {
    if (msg.event === "inited") initApp();
    if (msg.event === "NEWBLOCK") {
        updateBlock(msg);
        if (PENDING_TXID) completePending();
        if (DB_READY) {
            refreshBetsAndProposals(function() {
                if (CURRENT_VIEW !== "post") renderCurrentView();
            });
            refreshBalance();
        }
    }
    if (msg.event === "NEWBALANCE") {
        if (DB_READY) {
            refreshBetsAndProposals(function() {
                if (CURRENT_VIEW !== "post") renderCurrentView();
            });
            refreshBalance();
        }
    }
    // REGRESSION FIX (v2.0.5): Restore NOTIFYCOIN handler from v1.6.1.
    // service.js also handles NOTIFYCOIN but cannot update the browser UI.
    // app.js must process SETTLE_PROPOSE in real-time so the Accept/Reject
    // buttons appear immediately — not 10 seconds later on the next timer.
    if (msg.event === "NOTIFYCOIN") {
        var ncoin = msg.data && msg.data.coin;
        if (ncoin) {
            var ncAddr = ncoin.address || (msg.data && msg.data.address) || "";
            if (ncAddr === WAGER_MAIL_ADDRESS) {
                var ns99 = getState99(ncoin.state);
                if (ns99) {
                    decryptChainMail(ns99, function(success, message, senderMxKey) {
                        if (success && message) {
                            if (message.type === "SETTLE_PROPOSE" && message.betid) {
                                messageExists(message.randomid, function(exists) {
                                    if (!exists) {
                                        notify("Settlement proposal received!", "ok");
                                        insertMessage({
                                            randomid: message.randomid || "0x" + Date.now(),
                                            betid: message.betid,
                                            type: message.type,
                                            sender_mxkey: senderMxKey || "",
                                            sender_name: message.sender_name || "",
                                            data: JSON.stringify(message),
                                            direction: "received"
                                        });
                                        // Refresh immediately so Accept/Reject buttons appear
                                        refreshBetsAndProposals(renderCurrentView);
                                    }
                                });
                            }
                        }
                    });
                }
            }
        }
    }
    // REGRESSION FIX (v2.0.5): Chain scan→refresh properly.
    // v2.0.4 ran scanForChainMail() and refreshBetsAndProposals() in parallel,
    // so proposals inserted by scan were missed by refresh (async race).
    // Now: scan first, refresh INSIDE the scan callback via the new
    // refreshBetsAndProposals call added to scanForChainMail itself.
    if (msg.event === "MDS_TIMER_10SECONDS") {
        if (DB_READY) {
            scanForChainMail();
            updateChatPreviews();
        }
    }
});

// ChainMail scanning — app.js processes all message types from mail coins
var PROCESSED_MAIL = {};

function scanForChainMail() {
    if (!WAGER_MAIL_ADDRESS) return;
    MDS.cmd("coins address:" + WAGER_MAIL_ADDRESS, function(res) {
        if (!res || !res.status || !res.response) return;
        // Compute age from coin.created and CURRENT_BLOCK (coins response may lack .age)
        var recent = res.response.filter(function(c) {
            if (c.spent) return false;
            var age = parseInt(c.age);
            if (isNaN(age) && CURRENT_BLOCK > 0 && c.created) age = CURRENT_BLOCK - parseInt(c.created);
            if (isNaN(age)) return true;
            return age < 50;
        });
        recent.forEach(function(coin) {
            if (PROCESSED_MAIL[coin.coinid]) return;
            var s99 = getState99(coin.state);
            if (s99) {
                PROCESSED_MAIL[coin.coinid] = true;
                decryptChainMail(s99, function(success, message, senderMxKey) {
                    if (success && message && message.randomid) {
                        messageExists(message.randomid, function(exists) {
                            if (!exists) {
                                if (!message.proposition && message.betid) {
                                    var mb = MATCHED_BETS.find(function(b) { return b.coinid === message.betid; });
                                    if (mb) message.proposition = mb.proposition;
                                }
                                insertMessage({
                                    randomid: message.randomid,
                                    betid: message.betid || "",
                                    type: message.type,
                                    sender_mxkey: senderMxKey || "",
                                    sender_name: message.sender_name || "",
                                    data: JSON.stringify(message),
                                    direction: "received"
                                });
                                // Notify user for each message type (v2.0.6: show all events)
                                // Each type shows a clear, actionable message on the noticeboard.
                                var prop = message.proposition || "";
                                var propShort = prop.length > 30 ? prop.substring(0, 30) + "..." : prop;
                                var senderName = message.sender_name || "Bettor";

                                if (message.type === "SETTLE_PROPOSE") {
                                    var outcomeWord = parseInt(message.outcome) === 1 ? "TRUE" : parseInt(message.outcome) === 0 ? "FALSE" : "VOID";
                                    notify("Proposal: " + outcomeWord + " — " + propShort + " — Accept or Reject", "ok");
                                    refreshBetsAndProposals(renderCurrentView);
                                } else if (message.type === "SETTLE_ACCEPT") {
                                    // Determine win/loss for the proposer
                                    var saBet = MATCHED_BETS.find(function(b) { return b.proposition === (message.proposition || prop); });
                                    if (saBet) {
                                        var saOutcome = parseInt(message.outcome || 0);
                                        var saOwnerSide = saBet.side;
                                        var saIWin = (saBet.isMine && saOutcome === saOwnerSide) || (saBet.isMyCounter && saOutcome !== saOwnerSide);
                                        var saEsc = 1 + ESCROW_RATE;
                                        var saMyLock = saBet.isMine ? parseFloat(saBet.ownerstake || "0") : parseFloat(saBet.amount) - parseFloat(saBet.ownerstake || "0");
                                        var saTheirLock = parseFloat(saBet.amount) - saMyLock;
                                        var saMyBet = saMyLock / saEsc;
                                        var saTheirBet = saTheirLock / saEsc;
                                        var saProfit = saIWin ? "+" + saTheirBet.toFixed(2) : "-" + saMyBet.toFixed(2);
                                        WIN_LOSS_BANNER = { type: saIWin ? "win" : "loss", prop: saBet.proposition || propShort, amount: saProfit + " MINIMA", fee: "0%", escrow: "returned" };
                                        notify((saIWin ? "YOU WON! " : "You lost. ") + saProfit + " MINIMA — " + propShort, saIWin ? "ok" : "err");
                                    } else {
                                        notify("Settlement accepted! " + propShort + " — 0% fee, confirming on-chain...", "ok");
                                    }
                                    refreshBetsAndProposals(renderCurrentView);
                                } else if (message.type === "SETTLE_REJECT") {
                                    notify("Settlement rejected — " + propShort + " — escalated to arbiter", "warn");
                                    refreshBetsAndProposals(renderCurrentView);
                                } else if (message.type === "BET_MATCHED") {
                                    notify("Bet matched! " + propShort + " — pot: " + (message.pot || "?") + " MINIMA", "ok");
                                    refreshBetsAndProposals(renderCurrentView);
                                } else if (message.type === "BET_CREATED") {
                                    notify("New bet — you are arbiter for: " + propShort, "info");
                                } else if (message.type === "DISPUTE") {
                                    notify("DISPUTE — you must resolve: " + propShort, "warn");
                                    refreshBetsAndProposals(renderCurrentView);
                                } else if (message.type === "CHAT_MESSAGE") {
                                    notify(senderName + ": " + (message.message || "").substring(0, 50), "info");
                                    updateChatPreviews();
                                }
                            }
                        });
                    }
                });
            }
        });
    });
}

function initApp() {
    notify("Registering contract...", "info");
    registerContract(function() {
        notify("Loading identity...", "info");
        loadIdentity(function() {
            notify("Loading wallet keys...", "info");
            loadWalletKeys(function() {
                notify("Loading Maxima identity...", "info");
                loadMaximaIdentity(function() {
                notify("Initializing database...", "info");
                initDB(function() {
                    // Register coinnotify for ChainMail (mInbox pattern)
                    MDS.cmd("coinnotify action:add address:" + WAGER_MAIL_ADDRESS);
                    MDS.log("Openly v2.7.0 ready. Contract=" + WAGER_SCRIPT_ADDRESS);
                    notify("Openly v2.7.0 ready", "ok");
                    refreshBalance();
                    refreshBetsAndProposals(function() { renderCurrentView(); });
                    // Show onboarding for first-time users
                    showOnboardingIfNeeded();
                });
                });
            });
        });
    });
    MDS.cmd("block", function(res) {
        if (res.status) {
            CURRENT_BLOCK = parseInt(res.response.block) || 0;
            var el = document.getElementById("blockHeight");
            if (el) el.innerText = "#" + CURRENT_BLOCK;
        }
    });
}

function updateBlock(msg) {
    try {
        CURRENT_BLOCK = parseInt(msg.data.txpow.header.block) || CURRENT_BLOCK;
        var el = document.getElementById("blockHeight");
        if (el) el.innerText = "#" + CURRENT_BLOCK;
    } catch(e) {}
}

function refreshBalance() {
    MDS.cmd("balance", function(res) {
        if (!res.status) return;
        var bal = "0";
        for (var i = 0; i < res.response.length; i++) {
            if (res.response[i].tokenid === "0x00") { bal = res.response[i].sendable; break; }
        }
        var el = document.getElementById("balance");
        if (el) el.innerText = parseFloat(bal).toFixed(2) + " M";
    });
}

// -- Navigation --

function showView(view) {
    CURRENT_VIEW = view;
    // Update nav active state
    document.querySelectorAll(".topnav__tab").forEach(function(t) { t.classList.remove("active"); });
    var tab = document.querySelector('.topnav__tab[data-view="' + view + '"]');
    if (tab) tab.classList.add("active");
    // Sub-views: arbiter/history → highlight "more", activity → highlight "log"
    if (view === "arbiter" || view === "history") {
        var mt = document.querySelector('.topnav__tab[data-view="more"]');
        if (mt) mt.classList.add("active");
    }
    if (view === "activity") {
        var lt = document.querySelector('.topnav__tab[data-view="log"]');
        if (lt) lt.classList.add("active");
    }
    renderCurrentView();
}

// Track selected matched bet for desktop chat panel
var SELECTED_BET_COINID = "";

// Win/loss banner — shown at top of My Bets until dismissed
// { type: "win"|"loss", prop: "...", amount: "+10.00"|"-5.00", fee: "0%"|"10%", escrow: "returned"|"forfeit" }
var WIN_LOSS_BANNER = null;

// Desktop mode: manual toggle. Starts off (mobile view).
var DESKTOP_ON = false;

function isDesktop() { return DESKTOP_ON; }

function toggleDesktopMode() {
    DESKTOP_ON = !DESKTOP_ON;
    var main = document.getElementById("mainContent");
    if (main) main.className = DESKTOP_ON ? "desktop-dash" : "main";
    renderCurrentView();
    var btn = document.getElementById("desktopToggle");
    if (btn) { if (DESKTOP_ON) btn.classList.add("active"); else btn.classList.remove("active"); }
}

function renderCurrentView() {
    var main = document.getElementById("mainContent");
    if (!main) return;

    // Desktop: render all 4 panes simultaneously (tmux-style dashboard)
    if (isDesktop()) {
        renderDesktopDashboard(main);
        return;
    }

    // Mobile: render single active tab
    if (CURRENT_VIEW === "markets") renderMarketsView(main);
    else if (CURRENT_VIEW === "post") renderPostView(main);
    else if (CURRENT_VIEW === "mybets") renderMyBetsView(main);
    else if (CURRENT_VIEW === "arbiter") renderArbiterView(main);
    else if (CURRENT_VIEW === "history") renderHistoryView(main);
    else if (CURRENT_VIEW === "activity") renderActivityView(main);
    else if (CURRENT_VIEW === "more") renderMoreView(main);
    else if (CURRENT_VIEW === "housekeeping") renderHousekeepingView(main);
}

/**
 * Desktop 4-pane dashboard: Chat | Activity (top), Markets | My Bets (bottom).
 * Tmux-style draggable dividers. Chat shows conversation for selected matched bet.
 * Bottom nav hidden via CSS media query.
 */
function renderDesktopDashboard(main) {
    // Build the 4 panes
    var chatHtml = renderChatPanelHtml();
    var activityHtml = renderActivityPanelHtml();
    var marketsHtml = renderMarketsPanelHtml();
    var mybetsHtml = renderMyBetsPanelHtml();

    main.className = "desktop-dash";
    main.innerHTML =
        '<div class="dd-panes" id="ddPanes">' +
            '<div class="dd-row dd-row--top" id="ddTop">' +
                '<div class="dd-pane" id="ddChat">' +
                    '<div class="dd-ph">Chat</div>' +
                    '<div class="dd-pb" id="ddChatBody">' + chatHtml + '</div>' +
                '</div>' +
                '<div class="dd-div-v" id="ddDivTV"></div>' +
                '<div class="dd-pane" style="flex:1">' +
                    '<div class="dd-ph">Activity</div>' +
                    '<div class="dd-pb">' + activityHtml + '</div>' +
                '</div>' +
            '</div>' +
            '<div class="dd-div-h" id="ddDivH">' +
                '<div class="dd-center" id="ddCenter"></div>' +
            '</div>' +
            '<div class="dd-row dd-row--bot" id="ddBot">' +
                '<div class="dd-pane" id="ddMarkets">' +
                    '<div class="dd-ph">Markets <span onclick="openPostInDesktop()" style="color:var(--purple);cursor:pointer;font-size:10px;font-weight:600">+ Post new</span></div>' +
                    '<div class="dd-pb">' + marketsHtml + '</div>' +
                '</div>' +
                '<div class="dd-div-v" id="ddDivBV"></div>' +
                '<div class="dd-pane" style="flex:1">' +
                    '<div class="dd-ph">My Bets</div>' +
                    '<div class="dd-pb">' + mybetsHtml + '</div>' +
                '</div>' +
            '</div>' +
        '</div>';

    // Init tmux resize after DOM is ready
    setTimeout(initDesktopResize, 50);
    setTimeout(updateChatPreviews, 100);
    setTimeout(function() {
        // Position center handle at intersection
        var chat = document.getElementById("ddChat");
        var center = document.getElementById("ddCenter");
        if (chat && center) center.style.left = (chat.offsetWidth - 8) + "px";
    }, 60);
}

function renderChatPanelHtml() {
    // Find the selected matched bet (or first one)
    var myMatched = MATCHED_BETS.filter(function(b) { return b.isMine || b.isMyCounter; });
    if (myMatched.length === 0) return '<div style="color:var(--muted);text-align:center;padding:20px;font-size:12px">No matched bets — chat appears when a bet is live</div>';

    var bet = myMatched.find(function(b) { return b.coinid === SELECTED_BET_COINID; }) || myMatched[0];
    SELECTED_BET_COINID = bet.coinid;

    var escapedProp = (bet.proposition || "").replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    var cid = bet.coinid.substring(2, 18);

    var html = '<div style="font-size:10px;font-weight:700;padding:4px 0 3px;border-bottom:1px solid var(--border);margin-bottom:4px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><strong style="color:var(--text)">' + esc(bet.proposition || "Bet") + '</strong></div>';
    html += '<div class="chatbox__messages" id="chatmsgs_' + cid + '" style="flex:1;overflow-y:auto"></div>';
    html += '<div class="chatbox__input" style="padding:6px 0 0"><input class="chatbox__field" id="chatin_' + cid + '" placeholder="Message..." data-coinid="' + bet.coinid + '" data-prop="' + escapedProp + '" onkeydown="if(event.key===\'Enter\')sendChatDirect(this);"><button class="chatbox__send" onclick="sendChatDirect(document.getElementById(\'chatin_' + cid + '\'))">›</button></div>';
    return html;
}

function renderActivityPanelHtml() {
    var el = document.getElementById("logEntries");
    if (!el) return '';
    // Clone current log entries
    return el.innerHTML;
}

function renderMarketsPanelHtml() {
    var html = '';
    if (OPEN_BETS.length === 0) {
        html += '<div style="color:var(--muted);text-align:center;padding:20px;font-size:12px">No active markets — post the first</div>';
    } else {
        var markets = {};
        OPEN_BETS.forEach(function(bet) {
            var key = bet.proposition || bet.coinid;
            if (!markets[key]) markets[key] = { prop: bet.proposition, yesBets: [], noBets: [] };
            if (bet.side === 1) markets[key].yesBets.push(bet);
            else markets[key].noBets.push(bet);
        });
        var keys = Object.keys(markets);
        for (var k = 0; k < keys.length; k++) {
            html += renderQuestionCard(markets[keys[k]]);
        }
    }
    return html;
}

function renderMyBetsPanelHtml() {
    var myMatched = MATCHED_BETS.filter(function(b) { return b.isMine || b.isMyCounter; });
    var mine = OPEN_BETS.filter(function(b) { return b.isMine; });
    var html = '';

    if (myMatched.length === 0 && mine.length === 0) {
        html += '<div style="color:var(--muted);text-align:center;padding:20px;font-size:12px">No bets yet</div>';
    }
    myMatched.forEach(function(bet) { html += renderLiveBet(bet); });
    mine.forEach(function(bet) {
        var escRate = 1 + ESCROW_RATE;
        var betAmt = parseFloat(bet.amount) / escRate;
        var wantAmt = parseFloat(bet.wantstake || "0") / escRate;
        var side = bet.side === 1 ? "TRUE" : "FALSE";
        html += '<div class="livebet" style="opacity:0.7"><div class="livebet__tag livebet__tag--open">Open — waiting</div>';
        html += '<div class="livebet__question" style="font-size:13px">' + esc(bet.proposition || "Bet") + '</div>';
        html += '<div class="livebet__stakes" style="padding:2px 18px 8px"><div class="livebet__row"><dt>You</dt><dd style="color:var(--' + (side === "TRUE" ? "true" : "false") + ')">' + side + ' · ' + betAmt.toFixed(2) + '</dd></div></div>';
        html += '<div style="padding:4px 18px 10px"><button class="btn btn--ghost btn--sm" onclick="doCancel(\'' + bet.coinid + '\')">Cancel</button></div></div>';
    });
    return html;
}

function openPostInDesktop() {
    if (isDesktop()) {
        // Render post form inside the Markets pane
        var mp = document.querySelector("#ddMarkets .dd-pb");
        if (mp) {
            var wrapper = { innerHTML: "" };
            renderPostView(wrapper);
            mp.innerHTML = wrapper.innerHTML + '<hr style="border:none;border-top:1px solid rgba(255,255,255,0.05);margin:12px 0"><div style="font-size:10px;color:var(--muted);cursor:pointer;text-align:center;padding:4px" onclick="renderCurrentView()">Back to Markets</div>';
        }
    } else {
        showView("post");
    }
}

function selectBetForChat(coinid) {
    SELECTED_BET_COINID = coinid;
    var chatBody = document.getElementById("ddChatBody");
    if (chatBody) {
        chatBody.innerHTML = renderChatPanelHtml();
        setTimeout(updateChatPreviews, 50);
    }
}

/**
 * Tmux-style resize for desktop dashboard.
 * Horizontal divider: drag top/bottom row heights.
 * Vertical dividers: drag left/right pane widths.
 * Center handle: drag all at once. Double-click to reset 50/50.
 */
function initDesktopResize() {
    var ddTop = document.getElementById("ddTop");
    var ddChat = document.getElementById("ddChat");
    var ddMarkets = document.getElementById("ddMarkets");
    var ddDivH = document.getElementById("ddDivH");
    var ddDivTV = document.getElementById("ddDivTV");
    var ddDivBV = document.getElementById("ddDivBV");
    var ddCenter = document.getElementById("ddCenter");
    var ddPanes = document.getElementById("ddPanes");
    if (!ddPanes) return;

    var mode = null;

    function updateCenterPos() {
        if (ddChat && ddCenter) ddCenter.style.left = (ddChat.offsetWidth - 8) + "px";
    }

    ddDivH.addEventListener("mousedown", function(e) { if (e.target !== ddCenter) { mode = "h"; e.preventDefault(); } });
    ddDivTV.addEventListener("mousedown", function(e) { mode = "tv"; e.preventDefault(); });
    ddDivBV.addEventListener("mousedown", function(e) { mode = "bv"; e.preventDefault(); });
    ddCenter.addEventListener("mousedown", function(e) { mode = "center"; e.preventDefault(); });

    ddCenter.addEventListener("dblclick", function() {
        ddTop.style.height = "50%"; ddTop.style.flex = "none";
        ddChat.style.width = "50%"; ddChat.style.flex = "none";
        ddMarkets.style.width = "50%"; ddMarkets.style.flex = "none";
        updateCenterPos();
    });

    document.addEventListener("mousemove", function(e) {
        if (!mode) return;
        var r = ddPanes.getBoundingClientRect();
        if (mode === "h" || mode === "center") {
            var yp = ((e.clientY - r.top) / r.height) * 100;
            yp = Math.max(15, Math.min(70, yp));
            ddTop.style.height = yp + "%"; ddTop.style.flex = "none";
        }
        if (mode === "tv" || mode === "center") {
            var tr = ddTop.getBoundingClientRect();
            var xp = ((e.clientX - tr.left) / tr.width) * 100;
            xp = Math.max(20, Math.min(75, xp));
            ddChat.style.width = xp + "%"; ddChat.style.flex = "none";
        }
        if (mode === "bv" || mode === "center") {
            var br = document.getElementById("ddBot").getBoundingClientRect();
            var xp = ((e.clientX - br.left) / br.width) * 100;
            xp = Math.max(20, Math.min(75, xp));
            ddMarkets.style.width = xp + "%"; ddMarkets.style.flex = "none";
        }
        requestAnimationFrame(updateCenterPos);
    });

    document.addEventListener("mouseup", function() { mode = null; updateCenterPos(); });
    window.addEventListener("resize", function() { updateCenterPos(); });
}

// "More" menu — links to Arbiter, History, Activity Log
function renderMoreView(el) {
    var arbCount = MATCHED_BETS.filter(function(b) { return b.isMyArb; }).length;
    var html = '<h2>More</h2>';
    html += '<div style="display:flex;flex-direction:column;gap:8px;">';
    html += '<div class="qcard" style="cursor:pointer" onclick="showView(\'arbiter\')"><div class="qcard__head"><div class="qcard__question">Arbiter' + (arbCount > 0 ? ' <span style="color:var(--gold)">(' + arbCount + ' pending)</span>' : '') + '</div><div class="qcard__meta"><span>Resolve disputed bets</span></div></div></div>';
    html += '<div class="qcard" style="cursor:pointer" onclick="showView(\'history\')"><div class="qcard__head"><div class="qcard__question">History</div><div class="qcard__meta"><span>Won / Lost / Fees</span></div></div></div>';
    html += '<div class="qcard" style="cursor:pointer" onclick="showView(\'activity\')"><div class="qcard__head"><div class="qcard__question">Activity Log</div><div class="qcard__meta"><span>All system messages</span></div></div></div>';
    html += '<div class="qcard" style="cursor:pointer" onclick="showView(\'housekeeping\')"><div class="qcard__head"><div class="qcard__question">Housekeeping</div><div class="qcard__meta"><span>Clear stuck transactions</span></div></div></div>';
    html += '</div>';
    el.innerHTML = html;
}

// -- Refresh bets + pending proposals, then callback --
// refreshBetsAndProposals and autoAcceptDualProposals — defined in state.js
// (renderBetCard + toggleCard removed in v2.1.0 — replaced by renderQuestionCard + renderLiveBet)

function renderMarketsView(el) {
    var html = '<h2>Markets</h2>';

    // Show matched bets first (most important — active bets need attention)
    var myMatched = MATCHED_BETS.filter(function(b) { return b.isMine || b.isMyCounter || b.isMyArb; });
    if (myMatched.length > 0) {
        myMatched.forEach(function(bet) { html += renderLiveBet(bet); });
    }

    if (OPEN_BETS.length === 0 && myMatched.length === 0) {
        html += '<div class="empty">No active markets — post the first</div>';
    } else if (OPEN_BETS.length > 0) {
        // Group open bets by proposition → show as question cards with odds bars
        var markets = {};
        OPEN_BETS.forEach(function(bet) {
            var key = bet.proposition || bet.coinid;
            if (!markets[key]) markets[key] = { prop: bet.proposition, yesBets: [], noBets: [] };
            if (bet.side === 1) markets[key].yesBets.push(bet);
            else markets[key].noBets.push(bet);
        });

        if (myMatched.length > 0) html += '<h2 style="margin-top:8px">Open Bets</h2>';

        var keys = Object.keys(markets);
        for (var k = 0; k < keys.length; k++) {
            var m = markets[keys[k]];
            html += renderQuestionCard(m);
        }
    }
    el.innerHTML = html;
    // Update chat previews after render
    setTimeout(updateChatPreviews, 100);
}

/**
 * Render a market card for the Markets view.
 *
 * Shows proposition, TRUE/FALSE odds bar, market format, position, actions.
 * Market format: "TRUE X — FALSE Y | Size Z | Spread X-Y"
 * The odds bar shows TRUE and FALSE totals proportionally (green/red pill).
 * Amounts shown WITHOUT escrow — escrow is an implementation detail.
 */
function renderQuestionCard(market) {
    var escRate = 1 + ESCROW_RATE;

    // Calculate per-side: bet amounts (stakes) and want amounts (asks)
    // Stakes = what each side put up. Wants = what each side asks from the counter.
    // The odds bar shows WANTS (the price to take each side), not stakes.
    var trueStake = 0, falseStake = 0;   // total staked per side
    var trueWants = 0, falseWants = 0;   // what each side is asking
    var bestTrue = null, bestFalse = null;
    market.yesBets.forEach(function(b) {
        var bt = parseFloat(b.amount) / escRate;
        var wt = parseFloat(b.wantstake || "0") / escRate;
        trueStake += bt;
        trueWants += wt;
        if (!bestTrue || bt > parseFloat(bestTrue.amount) / escRate) bestTrue = b;
    });
    market.noBets.forEach(function(b) {
        var bt = parseFloat(b.amount) / escRate;
        var wt = parseFloat(b.wantstake || "0") / escRate;
        falseStake += bt;
        falseWants += wt;
        if (!bestFalse || bt > parseFloat(bestFalse.amount) / escRate) bestFalse = b;
    });

    // Bet size = the larger side's stake (common reference point)
    var betSize = Math.max(trueStake, falseStake);
    if (betSize === 0) betSize = trueStake || falseStake;

    // Am I in this market?
    var myBet = null;
    var mySide = "";
    market.yesBets.concat(market.noBets).forEach(function(b) {
        if (b.isMine) { myBet = b; mySide = b.side === 1 ? "TRUE" : "FALSE"; }
    });

    var betCount = market.yesBets.length + market.noBets.length;

    var html = '<div class="qcard">';

    // Proposition + market format: "TRUE [wants] — FALSE [wants] | Size [stake]"
    html += '<div class="qcard__head">';
    html += '<div class="qcard__question">' + esc(market.prop || "Unnamed") + '</div>';
    html += '<div class="qcard__meta">';
    // Market format shows what each side WANTS — the price to take each side
    var trueAsk = trueWants > 0 ? fmtAmt(trueWants) : "—";
    var falseAsk = falseWants > 0 ? fmtAmt(falseWants) : "—";
    html += '<span>TRUE ' + trueAsk + ' — FALSE ' + falseAsk + '</span>';
    if (betSize > 0) html += '<span>in ' + fmtAmt(betSize) + '</span>';
    // Odds ratios — the universal betting language
    if (trueWants > 0 && falseWants > 0) {
        var trueOdds = calcOdds(trueStake, trueWants);
        var falseOdds = calcOdds(falseStake, falseWants);
        html += '<span style="color:var(--true)">' + trueOdds + '</span>';
        html += '<span style="color:var(--false)">' + falseOdds + '</span>';
    } else if (trueWants > 0) {
        html += '<span style="color:var(--true)">' + calcOdds(trueStake, trueWants) + '</span>';
    } else if (falseWants > 0) {
        html += '<span style="color:var(--false)">' + calcOdds(falseStake, falseWants) + '</span>';
    }
    html += '<span>' + betCount + ' bet' + (betCount !== 1 ? 's' : '') + '</span>';
    html += '</div></div>';

    // Odds bar — proportional to WANTS (the price to take each side)
    html += '<div class="oddsbar">';
    if (trueWants > 0) {
        html += '<div class="oddsbar__yes" style="flex:' + Math.max(trueWants, 0.5) + '">TRUE ' + fmtAmt(trueWants) + '</div>';
    } else if (trueStake > 0) {
        html += '<div class="oddsbar__yes" style="flex:' + Math.max(trueStake, 0.5) + '">TRUE ' + fmtAmt(trueStake) + '</div>';
    } else {
        html += '<div class="oddsbar__open">Needs TRUE</div>';
    }
    if (falseWants > 0) {
        html += '<div class="oddsbar__no" style="flex:' + Math.max(falseWants, 0.5) + '">FALSE ' + fmtAmt(falseWants) + '</div>';
    } else if (falseStake > 0) {
        html += '<div class="oddsbar__no" style="flex:' + Math.max(falseStake, 0.5) + '">FALSE ' + fmtAmt(falseStake) + '</div>';
    } else {
        html += '<div class="oddsbar__open">Needs FALSE</div>';
    }
    html += '</div>';

    // Your position — bet and profit (not total pot)
    if (myBet) {
        var myAmt = parseFloat(myBet.amount) / escRate;
        var myWantAmt = parseFloat(myBet.wantstake || "0") / escRate;
        var myOdds = calcOdds(myAmt, myWantAmt);
        var myMult = myWantAmt > 0 && myAmt > 0 ? (myWantAmt / myAmt) : 0;
        var multStr = myMult > 0 ? (myMult % 1 === 0 ? myMult.toFixed(0) : myMult.toFixed(1)) + 'x' : '';
        html += '<div class="qcard__yours">';
        html += '<div class="qcard__dot qcard__dot--' + (mySide === "TRUE" ? "yes" : "no") + '"></div>';
        html += '<span>YOURS: ' + mySide + ' ' + fmtAmt(myAmt) + ' wants ' + fmtAmt(myWantAmt) + ' | ' + multStr + ' | ' + myOdds + '</span>';
        html += '</div>';
    }

    // Actions: Counter TRUE / Counter FALSE / Cancel
    html += '<div class="qcard__actions">';
    if (myBet) {
        html += '<button class="btn btn--ghost btn--sm" onclick="event.stopPropagation();doCancel(\'' + myBet.coinid + '\')">Cancel</button>';
    }
    // Counter buttons: countering a TRUE bet = you bet FALSE (red). Countering FALSE = you bet TRUE (green).
    if (!myBet || !myBet.isMyArb) {
        if (bestTrue && !bestTrue.isMine) {
            html += '<button class="btn btn--no" onclick="event.stopPropagation();doCounter(\'' + bestTrue.coinid + '\')">Counter FALSE</button>';
        }
        if (bestFalse && !bestFalse.isMine) {
            html += '<button class="btn btn--yes" onclick="event.stopPropagation();doCounter(\'' + bestFalse.coinid + '\')">Counter TRUE</button>';
        }
    }
    html += '</div>';

    html += '</div>';
    return html;
}

/**
 * Render a live/matched bet card.
 * Shows: status tag, question, stakes, settlement, chat.
 */
function renderLiveBet(bet) {
    var isOpen = bet.phase === 0;
    var escRate = 1 + ESCROW_RATE;
    var locked = parseFloat(bet.amount);

    // Figure out who I am
    var iAmOwner = bet.isMine;
    var iAmCounter = bet.isMyCounter;
    var iAmArb = bet.isMyArb;
    var mySide = (bet.side === 1 && iAmOwner) || (bet.side === 0 && iAmCounter) ? "TRUE" : "FALSE";
    var myStake, theirStake;
    if (!isOpen) {
        var osLock = parseFloat(bet.ownerstake || "0");
        var csLock = locked - osLock;
        myStake = (iAmOwner ? osLock : csLock) / escRate;
        theirStake = (iAmOwner ? csLock : osLock) / escRate;
    }

    // On desktop, clicking a live bet selects it for the chat panel
    var isSelected = (bet.coinid === SELECTED_BET_COINID);
    var html = '<div class="livebet' + (isSelected ? ' livebet--selected' : '') + '" onclick="selectBetForChat(\'' + bet.coinid + '\')" style="cursor:pointer">';

    // Status tag with pulsing dot
    html += '<div class="livebet__tag livebet__tag--live"><div class="livebet__pulse"></div>Live bet</div>';

    // Question
    html += '<div class="livebet__question">' + esc(bet.proposition || "Bet") + '</div>';

    // Stakes
    html += '<div class="livebet__stakes">';
    html += '<div class="livebet__row"><dt>You said</dt><dd style="color:var(--' + (mySide === "TRUE" ? "true" : "false") + ')">' + mySide + ' &middot; ' + myStake.toFixed(2) + ' MINIMA</dd></div>';
    html += '<div class="livebet__row"><dt>They said</dt><dd style="color:var(--' + (mySide === "TRUE" ? "false" : "true") + ')">' + (mySide === "TRUE" ? "FALSE" : "TRUE") + ' &middot; ' + theirStake.toFixed(2) + ' MINIMA</dd></div>';
    html += '<div class="livebet__row"><dt>If ' + mySide + '</dt><dd class="side--yes">+' + theirStake.toFixed(2) + ' MINIMA</dd></div>';
    html += '<div class="livebet__row"><dt>If ' + (mySide === "TRUE" ? "FALSE" : "TRUE") + '</dt><dd class="side--no">-' + myStake.toFixed(2) + ' MINIMA</dd></div>';
    html += '</div>';

    // Incoming proposal
    var proposal = PENDING_PROPOSALS[bet.coinid];
    if (proposal && !isOpen && (iAmOwner || iAmCounter)) {
        var po = parseInt(proposal.outcome);
        var pWord = po === 2 ? "VOID — cancel the bet" : po === 1 ? "TRUE" : "FALSE";
        html += '<div class="proposal">';
        var propQuote = bet.proposition ? '"' + esc(bet.proposition) + '"' : 'the proposition';
        html += '<div class="proposal__from">Your counterparty says:</div>';
        html += '<div class="proposal__verdict">' + propQuote + ' is ' + pWord + '</div>';
        html += '<div class="proposal__fee">Do you agree? Disagreement invokes the arbiter — escrow forfeit for the loser, 10% fee from the pot.</div>';
        html += '<div class="proposal__btns">';
        html += '<button class="btn btn--yes" onclick="doAcceptProposal(\'' + bet.coinid + '\')">Agree</button>';
        html += '<button class="btn btn--no" onclick="doRejectProposal(\'' + bet.coinid + '\')">Disagree</button>';
        html += '</div></div>';
    }

    // Settlement prompt — "What happened?"
    if (!isOpen && !iAmArb && (iAmOwner || iAmCounter) && !proposal) {
        html += '<div class="decide">';
        var propText = bet.proposition ? '"' + esc(bet.proposition) + '"' : 'the proposition';
        html += '<div class="decide__title">Is ' + propText + ' TRUE or FALSE?</div>';
        html += '<div class="decide__sub">Both agree: 0% fee. Disagree: arbiter decides (10%).</div>';
        html += '<div class="decide__btns">';
        html += '<button class="btn btn--yes" onclick="doPropose(\'' + bet.coinid + '\',1)">TRUE</button>';
        html += '<button class="btn btn--no" onclick="doPropose(\'' + bet.coinid + '\',0)">FALSE</button>';
        html += '<button class="btn btn--ghost btn--sm" style="flex:0.4" onclick="doPropose(\'' + bet.coinid + '\',2)">Void</button>';
        html += '</div></div>';
    }

    // Chat — always visible for matched bets
    if (!isOpen && (iAmOwner || iAmCounter)) {
        var escapedProp = (bet.proposition || "").replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        var cid = bet.coinid.substring(2, 18);
        html += '<div class="chatbox">';
        html += '<div class="chatbox__title">Chat</div>';
        html += '<div class="chatbox__messages" id="chatmsgs_' + cid + '"></div>';
        html += '<div class="chatbox__input">';
        html += '<input class="chatbox__field" id="chatin_' + cid + '" placeholder="Message..." data-coinid="' + bet.coinid + '" data-prop="' + escapedProp + '" onkeydown="if(event.key===\'Enter\')sendChatDirect(this);">';
        html += '<button class="chatbox__send" onclick="sendChatDirect(document.getElementById(\'chatin_' + cid + '\'))">&#9654;</button>';
        html += '</div></div>';
    }

    html += '</div>';
    return html;
}

// -- Post Bet View --

function renderPostView(el) {
    var html = '<div class="postform">';
    html += '<div class="postform__title">Post a proposition</div>';

    html += '<div class="form-group">';
    html += '<label>Proposition</label>';
    html += '<input class="form-input" type="text" id="betMarket" placeholder="e.g. BTC above 80k by Friday" />';
    html += '</div>';

    html += '<div class="form-group">';
    html += '<label>Your side</label>';
    html += '<div class="side-toggle">';
    html += '<button class="side-toggle__btn active--yes" id="sideYes" onclick="pickSide(1)">TRUE</button>';
    html += '<button class="side-toggle__btn" id="sideNo" onclick="pickSide(0)">FALSE</button>';
    html += '</div></div>';

    html += '<div class="form-row">';
    html += '<div class="form-group">';
    html += '<label>Your Bet</label>';
    html += '<input class="form-input" type="number" id="betStake" min="0.01" step="0.01" placeholder="10" oninput="updateOddsPreview()" />';
    html += '</div>';
    html += '<div class="form-group">';
    html += '<label>They Must Bet</label>';
    html += '<input class="form-input" type="number" id="betWantStake" min="0.01" step="0.01" placeholder="10" oninput="updateOddsPreview()" />';
    html += '</div></div>';

    html += '<div class="payout" id="oddsPreview"><div class="payout__row" style="color:var(--muted)">Enter amounts to see your odds</div></div>';

    html += '<div class="form-group">';
    html += '<label>Arbiter Public Key</label>';
    html += '<input class="form-input form-input--mono" type="text" id="betArbPk" placeholder="0x..." />';
    html += '</div>';
    html += '<div class="form-group">';
    html += '<label>Arbiter Address</label>';
    html += '<input class="form-input form-input--mono" type="text" id="betArbAddr" placeholder="0x..." />';
    html += '</div>';
    html += '<div class="form-group">';
    html += '<label>Arbiter Maxima Key</label>';
    html += '<input class="form-input form-input--mono" type="text" id="betArbMxKey" placeholder="Mx..." />';
    html += '</div>';

    // Load saved arbiter settings
    setTimeout(function() {
        MDS.keypair.get("wager_arb_pk", function(r1) {
            if (r1.status && r1.value) { var e = document.getElementById("betArbPk"); if (e) e.value = r1.value; }
        });
        MDS.keypair.get("wager_arb_addr", function(r2) {
            if (r2.status && r2.value) { var e = document.getElementById("betArbAddr"); if (e) e.value = r2.value; }
        });
        MDS.keypair.get("wager_arb_mx", function(r3) {
            if (r3.status && r3.value) { var e = document.getElementById("betArbMxKey"); if (e) e.value = r3.value; }
        });
    }, 50);

    html += '<div class="form-group">';
    html += '<label>Timeout (blocks)</label>';
    html += '<div style="display:flex;gap:8px;align-items:center">';
    html += '<select class="form-input" id="betTimeoutSelect" style="flex:1" onchange="if(this.value===\'custom\'){document.getElementById(\'betTimeoutCustom\').style.display=\'block\'}else{document.getElementById(\'betTimeoutCustom\').style.display=\'none\'}">';
    html += '<option value="1500">1500 (~21 hours)</option>';
    html += '<option value="3000">3000 (~42 hours)</option>';
    html += '<option value="5000" selected>5000 (~3 days)</option>';
    html += '<option value="10000">10000 (~6 days)</option>';
    html += '<option value="custom">Custom...</option>';
    html += '</select></div>';
    html += '<input class="form-input" type="number" id="betTimeoutCustom" placeholder="e.g. 100" min="10" style="display:none;margin-top:6px" />';
    html += '</div>';

    html += '<div id="postStatus" class="status"></div>';
    html += '<button class="btn btn--accent btn--big" onclick="doPost()">Post Proposition</button>';
    html += '</div>';
    el.innerHTML = html;
}

var SELECTED_SIDE = 1;

function pickSide(side) {
    SELECTED_SIDE = side;
    var yesBtn = document.getElementById("sideYes");
    var noBtn = document.getElementById("sideNo");
    if (yesBtn) { yesBtn.className = "side-toggle__btn" + (side === 1 ? " active--yes" : ""); }
    if (noBtn) { noBtn.className = "side-toggle__btn" + (side === 0 ? " active--no" : ""); }
    updateOddsPreview();
}

function updateOddsPreview() {
    var bet = parseFloat(document.getElementById("betStake").value) || 0;
    var want = parseFloat(document.getElementById("betWantStake").value) || 0;
    var el = document.getElementById("oddsPreview");
    if (!el) return;
    if (bet <= 0 || want <= 0) {
        el.innerHTML = '<div class="payout__row" style="color:var(--muted)">Enter amounts to see your odds</div>';
        return;
    }

    var totalPot = bet + want;
    var lockAmt = (bet * (1 + ESCROW_RATE)).toFixed(2);
    var side = SELECTED_SIDE === 1 ? "TRUE" : "FALSE";

    el.innerHTML =
        '<div class="payout__row"><span>You stake (' + side + ')</span><strong>' + bet.toFixed(2) + ' MINIMA</strong></div>' +
        '<div class="payout__row"><span>They must stake</span><strong>' + want.toFixed(2) + ' MINIMA</strong></div>' +
        '<div class="payout__row payout__row--big"><span>If ' + side + '</span><strong class="payout__win">+' + want.toFixed(2) + ' MINIMA</strong></div>' +
        '<div class="payout__row"><span>If ' + (side === "TRUE" ? "FALSE" : "TRUE") + '</span><strong class="payout__lose">-' + bet.toFixed(2) + ' MINIMA</strong></div>' +
        '<div class="payout__row" style="font-size:12px;color:var(--muted)"><span>Locked (inc. 25% escrow)</span><span>' + lockAmt + ' MINIMA</span></div>';
}

var POST_PENDING = false;
function doPost() {
    if (POST_PENDING) { notify("Bet pending — wait for on-chain confirmation", "warn"); return; }
    var market = document.getElementById("betMarket").value.trim();
    var stake = document.getElementById("betStake").value.trim();
    var wantstake = document.getElementById("betWantStake").value.trim();
    var arbpk = document.getElementById("betArbPk").value.trim();
    var arbaddr = document.getElementById("betArbAddr").value.trim();
    var arbmxkey = document.getElementById("betArbMxKey").value.trim();
    var timeoutSel = document.getElementById("betTimeoutSelect").value;
    var timeout = timeoutSel === "custom" ? (document.getElementById("betTimeoutCustom").value || "5000") : timeoutSel;
    var statusEl = document.getElementById("postStatus");

    if (!market) { showStatus(statusEl, "Enter a proposition", "err"); return; }
    if (!stake || parseFloat(stake) < 0.01) { showStatus(statusEl, "Minimum bet is 0.01", "err"); return; }
    if (!wantstake || parseFloat(wantstake) < 0.01) { showStatus(statusEl, "Minimum counter bet is 0.01", "err"); return; }
    if (!arbpk || !arbaddr) { showStatus(statusEl, "Enter arbiter details", "err"); return; }

    // Save arbiter settings for next time
    if (arbpk) MDS.keypair.set("wager_arb_pk", arbpk);
    if (arbaddr) MDS.keypair.set("wager_arb_addr", arbaddr);
    if (arbmxkey) MDS.keypair.set("wager_arb_mx", arbmxkey);

    var lockAmt = (parseFloat(stake) * (1 + ESCROW_RATE)).toFixed(8);
    var wantLock = (parseFloat(wantstake) * (1 + ESCROW_RATE)).toFixed(8);

    showStatus(statusEl, "Posting bet...", "warn");
    POST_PENDING = true;

    postBet({
        market: market,
        side: SELECTED_SIDE,
        stake: lockAmt,
        wantstake: wantLock,
        arbpk: arbpk,
        arbaddr: arbaddr,
        arbname: "",
        arbitermxkey: arbmxkey,
        ownermxkey: MY_MXKEY,
        timeout: parseInt(timeout)
    }, function(ok, err) {
        if (ok) {
            showStatus(statusEl, "Question posted!", "ok");
            notify("Your bet is confirming on-chain — takes 1-2 minutes", "pending");
            if (arbmxkey) notifyArbiter("", arbmxkey, market, stake);
            setTimeout(function() { POST_PENDING = false; refreshBetsAndProposals(renderCurrentView); }, 2000);
        } else if (err === "pending") {
            showStatus(statusEl, "Pending — approve in MiniHub", "warn");
            notify("Bet pending — approve in MiniHub Pending Actions", "pending");
            POST_PENDING = false;
        } else {
            POST_PENDING = false;
            showStatus(statusEl, err || "Failed", "err");
        }
    });
}

// -- Actions --

function doFill(coinid) {
    var bet = OPEN_BETS.find(function(b) { return b.coinid === coinid; });
    if (!bet) return;

    var counterSide = bet.side === 1 ? "AGAINST" : "FOR";
    var lockAmt = parseFloat(bet.wantstake);
    var myBet = lockAmt / (1 + ESCROW_RATE);
    var theirBet = parseFloat(bet.amount) / (1 + ESCROW_RATE);
    var totalPot = myBet + theirBet;
    var odds = calcCounterOdds(myBet, theirBet);
    var prop = bet.proposition ? "\n\"" + bet.proposition + "\"\n" : "\n";

    if (!confirm("Take Bet — " + counterSide + " at " + odds + prop +
        "\nYou bet: " + myBet.toFixed(2) + " MINIMA" +
        "\nIf you win: " + totalPot.toFixed(2) + " MINIMA" +
        "\nIf you lose: -" + myBet.toFixed(2) + " MINIMA" +
        "\n\n25% escrow locked as honesty insurance")) return;

    // Auto-cancel only my COUNTER bets (opposite side from the bet I'm taking)
    var prop2 = bet.proposition || "";
    var mySideWhenTaking = bet.side === 1 ? 0 : 1;
    var myExisting = prop2 ? OPEN_BETS.filter(function(b) {
        return b.isMine && b.proposition === prop2 && b.side === mySideWhenTaking && b.phase === 0 && b.coinid !== coinid;
    }) : [];

    function cancelExisting(idx, done) {
        if (idx >= myExisting.length) { done(); return; }
        notify("Cancelling your counter (" + (idx+1) + "/" + myExisting.length + ")...", "info");
        cancelBet(myExisting[idx].coinid, function() {
            cancelExisting(idx + 1, done);
        });
    }

    function doTake() {
        notify("Taking bet — building transaction...", "info");
        fillBet(bet, function(ok, err) {
            if (ok) {
                notify("Bet taken! Confirming on-chain — this takes 1-2 minutes, sit tight", "pending");
                refreshBetsAndProposals(renderCurrentView);
            } else {
                notify("Fill failed: " + (err || "unknown"), "err");
            }
        });
    }

    // Fill directly — do NOT cancel existing bets first.
    // If fill fails, we keep our position. Old bet can be cancelled manually after.
    doTake();
}

// -- Counter Modal --
// The slider controls YOUR COUNTER-OFFER against their ask.
// Example: They stake 20, want 10. Slider: 1 → 10 (their ask).
// You slide DOWN to offer less. Counter at 8 posts a new bet: you stake 8, want 20.
// Now there's an 8-10 spread. Next counter narrows it toward equilibrium.

var COUNTER_BET = null;
var COUNTER_THEIR_BET = 0;
var COUNTER_THEIR_ASK = 0;

function doCounter(coinid) {
    var bet = OPEN_BETS.find(function(b) { return b.coinid === coinid; });
    if (!bet) return;
    COUNTER_BET = bet;
    // Their actual bet (without escrow)
    COUNTER_THEIR_BET = parseFloat(bet.amount) / (1 + ESCROW_RATE);
    // What they want from you (without escrow)
    COUNTER_THEIR_ASK = parseFloat(bet.wantstake) / (1 + ESCROW_RATE);
    showCounterModal();
}

function showCounterModal() {
    var bet = COUNTER_BET;
    if (!bet) return;

    var mySide = bet.side === 1 ? "AGAINST" : "FOR";
    var theirSide = bet.side === 1 ? "FOR" : "AGAINST";
    var theirBet = COUNTER_THEIR_BET;
    var theirAsk = COUNTER_THEIR_ASK;

    // Slider controls YOUR WANT. Stake is fixed at theirBet.
    // Range = the market spread: theirAsk (floor) to my side's best existing ask (ceiling).
    // First counter (no bets on my side): 0.01 to theirAsk.
    var mySideNum = bet.side === 1 ? 0 : 1;
    var bestCounterWant = 0; // best existing want on my side
    OPEN_BETS.forEach(function(b) {
        if (b.proposition !== bet.proposition || b.phase !== 0) return;
        if (b.side === mySideNum) {
            var bWant = parseFloat(b.wantstake || "0") / (1 + ESCROW_RATE);
            if (bWant > bestCounterWant) bestCounterWant = bWant;
        }
    });
    var sliderMin, sliderMax;
    if (bestCounterWant > 0) {
        // Market spread exists — slider = the spread between the two sides
        sliderMin = Math.min(bestCounterWant, theirAsk);
        sliderMax = Math.max(bestCounterWant, theirAsk);
    } else {
        // Slider from 0 to theirAsk. Zero = 0.01 minimum (substituted at read time).
        // No rounding, no alignment. Clean integers: 0, 1, 2... or 0, 0.5, 1.0...
        sliderMin = 0;
        sliderMax = theirAsk;
    }
    if (sliderMax <= sliderMin) sliderMax = sliderMin + 1;
    var spread = sliderMax - sliderMin;
    // Consistent step across all ranges — always 0.1 for predictable granularity
    var sliderStep = spread <= 1 ? 0.01 : 0.1;
    var sliderDefault = (theirAsk >= sliderMin && theirAsk <= sliderMax) ? theirAsk : sliderMax;

    var modal = document.getElementById("counterModal");
    if (!modal) {
        modal = document.createElement("div");
        modal.id = "counterModal";
        modal.className = "modal";
        document.body.appendChild(modal);
    }

    // FOR = TRUE, AGAINST = FALSE.
    var mySideWord = mySide === "FOR" ? "TRUE" : "FALSE";
    var theirSideWord = theirSide === "FOR" ? "TRUE" : "FALSE";

    modal.innerHTML =
        '<div class="modal__overlay" onclick="closeCounterModal()"></div>' +
        '<div class="modal__content">' +
        '<div class="modal__pill"></div>' +
        '<div class="modal__header">' +
        '<h3>Counter ' + mySideWord + '</h3>' +
        '<button class="modal__close" onclick="closeCounterModal()">&times;</button>' +
        '</div>' +
        '<div class="modal__prop">' + esc(bet.proposition || "Unknown") + '</div>' +
        '<div class="modal__info">' +
        '<div class="modal__row"><span style="color:var(--dim)">They bet</span><span><strong>' + theirBet.toFixed(2) + ' MINIMA</strong> ' + theirSideWord + '</span></div>' +
        '<div class="modal__row"><span style="color:var(--dim)">They want from you</span><span>' + theirAsk.toFixed(2) + ' MINIMA</span></div>' +
        '</div>' +
        '<div class="bignumber">' +
        '<div class="bignumber__label">Your bet</div>' +
        '<div><span class="bignumber__val" id="counterAmtLabel">' + sliderDefault.toFixed(0) + '</span> <span class="bignumber__unit">M</span></div>' +
        '</div>' +
        '<input type="range" id="counterAmtSlider" min="' + sliderMin.toFixed(1) + '" max="' + sliderMax.toFixed(1) + '" step="' + sliderStep + '" value="' + sliderDefault.toFixed(1) + '" oninput="updateCounterPreview()" />' +
        '<div class="slider-ends"><span>' + fmtAmt(sliderMin) + ' (counter)</span><span>' + fmtAmt(sliderMax) + ' (take bet)</span></div>' +
        '<div class="payout" id="counterPreview"></div>' +
        '<div id="counterStatus" class="status"></div>' +
        '<button class="btn btn--accent btn--big" onclick="submitCounter()" id="counterSubmitBtn">Confirm</button>' +
        '<div style="text-align:center;margin-top:10px"><button class="btn btn--ghost btn--sm btn--pill" onclick="closeCounterModal()">Cancel</button></div>' +
        '</div>';

    modal.style.display = "flex";
    updateCounterPreview();
}

function closeCounterModal() {
    var modal = document.getElementById("counterModal");
    if (modal) modal.style.display = "none";
    COUNTER_BET = null;
}

function adjustCounterAmt(delta) {
    var slider = document.getElementById("counterAmtSlider");
    var min = parseFloat(slider.min);
    var max = parseFloat(slider.max);
    var step = parseFloat(slider.step);
    var val = Math.round((parseFloat(slider.value) + delta) / step) * step;
    if (val < min) val = min;
    if (val > max) val = max;
    slider.value = val;
    updateCounterPreview();
}

function updateCounterPreview() {
    var myWant = parseFloat(document.getElementById("counterAmtSlider").value) || 0;
    if (myWant < 0.01) myWant = 0.01; // zero on slider = minimum 0.01
    var label = document.getElementById("counterAmtLabel");
    var preview = document.getElementById("counterPreview");
    var submitBtn = document.getElementById("counterSubmitBtn");
    var myBet = COUNTER_THEIR_BET;  // stake is FIXED at their bet size
    var theirAsk = COUNTER_THEIR_ASK;

    // Big number display
    if (label) label.innerText = fmtAmt(myWant);

    var isFullAsk = Math.abs(myWant - theirAsk) < 0.01;
    var totalPot = myBet + myWant;

    // Button text
    if (submitBtn) {
        submitBtn.innerText = isFullAsk ? "Take bet — " + fmtAmt(myWant) + "M" : "Counter — " + fmtAmt(myWant) + "M";
    }

    // Cash flow preview — myBet is what you stake (fixed), myWant is what you get if you win
    var counterSide = COUNTER_BET ? (COUNTER_BET.side === 1 ? "FALSE" : "TRUE") : "?";
    var theirSideLabel = COUNTER_BET ? (COUNTER_BET.side === 1 ? "TRUE" : "FALSE") : "?";

    if (preview) {
        preview.innerHTML =
            '<div class="payout__row"><span>You bet ' + fmtAmt(myBet) + ' (' + counterSide + '), want ' + fmtAmt(myWant) + '</span></div>' +
            '<div class="payout__row"><span>Pot</span><strong>' + fmtAmt(totalPot) + ' MINIMA</strong></div>' +
            '<div class="payout__row payout__row--big"><span>If you win</span><strong class="payout__win">+' + fmtAmt(myWant) + ' MINIMA profit</strong></div>' +
            '<div class="payout__row"><span>If you lose</span><strong class="payout__lose">-' + fmtAmt(myBet) + ' MINIMA</strong></div>' +
            '<div class="payout__row" style="font-size:12px;color:var(--muted)"><span>Locked (inc. escrow)</span><span>' + fmtAmt(myBet * (1 + ESCROW_RATE)) + ' MINIMA</span></div>' +
            (isFullAsk ? '<div class="payout__row" style="font-size:12px;color:var(--true);font-weight:700"><span>Takes their bet directly!</span></div>' :
            '<div class="payout__row" style="font-size:12px;color:var(--muted)"><span>Counter-offer — they can accept or counter back</span></div>');
    }
}

function submitCounter() {
    var bet = COUNTER_BET;
    if (!bet) return;

    var myWant = parseFloat(document.getElementById("counterAmtSlider").value) || 0;
    if (myWant < 0.01) myWant = 0.01;
    var statusEl = document.getElementById("counterStatus");

    if (myWant < 0.01) { showStatus(statusEl, "Minimum want is 0.01", "err"); return; }

    var theirAsk = COUNTER_THEIR_ASK;
    var isFullAsk = Math.abs(myWant - theirAsk) < 0.01;

    // My counter: I bet theirBet (fixed), I want myWant from the taker
    var theirBet = COUNTER_THEIR_BET;
    var myBet = theirBet;
    var lockAmt = (myBet * (1 + ESCROW_RATE)).toFixed(8);
    var wantLock = (myWant * (1 + ESCROW_RATE)).toFixed(8);
    var mySide = bet.side === 1 ? 0 : 1;
    var prop = bet.proposition || "";

    // Cancel any existing open bet from me on the same proposition AND same side
    var myExisting = OPEN_BETS.filter(function(b) {
        return b.isMine && b.proposition === prop && b.side === mySide && b.phase === 0;
    });

    function cancelExisting(idx, done) {
        if (idx >= myExisting.length) { done(); return; }
        showStatus(statusEl, "Cancelling previous bet (" + (idx+1) + "/" + myExisting.length + ")...", "warn");
        cancelBet(myExisting[idx].coinid, function(ok) {
            cancelExisting(idx + 1, done);
        });
    }

    function doPost() {
        showStatus(statusEl, "Posting counter bet...", "warn");
        postBet({
            market: prop,
            side: mySide,
            stake: lockAmt,
            wantstake: wantLock,
            arbpk: bet.arbpk || "",
            arbaddr: bet.arbaddr || "",
            arbname: "",
            arbitermxkey: bet.arbitermxkey || "",
            ownermxkey: MY_MXKEY,
            timeout: bet.timeout || 5000
        }, function(ok, err) {
            if (ok) {
                showStatus(statusEl, "Counter bet posted!", "ok");
                setTimeout(function() { closeCounterModal(); refreshBetsAndProposals(renderCurrentView); }, 1500);
            } else if (err === "pending") {
                showStatus(statusEl, "Pending — approve in MiniHub", "warn");
                notify("Counter pending — approve in MiniHub Pending Actions", "pending");
                setTimeout(function() { closeCounterModal(); }, 2000);
            } else {
                showStatus(statusEl, err || "Failed", "err");
            }
        });
    }

    function doFill() {
        showStatus(statusEl, "Taking bet at full ask...", "warn");
        fillBet(bet, function(ok, err) {
            if (ok) {
                showStatus(statusEl, "Bet filled!", "ok");
                setTimeout(function() { closeCounterModal(); refreshBetsAndProposals(renderCurrentView); }, 1500);
            } else {
                showStatus(statusEl, err || "Fill failed", "err");
            }
        });
    }

    if (isFullAsk) {
        // Full ask = fill the bet, then cancel our stale counter leg AFTER.
        // We cancel AFTER (not before) so if the fill fails we keep our position.
        // BUG FIX (v2.0.6): v2.0.5 never cancelled the counter leg at all.
        doFill();
        // Queue cancellation of our old same-side bets once fill is submitted.
        // The fill callback closes the modal after 1.5s — we cancel in parallel.
        if (myExisting.length > 0) {
            setTimeout(function() {
                myExisting.forEach(function(b) {
                    notify("Cancelling your old counter...", "info");
                    cancelBet(b.coinid, function(ok) {
                        if (ok) notify("Old counter cancelled", "ok");
                    });
                });
            }, 2000);
        }
    } else if (myExisting.length > 0) {
        // Counter: cancel existing same-side bet, then post new counter
        cancelExisting(0, function() {
            notify("Waiting for cancel to confirm...", "info");
            setTimeout(function() {
                refreshBetsAndProposals(function() { doPost(); });
            }, 3000);
        });
    } else {
        doPost();
    }
}

function doCancel(coinid) {
    if (!confirm("Cancel this bet?")) return;
    notify("Cancelling bet...", "info");
    cancelBet(coinid, function(ok, err) {
        if (ok) { notify("Cancelled!", "ok"); logTx("CANCEL", "refund", "IN", "", "Bet cancelled — funds returned"); refreshBetsAndProposals(renderCurrentView); }
        else { notify("Cancel failed: " + (err || "unknown"), "err"); }
    });
}

function doResolve(coinid, outcome) {
    var bet = MATCHED_BETS.find(function(b) { return b.coinid === coinid; });
    if (!bet) { notify("Bet not found", "err"); return; }

    var propText = bet.proposition ? "\n\"" + bet.proposition + "\"\n" : "\n";
    var label = outcome === 1 ? "TRUE — proposition happened" : "FALSE — proposition did not happen";
    var totalPot = parseFloat(bet.amount);
    var fee = (totalPot / 10).toFixed(2);
    var msg = "Declare: " + label + "?" + propText + "Winner gets 90% of pot. You earn " + fee + " MINIMA (10% of total pot).\nThis is final.";
    if (!confirm(msg)) return;

    var rLabel = outcome === 1 ? "TRUE" : "FALSE";
    notify("Resolving bet — " + rLabel + "...", "info");
    resolveBet(coinid, outcome, function(ok, err) {
        if (ok) {
            notify("Resolved — " + rLabel, "ok");
            logTx("ARBITER", fee, "IN", bet.proposition || "", "Arbiter resolved: " + rLabel);
            refreshBetsAndProposals(renderCurrentView);
        } else {
            notify("Resolve failed: " + (err || "unknown"), "err");
        }
    });
}

function doPropose(coinid, outcome) {
    var bet = MATCHED_BETS.find(function(b) { return b.coinid === coinid; });
    if (!bet) return;

    var propText = bet.proposition ? "\n\"" + bet.proposition + "\"\n" : "\n";
    var label = outcome === 2 ? "VOID — mutual cancel, each gets stake back" : outcome === 1 ? "TRUE — it happened" : "FALSE — it did not happen";
    var feeMsg = outcome === 2 ? "\nBoth agree: 0% fee, each gets full stake back" : "\nIf counterparty agrees: 0% fee\nIf they reject: arbiter decides (10% fee)";
    if (!confirm("Propose: " + label + propText + feeMsg)) return;

    notify("Building settlement proposal...", "info");
    selfSettle(coinid, outcome, function(ok, err, txnHex) {
        if (ok && txnHex) {
            // MxKeys are enriched from DB by refreshBets — should be available
            var counterMxKey = bet.isMine ? bet.countermxkey : bet.ownermxkey;
            if (!counterMxKey) {
                var existing = PENDING_PROPOSALS[bet.coinid];
                if (existing && existing.sender_mxkey) counterMxKey = existing.sender_mxkey;
            }
            // Track that WE sent this proposal (for dual-propose auto-accept)
            if (bet.proposition) {
                SENT_PROPOSALS[bet.proposition] = { outcome: outcome, coinid: coinid };
            }
            if (counterMxKey) {
                var outcomeWord = outcome === 2 ? "VOID" : outcome === 1 ? "TRUE" : "FALSE";
                sendSettlePropose(counterMxKey, coinid, outcome, txnHex, bet.proposition, function() {
                    notifyService("settle_pending", bet.proposition);
                    notify("Proposal sent — your counterparty will see it shortly. Be patient, on-chain delivery takes 1-2 minutes.", "pending");
                });
            } else {
                notifyService("settle_pending", bet.proposition);
                notify("Signed — no Maxima key for counterparty", "warn");
            }
        } else {
            notify("Proposal failed: " + (err || "unknown"), "err");
        }
    });
}

function doAcceptProposal(coinid) {
    var proposal = PENDING_PROPOSALS[coinid];
    if (!proposal || !proposal.txnhex) { notify("No proposal found", "err"); return; }
    if (!confirm("Accept settlement? 0% fee.")) return;
    notify("Co-signing settlement...", "info");
    var bet = MATCHED_BETS.find(function(b) { return b.coinid === coinid; });
    // Sign with the exact key stored in the coin (port 0 or 8), not MY_PUBKEY
    var sigKey = bet ? (bet.isMyCounter ? bet.counterpk : bet.ownerpk) : MY_PUBKEY;
    cosignAndPost(proposal.txnhex, sigKey, function(ok, err) {
        if (ok) {
            // Show who wins based on outcome
            var outcomeLabel = parseInt(proposal.outcome) === 1 ? "TRUE" : "FALSE";
            var iWin = false;
            if (bet) {
                var ownerSide = bet.side;
                var myIsOwner = bet.isMine;
                var outcomeNum = parseInt(proposal.outcome);
                iWin = (myIsOwner && outcomeNum === ownerSide) || (!myIsOwner && outcomeNum !== ownerSide);
            }
            // Calculate exact profit/loss for the banner
            var profit = "?";
            var escrowStatus = "returned";
            if (bet) {
                var escRate = 1 + ESCROW_RATE;
                var myLock = bet.isMine ? parseFloat(bet.ownerstake || "0") : parseFloat(bet.amount) - parseFloat(bet.ownerstake || "0");
                var theirLock = parseFloat(bet.amount) - myLock;
                var myBetAmt = myLock / escRate;
                var theirBetAmt = theirLock / escRate;
                if (iWin) {
                    // Winner gets pot minus loser's escrow (loser gets escrow back)
                    profit = "+" + theirBetAmt.toFixed(2);
                    escrowStatus = "returned";
                } else {
                    profit = "-" + myBetAmt.toFixed(2);
                    escrowStatus = "returned (0% fee)";
                }
            }
            var resultMsg = iWin ? "YOU WON! " + profit + " MINIMA" : "You lost. " + profit + " MINIMA";
            notify(resultMsg + " — " + (bet ? bet.proposition : ""), iWin ? "ok" : "err");
            logTx("SETTLE", bet ? bet.amount : "?", iWin ? "IN" : "OUT", bet ? bet.proposition : "", outcomeLabel + " — " + resultMsg);

            // Set the win/loss banner for My Bets view
            WIN_LOSS_BANNER = {
                type: iWin ? "win" : "loss",
                prop: bet ? bet.proposition : "?",
                amount: profit + " MINIMA",
                fee: "0%",
                escrow: escrowStatus
            };
            if (proposal.sender_mxkey) sendSettleAccept(proposal.sender_mxkey, coinid, bet ? bet.proposition : "", parseInt(proposal.outcome));
            if (bet && bet.proposition) {
                notifyService("settle_cleared", bet.proposition);
            }
            clearProposal(proposal.randomid);
            refreshBetsAndProposals(renderCurrentView);
        } else { notify("Settlement failed: " + (err || "unknown"), "err"); }
    });
}

function doRejectProposal(coinid) {
    var proposal = PENDING_PROPOSALS[coinid];
    if (!proposal) { notify("No proposal found", "err"); return; }
    var bet = MATCHED_BETS.find(function(b) { return b.coinid === coinid; });
    var isVoidProposal = parseInt(proposal.outcome) === 2;
    var arbMxKey = (!isVoidProposal && bet) ? (bet.arbitermxkey || "") : "";
    var confirmMsg = isVoidProposal
        ? "Reject void? Bet continues — you can still declare TRUE/FALSE."
        : "Reject? Goes to arbiter (10% fee for loser).";
    if (!confirm(confirmMsg)) return;
    var notifyMsg = isVoidProposal ? "Void rejected — bet continues" : "Sending dispute to arbiter...";
    notify(notifyMsg, "info");
    sendSettleReject(proposal.sender_mxkey, arbMxKey, coinid, bet ? bet.proposition : "", function() {
        notify(isVoidProposal ? "Void rejected" : "Dispute sent to arbiter", "ok");
        if (bet && bet.proposition) {
            notifyService("settle_cleared", bet.proposition);
        }
        clearProposal(proposal.randomid);
        refreshBetsAndProposals(renderCurrentView);
    });
}

function clearProposal(randomid) {
    if (!randomid) return;
    MDS.sql("DELETE FROM messages WHERE randomid='" + randomid.replace(/'/g, "''") + "'");
}

function doTimeout(coinid) {
    if (!confirm("Trigger timeout refund?")) return;
    notify("Triggering timeout refund...", "info");
    timeoutBet(coinid, function(ok, err) {
        if (ok) { notify("Refunded!", "ok"); refreshBetsAndProposals(renderCurrentView); }
        else { notify("Timeout failed: " + (err || "unknown"), "err"); }
    });
}

// -- My Bets View --

function renderMyBetsView(el) {
    var mine = OPEN_BETS.filter(function(b) { return b.isMine; });
    var myMatched = MATCHED_BETS.filter(function(b) { return b.isMine || b.isMyCounter; });
    var html = '<h2>My Bets</h2>';

    // Win/loss banner — prominent feedback after settlement
    if (WIN_LOSS_BANNER) {
        var b = WIN_LOSS_BANNER;
        var isWin = b.type === "win";
        html += '<div style="background:var(--' + (isWin ? 'true-soft' : 'false-soft') + ');border:2px solid var(--' + (isWin ? 'true' : 'false') + ');border-radius:var(--r);padding:16px;margin-bottom:12px;text-align:center">';
        html += '<div style="font-size:20px;font-weight:800;color:var(--' + (isWin ? 'true' : 'false') + ')">' + (isWin ? 'YOU WON!' : 'You lost.') + '</div>';
        html += '<div style="font-size:16px;font-weight:700;margin:4px 0">' + esc(b.amount) + '</div>';
        html += '<div style="font-size:13px;color:var(--dim)">' + esc(b.prop) + '</div>';
        html += '<div style="font-size:12px;color:var(--muted);margin-top:4px">Fee: ' + b.fee + ' · Escrow: ' + b.escrow + '</div>';
        html += '<button class="btn btn--ghost btn--sm" style="margin-top:8px" onclick="WIN_LOSS_BANNER=null;renderCurrentView();">Dismiss</button>';
        html += '</div>';
    }

    if (mine.length === 0 && myMatched.length === 0 && !WIN_LOSS_BANNER) {
        html += '<div class="empty"><div class="empty__text">No bets yet — post one or take a bet from Markets</div></div>';
        el.innerHTML = html; return;
    }

    // Live matched bets first (most important)
    if (myMatched.length > 0) {
        myMatched.forEach(function(bet) { html += renderLiveBet(bet); });
    }

    // Open bets (waiting to be taken)
    if (mine.length > 0) {
        html += '<h2 style="margin-top:8px">Open</h2>';
        mine.forEach(function(bet) {
            var escRate = 1 + ESCROW_RATE;
            var betAmt = parseFloat(bet.amount) / escRate;
            var wantAmt = parseFloat(bet.wantstake || "0") / escRate;
            var side = bet.side === 1 ? "TRUE" : "FALSE";

            html += '<div class="livebet">';
            html += '<div class="livebet__tag livebet__tag--open">Open — waiting for taker</div>';
            html += '<div class="livebet__question">' + esc(bet.proposition || "Bet") + '</div>';
            html += '<div class="livebet__stakes">';
            html += '<div class="livebet__row"><dt>You said</dt><dd style="color:var(--' + (side === "TRUE" ? "true" : "false") + ')">' + side + ' &middot; ' + betAmt.toFixed(2) + ' MINIMA</dd></div>';
            html += '<div class="livebet__row"><dt>You want</dt><dd>' + wantAmt.toFixed(2) + ' MINIMA from the other side</dd></div>';
            html += '</div>';
            html += '<div style="padding:12px 18px;display:flex;gap:10px">';
            html += '<button class="btn btn--ghost btn--sm" onclick="doCancel(\'' + bet.coinid + '\')">Cancel</button>';
            html += '</div>';
            html += '</div>';
        });
    }
    el.innerHTML = html;
    setTimeout(updateChatPreviews, 100);
}

function renderArbiterView(el) {
    var arbBets = MATCHED_BETS.filter(function(b) { return b.isMyArb; });
    var html = '<h2>Arbiter</h2>';

    if (arbBets.length === 0) {
        html += '<div class="arb-info">';
        html += '<div class="arb-info__title">Become an arbiter</div>';
        html += '<div class="arb-info__text">Share your details to be selected as an arbiter. You earn 10% of the total pot when you resolve disputes.</div>';
        html += '<div class="arb-info__label">Public Key</div>';
        html += '<div class="arb-info__key">' + esc(MY_PUBKEY) + '</div>';
        html += '<div class="arb-info__label">Address</div>';
        html += '<div class="arb-info__key">' + esc(MY_HEX_ADDR) + '</div>';
        html += '<div class="arb-info__label">Maxima Key</div>';
        html += '<div class="arb-info__key">' + esc(MY_MXKEY) + '</div>';
        html += '</div>';
    } else {
        arbBets.forEach(function(bet) {
            var totalPot = parseFloat(bet.amount);
            var escRate = 1 + ESCROW_RATE;
            var osLock = parseFloat(bet.ownerstake || "0");
            var csLock = totalPot - osLock;
            var yesAmt = (bet.side === 1 ? osLock : csLock) / escRate;
            var noAmt = (bet.side === 1 ? csLock : osLock) / escRate;
            var fee = (totalPot / 10).toFixed(2);

            html += '<div class="arbiter-card">';
            html += '<div class="arbiter-card__tag">⚖️ Awaiting your decision</div>';
            html += '<div class="arbiter-card__q">' + esc(bet.proposition || "Bet") + '</div>';
            html += '<div class="arbiter-card__grid">';
            html += '<div class="arbiter-card__side"><div class="arbiter-card__side-label">TRUE side</div><div class="arbiter-card__side-val" style="color:var(--true)">' + yesAmt.toFixed(2) + '</div></div>';
            html += '<div class="arbiter-card__side"><div class="arbiter-card__side-label">FALSE side</div><div class="arbiter-card__side-val" style="color:var(--false)">' + noAmt.toFixed(2) + '</div></div>';
            html += '</div>';
            html += '<div class="arbiter-card__fee">Your fee: ' + fee + ' MINIMA</div>';
            html += '<div class="arbiter-card__btns">';
            html += '<button class="btn btn--yes" onclick="doResolve(\'' + bet.coinid + '\',1)">TRUE</button>';
            html += '<button class="btn btn--no" onclick="doResolve(\'' + bet.coinid + '\',0)">FALSE</button>';
            html += '</div>';
            html += '</div>';
        });
    }
    el.innerHTML = html;
}

// -- Activity View --

// -- Chat Messaging (mInbox pattern) --

function sendChatDirect(inputEl) {
    if (!inputEl) return;
    var text = inputEl.value.trim();
    if (!text) return;
    var coinid = inputEl.getAttribute("data-coinid");
    var prop = inputEl.getAttribute("data-prop");

    var bet = MATCHED_BETS.find(function(b) { return b.coinid === coinid; });
    if (!bet) { notify("Bet not found", "err"); return; }

    var counterMxKey = bet.isMine ? bet.countermxkey : bet.ownermxkey;
    if (!counterMxKey) { notify("No Maxima key for counterparty", "err"); return; }

    var payload = {
        type: "CHAT_MESSAGE",
        betid: coinid,
        proposition: prop || bet.proposition || "",
        message: text,
        sender_name: MY_MXNAME,
        sender_mxkey: MY_MXKEY
    };

    // Store locally as "sent"
    insertMessage({
        randomid: "0x" + Date.now().toString(16) + Math.random().toString(16).substring(2, 10),
        betid: coinid,
        type: "CHAT_MESSAGE",
        sender_mxkey: MY_MXKEY,
        sender_name: MY_MXNAME,
        data: JSON.stringify(payload),
        direction: "sent"
    });

    inputEl.value = "";
    updateChatPreviews();

    sendChainMail(counterMxKey, payload, function(ok) {
        if (!ok) notify("Message failed to send", "err");
    });
}

function updateChatPreviews() {
    // Load chat messages and render them into the chatbox__messages divs
    MDS.sql("SELECT * FROM messages WHERE type='CHAT_MESSAGE' ORDER BY created DESC LIMIT 100", function(res) {
        var rows = (res.status && res.rows) ? res.rows : [];
        // Group messages by proposition
        var byProp = {};
        rows.forEach(function(r) {
            try {
                var data = JSON.parse(r.DATA || "{}");
                var p = data.proposition || "";
                if (!p) return;
                if (!byProp[p]) byProp[p] = [];
                byProp[p].push({
                    name: data.sender_name || r.SENDER_NAME || "?",
                    text: data.message || "",
                    isMine: r.DIRECTION === "sent" || (data.sender_mxkey === MY_MXKEY)
                });
            } catch(e) {}
        });
        // Render messages into chat divs for each matched bet
        MATCHED_BETS.forEach(function(bet) {
            var cid = bet.coinid.substring(2, 18);
            var msgsEl = document.getElementById("chatmsgs_" + cid);
            if (!msgsEl) return;
            var p = bet.proposition || "";
            var msgs = byProp[p] || [];
            var html = "";
            // Show in chronological order (array is newest-first, reverse it)
            msgs.reverse().forEach(function(m) {
                if (m.isMine) {
                    html += '<div style="text-align:right"><div class="msg__name" style="text-align:right">You</div>';
                    html += '<div class="msg msg--me">' + esc(m.text) + '</div></div>';
                } else {
                    html += '<div class="msg__name">' + esc(m.name) + '</div>';
                    html += '<div class="msg msg--them">' + esc(m.text) + '</div>';
                }
            });
            if (msgs.length === 0) {
                html = '<div style="font-size:12px;color:var(--muted);text-align:center;padding:8px">No messages yet</div>';
            }
            msgsEl.innerHTML = html;
            msgsEl.scrollTop = msgsEl.scrollHeight;
        });
    });
}

function renderHistoryView(el) {
    // Simplified history: proposition, won/lost, amount, fee, escrow
    // Query from activity log — filter for SETTLE/ARBITER entries
    loadHistory(function(rows) {
        var html = '<h2>History</h2>';
        var bets = rows.filter(function(r) {
            var msg = r.MSG || "";
            return msg.indexOf("SETTLE") >= 0 || msg.indexOf("ARBITER") >= 0 || msg.indexOf("CANCEL") >= 0 || msg.indexOf("settled") >= 0 || msg.indexOf("WON") >= 0 || msg.indexOf("LOST") >= 0;
        });
        if (bets.length === 0) {
            html += '<div class="empty">No completed bets yet</div>';
        } else {
            bets.forEach(function(r) {
                var msg = r.MSG || "";
                var time = new Date(parseInt(r.TIMESTAMP)).toLocaleString([], { month: "short", day: "numeric" });
                var isWin = msg.indexOf("WIN") >= 0 || msg.indexOf("IN ") === 0;
                var isLoss = msg.indexOf("LOSE") >= 0 || msg.indexOf("OUT ") === 0;
                var cls = isWin ? "ok" : isLoss ? "err" : "info";
                var result = isWin ? "WON" : isLoss ? "LOST" : "—";
                html += '<div class="logrow logrow--' + cls + '" style="padding:8px 12px">';
                html += '<span class="logrow__time">' + time + '</span>';
                html += '<strong style="margin-right:8px;color:var(--' + (isWin ? "true" : isLoss ? "false" : "muted") + ')">' + result + '</strong>';
                html += '<span class="logrow__msg">' + esc(msg) + '</span>';
                html += '</div>';
            });
        }
        el.innerHTML = html;
    });
}

/**
 * Housekeeping view — clear stuck pending actions, check health.
 */
function renderHousekeepingView(el) {
    var html = '<h2>Housekeeping</h2>';

    // Check pending actions count
    MDS.cmd("mds action:pending", function(res) {
        var pending = [];
        try { pending = res.response.pending || []; } catch(e) {}
        var count = pending.length;

        html += '<div class="qcard"><div class="qcard__head">';
        html += '<div class="qcard__question">Pending Actions: ' + count + '</div>';
        html += '<div class="qcard__meta"><span>Stuck transactions awaiting approval in MiniHub</span></div>';
        html += '</div>';
        if (count > 0) {
            html += '<div style="padding:12px 18px"><button class="btn btn--no" onclick="clearAllPending()">Deny all ' + count + ' pending actions</button></div>';
        }
        html += '</div>';

        // Permission mode
        MDS.cmd("checkmode", function(modeRes) {
            var mode = "unknown";
            try { mode = modeRes.response.mode || "unknown"; } catch(e) {}
            html += '<div class="qcard"><div class="qcard__head">';
            html += '<div class="qcard__question">Permission Mode: ' + mode + '</div>';
            html += '<div class="qcard__meta"><span>' + (mode === "READ" ? "Auto-refresh disabled (would create pending actions)" : "Auto-refresh enabled") + '</span></div>';
            html += '</div></div>';

            // Contract status
            html += '<div class="qcard"><div class="qcard__head">';
            html += '<div class="qcard__question">Contract: ' + (WAGER_SCRIPT_ADDRESS ? "Registered" : "NOT registered") + '</div>';
            html += '<div class="qcard__meta"><span>' + (WAGER_SCRIPT_ADDRESS || "—").substring(0, 30) + '...</span></div>';
            html += '</div></div>';

            el.innerHTML = html;
        });
    });
}

function clearAllPending() {
    notify("Clearing pending actions...", "info");
    MDS.cmd("mds action:pending", function(res) {
        var pending = [];
        try { pending = res.response.pending || []; } catch(e) {}
        var count = 0;
        pending.forEach(function(p) {
            if (p.uid) {
                MDS.cmd("mds action:deny uid:" + p.uid);
                count++;
            }
        });
        notify("Denied " + count + " pending actions", "ok");
        setTimeout(function() { renderCurrentView(); }, 1000);
    });
}

function renderActivityView(el) {
    loadActivity(function(logs) {
        var html = '<h2>Activity Log</h2>';
        if (logs.length === 0) {
            html += '<div class="empty"><div class="empty__text">No activity yet</div></div>';
        } else {
            html += '<div class="loglist">';
            logs.forEach(function(l) {
                var time = new Date(parseInt(l.TIMESTAMP)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                var cls = l.TYPE || "info";
                html += '<div class="logrow logrow--' + cls + '">';
                html += '<span class="logrow__time">' + time + '</span>';
                html += '<span class="logrow__msg">' + esc(l.MSG) + '</span>';
                html += '</div>';
            });
            html += '</div>';
        }
        el.innerHTML = html;
    });
}

// -- UI Helpers --

function showStatus(el, msg, type) {
    if (!el) return;
    el.className = "status status--" + (type || "info");
    el.innerText = msg;
}

/**
 * Set or clear settle-pending flag via shared MDS.keypair.
 * Both app.js and service.js read the same keypair key.
 * This replaces the old fire-and-forget MDSCOMMS approach.
 */
function notifyService(action, proposition) {
    if (!proposition) return;
    MDS.keypair.get("wager_settle_pending", function(val) {
        try {
            var sp = val && val.value ? JSON.parse(val.value) : {};
            if (action === "settle_pending") {
                sp[proposition] = Date.now();
            } else if (action === "settle_cleared") {
                delete sp[proposition];
            }
            MDS.keypair.set("wager_settle_pending", JSON.stringify(sp));
        } catch(e) {}
    });
}

// ============================================================
// ONBOARDING — 3 cinematic slides, shown once on first open
// Stored in MDS.keypair so it survives app updates.
// ============================================================

var ONBOARD_SLIDES = [
    {
        cls: "onboard--3",
        icon: "▣",
        title: "No house.<br>No middleman.<br>No loophole.",
        body: "Self-settle and keep everything — <strong>0% fee</strong>. Disagree? An arbiter decides for 10%. Powered by Minima — the blockchain that runs on your phone.",
        btn: "Next"
    },
    {
        cls: "onboard--2",
        icon: "⚖",
        title: "Skin in the game.",
        body: "Both sides stake 125% of the bet. The extra 25% is <strong>honesty insurance</strong> — held in escrow to encourage truthful declarations. Bluffing costs you.<br><br>Choose your own arbiter who decides if you disagree. Invoke the arbiter and risk your honesty escrow (25%) and give up 10% of the total. <strong>Declare honestly</strong> and enjoy trustless, permissionless, fee-free, safe, fair gambling. Playing by your rules — enforced by smart contract immutable code.",
        btn: "Next"
    },
    {
        cls: "onboard--1",
        icon: "◎",
        title: "Propose anything.<br>Bet anyone.<br>Trust no one.",
        body: "<strong>Trust not required.</strong> The smart contract holds everything until reality decides. No platform takes a cut. No operator can freeze your funds. No counterparty can walk away.",
        btn: "Start betting"
    }
];

var ONBOARD_STEP = 0;

function showOnboardingIfNeeded() {
    MDS.keypair.get("wager_onboard_done", function(res) {
        if (res.status && res.value === "true") return; // Already seen
        ONBOARD_STEP = 0;
        renderOnboardSlide();
    });
}

function renderOnboardSlide() {
    var container = document.getElementById("onboarding");
    if (!container) return;
    if (ONBOARD_STEP >= ONBOARD_SLIDES.length) {
        // Done — save and hide
        container.innerHTML = "";
        MDS.keypair.set("wager_onboard_done", "true");
        return;
    }
    var s = ONBOARD_SLIDES[ONBOARD_STEP];
    var dots = "";
    for (var i = 0; i < ONBOARD_SLIDES.length; i++) {
        dots += '<div class="onboard__dot' + (i === ONBOARD_STEP ? ' active' : '') + '"></div>';
    }
    container.innerHTML =
        '<div class="onboard ' + s.cls + '">' +
        '<div class="onboard__glow"></div>' +
        '<div class="onboard__brand"><b>O</b>pen<b>l</b>y</div>' +
        '<div class="onboard__icon">' + s.icon + '</div>' +
        '<div class="onboard__title">' + s.title + '</div>' +
        '<div class="onboard__body">' + s.body + '</div>' +
        '<div class="onboard__dots">' + dots + '</div>' +
        '<button class="onboard__btn" onclick="nextOnboardSlide()">' + s.btn + '</button>' +
        '</div>';
}

function nextOnboardSlide() {
    ONBOARD_STEP++;
    renderOnboardSlide();
}

// ============================================================

function esc(s) {
    if (!s) return "";
    var d = document.createElement("div");
    d.appendChild(document.createTextNode(s));
    return d.innerHTML;
}

// Smart number formatting: 2dp when <1, 1dp when <10, 0dp when >=10
function fmtAmt(n) {
    if (n === 0) return "0";
    if (n < 1) return n.toFixed(2);
    if (n < 10) return n.toFixed(1);
    return n.toFixed(0);
}