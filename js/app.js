/**
 * Wager — Main Application (UI + Event Handling)
 *
 * Depends on: contract.js, db.js, wager.js (loaded before this file)
 */

// -- Views --
var CURRENT_VIEW = "markets";
var CURRENT_MARKET = null;
var FILL_BET = null;

// -- Init --
MDS.init(function(msg) {
    if (msg.event === "inited") initApp();
    if (msg.event === "NEWBLOCK") {
        updateBlock(msg);
        if (DB_READY) { refreshBets(renderCurrentView); refreshBalance(); }
    }
    if (msg.event === "NEWBALANCE") {
        if (DB_READY) { refreshBets(renderCurrentView); refreshBalance(); }
    }
});

function initApp() {
    registerContract(function() {
        loadIdentity(function() {
            loadWalletKeys(function() {
                loadMaximaIdentity(function() {
                initDB(function() {
                    MDS.log("Wager v0.1.0 ready. Contract=" + WAGER_SCRIPT_ADDRESS + " Keys=" + Object.keys(MY_KEYS).length + " Mx=" + (MY_MXKEY ? MY_MXKEY.substring(0,20)+"..." : "none"));
                    logActivity("Wager ready", "info");
                    refreshBalance();
                    refreshBets(function() {
                        renderCurrentView();
                    });
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
            if (res.response[i].tokenid === "0x00") {
                bal = res.response[i].sendable;
                break;
            }
        }
        var el = document.getElementById("balance");
        if (el) el.innerText = parseFloat(bal).toFixed(4) + " MINIMA";
    });
}

// -- Navigation --

function showView(view) {
    CURRENT_VIEW = view;
    document.querySelectorAll(".nav__tab").forEach(function(t) { t.classList.remove("active"); });
    var tab = document.querySelector('[data-view="' + view + '"]');
    if (tab) tab.classList.add("active");
    renderCurrentView();
}

function renderCurrentView() {
    var main = document.getElementById("mainContent");
    if (!main) return;

    if (CURRENT_VIEW === "markets") renderMarketsView(main);
    else if (CURRENT_VIEW === "post") renderPostView(main);
    else if (CURRENT_VIEW === "mybets") renderMyBetsView(main);
    else if (CURRENT_VIEW === "arbiter") renderArbiterView(main);
    else if (CURRENT_VIEW === "activity") renderActivityView(main);
}

// -- Expandable Card --

function toggleCard(id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle("expanded");
}

function renderBetCard(bet, role) {
    var id = "card_" + bet.coinid.substring(0, 16);
    var isOpen = bet.phase === 0;
    var side = bet.side === 1 ? "BACK" : "LAY";
    var sideClass = bet.side === 1 ? "side--yes" : "side--no";
    var odds = calcOdds(bet.amount, bet.wantstake || "0");
    var stake = parseFloat(bet.amount).toFixed(4);
    var canFill = isOpen && !bet.isMine && !bet.isMyArb;

    // Summary row (always visible)
    var html = '<div class="betcard" id="' + id + '">';
    html += '<div class="betcard__summary" onclick="toggleCard(\'' + id + '\')">';
    html += '<span class="' + sideClass + ' betcard__side">' + side + '</span>';
    html += '<span class="betcard__stake">' + stake + ' M</span>';
    html += '<span class="odds betcard__odds">' + odds + 'x</span>';

    if (isOpen) {
        html += '<span class="muted">wants ' + parseFloat(bet.wantstake).toFixed(4) + '</span>';
    } else {
        html += '<span class="muted">pot ' + stake + '</span>';
    }

    if (role) html += '<span class="betcard__role">' + role + '</span>';
    html += '<span class="betcard__chevron">&#9662;</span>';
    html += '</div>';

    // Expanded detail (hidden by default)
    html += '<div class="betcard__detail">';

    // Odds breakdown
    var counterOdds = isOpen ? calcCounterOdds(bet.amount, bet.wantstake) : "—";
    var totalPot = isOpen ? (parseFloat(bet.amount) + parseFloat(bet.wantstake)).toFixed(4) : stake;
    html += '<div class="betcard__grid">';
    html += '<dl><dt>Backer Odds</dt><dd>' + odds + 'x</dd></dl>';
    html += '<dl><dt>Layer Odds</dt><dd>' + counterOdds + 'x</dd></dl>';
    html += '<dl><dt>Total Pot</dt><dd>' + totalPot + ' MINIMA</dd></dl>';
    html += '<dl><dt>Timeout</dt><dd>' + bet.timeout + ' blocks</dd></dl>';
    html += '</div>';

    // Payout preview
    if (isOpen) {
        var tp = parseFloat(totalPot);
        var osLock = parseFloat(bet.amount);        // locked amount (bet + escrow)
        var csLock = parseFloat(bet.wantstake);
        var osBet = osLock / (1 + ESCROW_RATE);     // actual bet (80% of locked)
        var csBet = csLock / (1 + ESCROW_RATE);
        var osEsc = osLock - osBet;
        var csEsc = csLock - csBet;

        html += '<div class="betcard__payouts">';
        html += '<div><strong>Locked:</strong> BACK ' + osLock.toFixed(4) + ' (' + osBet.toFixed(4) + ' bet + ' + osEsc.toFixed(4) + ' escrow) | LAY ' + csLock.toFixed(4) + ' (' + csBet.toFixed(4) + ' + ' + csEsc.toFixed(4) + ')</div>';
        html += '<div><strong>If players agree (0% fee):</strong></div>';
        html += '<div>&nbsp; Winner: both bets + own escrow | Loser: own escrow back</div>';
        html += '<div><strong>If arbiter decides (10% fee):</strong></div>';
        html += '<div>&nbsp; Winner: pot - fee | Loser: forfeits everything (125% loss)</div>';
        html += '<div>&nbsp; <span class="side--arb">VOID</span>: both refunded 90% of locked, arbiter 10%</div>';
        html += '</div>';
    }

    // Arbiter info
    html += '<div class="betcard__arbiter">';
    html += '<dt>Arbiter</dt>';
    html += '<dd class="mono">' + esc(bet.arbpk || "—") + '</dd>';
    html += '<dd class="mono muted">' + esc(bet.arbaddr || "") + '</dd>';
    html += '</div>';

    // Parties (if matched)
    if (!isOpen && bet.ownerstake) {
        var os = parseFloat(bet.ownerstake);
        var cs = (parseFloat(bet.amount) - os).toFixed(4);
        html += '<div class="betcard__parties">';
        html += '<div><span class="side--yes">BACK</span> stake: ' + os.toFixed(4) + ' — <span class="mono muted">' + esc((bet.owneraddr || "").substring(0, 20)) + '...</span></div>';
        html += '<div><span class="side--no">LAY</span> stake: ' + cs + ' — <span class="mono muted">' + esc((bet.counteraddr || "").substring(0, 20)) + '...</span></div>';
        html += '</div>';
    }

    // Coin ID
    html += '<div class="betcard__coinid mono muted">' + esc(bet.coinid) + '</div>';

    // Actions
    html += '<div class="betcard__actions">';
    if (isOpen && bet.isMine) {
        html += '<button class="btn btn--ghost btn--sm" onclick="event.stopPropagation(); doCancel(\'' + bet.coinid + '\')">Cancel</button>';
    }
    if (canFill) {
        html += '<button class="btn btn--accent" onclick="event.stopPropagation(); doFill(\'' + bet.coinid + '\')">Take ' + (bet.side === 1 ? 'LAY' : 'BACK') + ' Side</button>';
    }
    if (!isOpen && bet.isMyArb) {
        html += '<button class="btn btn--yes" onclick="event.stopPropagation(); doResolve(\'' + bet.coinid + '\', 1)">Back Wins</button> ';
        html += '<button class="btn btn--no" onclick="event.stopPropagation(); doResolve(\'' + bet.coinid + '\', 0)">Lay Wins</button> ';
        html += '<button class="btn btn--ghost btn--sm" onclick="event.stopPropagation(); doResolve(\'' + bet.coinid + '\', 2)">Void</button>';
    }
    if (!isOpen && !bet.isMyArb && (bet.isMine || bet.isMyCounter)) {
        html += '<button class="btn btn--yes btn--sm" onclick="event.stopPropagation(); doPropose(\'' + bet.coinid + '\', 1)">Propose: Back Won</button> ';
        html += '<button class="btn btn--no btn--sm" onclick="event.stopPropagation(); doPropose(\'' + bet.coinid + '\', 0)">Propose: Lay Won</button>';
    }
    html += '</div>';

    html += '</div>'; // detail
    html += '</div>'; // betcard

    return html;
}

// -- Markets View --

function renderMarketsView(el) {
    var html = '<h2>Open Bets</h2>';

    if (OPEN_BETS.length === 0) {
        html += '<div class="empty">No open bets — be the first to post one</div>';
    } else {
        OPEN_BETS.forEach(function(bet) {
            var role = bet.isMine ? "yours" : bet.isMyArb ? "arbiter" : null;
            html += renderBetCard(bet, role);
        });
    }

    var myMatched = MATCHED_BETS.filter(function(b) { return b.isMine || b.isMyCounter || b.isMyArb; });
    if (myMatched.length > 0) {
        html += '<h2>Matched Bets</h2>';
        myMatched.forEach(function(bet) {
            var role = bet.isMine ? "backer" : bet.isMyCounter ? "layer" : bet.isMyArb ? "arbiter" : null;
            html += renderBetCard(bet, role);
        });
    }

    el.innerHTML = html;
}

// -- Post Bet View --

function renderPostView(el) {
    var html = '<h2>Post a Bet</h2>';
    html += '<div class="card">';
    html += '<div class="form-group">';
    html += '<label>Event / Market</label>';
    html += '<input type="text" id="betMarket" placeholder="e.g. Man City beats Arsenal (incl. extra time)" />';
    html += '</div>';

    html += '<div class="form-row">';
    html += '<div class="form-group">';
    html += '<label>Your Side</label>';
    html += '<div class="side-picker">';
    html += '<button class="btn btn--yes active" id="sideYes" onclick="pickSide(1)">BACK</button>';
    html += '<button class="btn btn--no" id="sideNo" onclick="pickSide(0)">LAY</button>';
    html += '</div></div>';

    html += '<div class="form-group">';
    html += '<label>Your Bet (MINIMA)</label>';
    html += '<input type="number" id="betStake" min="0.01" step="0.01" placeholder="10" oninput="updateOddsPreview()" />';
    html += '</div>';

    html += '<div class="form-group">';
    html += '<label>Counter Bet (MINIMA)</label>';
    html += '<input type="number" id="betWantStake" min="0.01" step="0.01" placeholder="15" oninput="updateOddsPreview()" />';
    html += '</div>';
    html += '</div>';

    html += '<div class="odds-preview" id="oddsPreview">Set bets to see odds</div>';

    html += '<div class="form-group">';
    html += '<label>Arbiter Public Key</label>';
    html += '<input type="text" id="betArbPk" placeholder="0x..." />';
    html += '</div>';
    html += '<div class="form-group">';
    html += '<label>Arbiter Address</label>';
    html += '<input type="text" id="betArbAddr" placeholder="0x... (arbiter fee address)" />';
    html += '</div>';
    html += '<div class="form-group">';
    html += '<label>Arbiter Maxima Key (for ChainMail notifications)</label>';
    html += '<input type="text" id="betArbMxKey" placeholder="Mx..." />';
    html += '</div>';

    html += '<div class="form-group">';
    html += '<label>Timeout (blocks — arbiter must resolve within this)</label>';
    html += '<select id="betTimeout">';
    html += '<option value="1500">1500 (~21 hours)</option>';
    html += '<option value="3000">3000 (~42 hours)</option>';
    html += '<option value="5000" selected>5000 (~3 days)</option>';
    html += '<option value="10000">10000 (~6 days)</option>';
    html += '</select>';
    html += '</div>';

    html += '<div id="postStatus" class="status"></div>';
    html += '<button class="btn btn--accent" onclick="doPost()">Post Bet</button>';
    html += '</div>';
    el.innerHTML = html;
}

var SELECTED_SIDE = 1; // default YES

function pickSide(side) {
    SELECTED_SIDE = side;
    document.getElementById("sideYes").classList.toggle("active", side === 1);
    document.getElementById("sideNo").classList.toggle("active", side === 0);
    updateOddsPreview();
}

var ESCROW_RATE = 0.25; // 25% escrow on top of bet

function updateOddsPreview() {
    var bet = parseFloat(document.getElementById("betStake").value) || 0;
    var want = parseFloat(document.getElementById("betWantStake").value) || 0;
    var el = document.getElementById("oddsPreview");
    if (bet <= 0 || want <= 0) { el.innerText = "Set bets to see odds"; return; }

    var myEscrow = bet * ESCROW_RATE;
    var theirEscrow = want * ESCROW_RATE;
    var myLock = bet + myEscrow;
    var theirLock = want + theirEscrow;
    var totalPot = myLock + theirLock;
    var myOdds = ((bet + want) / bet).toFixed(2);
    var theirOdds = ((bet + want) / want).toFixed(2);
    var side = SELECTED_SIDE === 1 ? "BACK" : "LAY";
    var otherSide = SELECTED_SIDE === 1 ? "LAY" : "BACK";

    el.innerHTML =
        '<strong>' + side + ' ' + myOdds + 'x</strong> vs ' +
        '<strong>' + otherSide + ' ' + theirOdds + 'x</strong><br/>' +
        'You lock: ' + myLock.toFixed(4) + ' (' + bet.toFixed(4) + ' bet + ' + myEscrow.toFixed(4) + ' escrow)<br/>' +
        'They lock: ' + theirLock.toFixed(4) + ' (' + want.toFixed(4) + ' bet + ' + theirEscrow.toFixed(4) + ' escrow)<br/>' +
        'Total in contract: ' + totalPot.toFixed(4) + ' MINIMA<br/>' +
        '<span class="muted">Agree on result: 0% fee, loser gets escrow back | ' +
        'Arbiter needed: 10% fee, loser forfeits everything (125%)</span>';
}

function doPost() {
    var market = document.getElementById("betMarket").value.trim();
    var stake = document.getElementById("betStake").value.trim();
    var wantstake = document.getElementById("betWantStake").value.trim();
    var arbpk = document.getElementById("betArbPk").value.trim();
    var arbaddr = document.getElementById("betArbAddr").value.trim();
    var arbmxkey = document.getElementById("betArbMxKey").value.trim();
    var timeout = document.getElementById("betTimeout").value;
    var statusEl = document.getElementById("postStatus");

    if (!market) { showStatus(statusEl, "Enter an event description", "err"); return; }
    if (!stake || parseFloat(stake) < 0.01) { showStatus(statusEl, "Minimum bet is 0.01 MINIMA", "err"); return; }
    if (!wantstake || parseFloat(wantstake) < 0.01) { showStatus(statusEl, "Minimum counter bet is 0.01 MINIMA", "err"); return; }
    if (!arbpk || !arbaddr) { showStatus(statusEl, "Enter arbiter public key and address", "err"); return; }

    // Lock bet + 25% escrow
    var lockAmt = (parseFloat(stake) * (1 + ESCROW_RATE)).toFixed(8);
    var wantLock = (parseFloat(wantstake) * (1 + ESCROW_RATE)).toFixed(8);

    showStatus(statusEl, "Posting bet (" + stake + " + " + (parseFloat(stake) * ESCROW_RATE).toFixed(4) + " escrow)...", "warn");

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
            showStatus(statusEl, "Bet posted! Waiting for confirmation...", "ok");
            // Notify arbiter via ChainMail
            if (arbmxkey) {
                notifyArbiter("", arbmxkey, market, stake, function() {
                    showStatus(statusEl, "Bet posted + arbiter notified!", "ok");
                });
            }
            setTimeout(function() { refreshBets(renderCurrentView); }, 2000);
        } else {
            showStatus(statusEl, err || "Failed to post bet", "err");
        }
    });
}

// -- Actions --

function doFill(coinid) {
    var bet = OPEN_BETS.find(function(b) { return b.coinid === coinid; });
    if (!bet) return;

    var side = bet.side === 1 ? "LAY" : "BACK";
    var lockAmt = parseFloat(bet.wantstake);
    var betAmt = lockAmt / (1 + ESCROW_RATE);
    var escrow = lockAmt - betAmt;
    var odds = calcCounterOdds(bet.amount, bet.wantstake);
    if (!confirm("Take " + side + " side at " + odds + "x odds?\n\nYou lock: " + lockAmt.toFixed(4) + " MINIMA (" + betAmt.toFixed(4) + " bet + " + escrow.toFixed(4) + " escrow)\n\nAgree on result: 0% fee, get escrow back if you lose\nArbiter needed: 10% fee, loser forfeits all (125% loss)")) return;

    MDS.notify("Filling bet...");
    fillBet(bet, function(ok, err) {
        if (ok) {
            MDS.notify("Bet matched!");
            refreshBets(renderCurrentView);
        } else {
            MDS.notify("Fill failed: " + (err || "unknown"));
        }
    });
}

function doCancel(coinid) {
    if (!confirm("Cancel this bet?")) return;
    MDS.notify("Cancelling bet...");
    cancelBet(coinid, function(ok, err) {
        if (ok) {
            MDS.notify("Bet cancelled!");
            refreshBets(renderCurrentView);
        } else {
            MDS.notify("Cancel failed: " + (err || "unknown"));
        }
    });
}

function doResolve(coinid, outcome) {
    var msg;
    if (outcome === 2) {
        msg = "Declare this bet VOID (tie/undecidable)?\nBoth players get 90% of their stake back.\nYou earn 10% of the pot.\nThis is final.";
    } else {
        var label = outcome === 1 ? "BACK" : "LAY";
        msg = "Declare " + label + " as the winner?\nYou earn 10% of the winner's profit.\nThis is final and cannot be undone.";
    }
    if (!confirm(msg)) return;

    MDS.notify("Resolving bet...");
    resolveBet(coinid, outcome, function(ok, err) {
        if (ok) {
            MDS.notify("Bet resolved — " + label + " wins!");
            refreshBets(renderCurrentView);
        } else {
            MDS.notify("Resolve failed: " + (err || "unknown"));
        }
    });
}

function doPropose(coinid, outcome) {
    var bet = MATCHED_BETS.find(function(b) { return b.coinid === coinid; });
    if (!bet) return;

    var label = outcome === 1 ? "BACK" : "LAY";
    if (!confirm("Propose " + label + " as the winner?\nIf your counterparty agrees: 0% fee!\nIf they reject: goes to arbiter (10% fee).")) return;

    MDS.notify("Building settlement proposal...");
    selfSettle(coinid, outcome, function(ok, err, txnHex) {
        if (ok && txnHex) {
            // Find counter's Mx key to send proposal
            var counterMxKey = bet.isMine ? bet.countermxkey : bet.ownermxkey;
            if (!counterMxKey) {
                // Try loading from DB
                loadBet(bet.coinid, function(dbBet) {
                    var mx = dbBet ? (bet.isMine ? dbBet.COUNTERMXKEY : dbBet.OWNERMXKEY) : null;
                    if (mx) {
                        sendSettlePropose(mx, coinid, outcome, txnHex, function() {
                            MDS.notify("Settlement proposed — waiting for counterparty");
                        });
                    } else {
                        MDS.notify("Signed — but no Mx key for counterparty. Share the tx hex manually.");
                        MDS.log("Self-settle txnHex: " + txnHex);
                    }
                });
            } else {
                sendSettlePropose(counterMxKey, coinid, outcome, txnHex, function() {
                    MDS.notify("Settlement proposed — waiting for counterparty");
                });
            }
        } else {
            MDS.notify("Proposal failed: " + (err || "unknown"));
        }
    });
}

function doAcceptProposal(txnHex, betid, proposerMxKey) {
    if (!confirm("Accept this settlement? The bet will be resolved at 0% fee.")) return;
    MDS.notify("Co-signing settlement...");
    cosignAndPost(txnHex, function(ok, err) {
        if (ok) {
            MDS.notify("Bet settled — 0% fee!");
            if (proposerMxKey) sendSettleAccept(proposerMxKey, betid);
            refreshBets(renderCurrentView);
        } else {
            MDS.notify("Co-sign failed: " + (err || "unknown"));
        }
    });
}

function doRejectProposal(betid, proposerMxKey, arbMxKey) {
    if (!confirm("Reject this settlement? The bet will go to the arbiter (10% fee for loser).")) return;
    MDS.notify("Rejecting and escalating to arbiter...");
    sendSettleReject(proposerMxKey, arbMxKey, betid, function() {
        MDS.notify("Dispute sent to arbiter");
        refreshBets(renderCurrentView);
    });
}

function doTimeout(coinid) {
    if (!confirm("Trigger timeout refund? Both sides get their stakes back.")) return;
    MDS.notify("Triggering timeout refund...");
    timeoutBet(coinid, function(ok, err) {
        if (ok) {
            MDS.notify("Refund complete!");
            refreshBets(renderCurrentView);
        } else {
            MDS.notify("Timeout failed: " + (err || "unknown"));
        }
    });
}

// -- My Bets View --

function renderMyBetsView(el) {
    var mine = OPEN_BETS.filter(function(b) { return b.isMine; });
    var myMatched = MATCHED_BETS.filter(function(b) { return b.isMine || b.isMyCounter; });

    var html = '<h2>My Bets</h2>';

    if (mine.length === 0 && myMatched.length === 0) {
        html += '<div class="empty">No bets yet</div>';
        el.innerHTML = html;
        return;
    }

    if (mine.length > 0) {
        html += '<h3>Open Orders</h3>';
        mine.forEach(function(bet) {
            html += renderBetCard(bet, "yours");
        });
    }

    if (myMatched.length > 0) {
        html += '<h3>Matched</h3>';
        myMatched.forEach(function(bet) {
            var role = bet.isMine ? "backer" : "layer";
            html += renderBetCard(bet, role);
        });
    }

    el.innerHTML = html;
}

// -- Arbiter View --

function renderArbiterView(el) {
    var arbBets = MATCHED_BETS.filter(function(b) { return b.isMyArb; });
    var html = '<h2>Arbiter Dashboard</h2>';

    if (arbBets.length === 0) {
        html += '<div class="empty">No bets pending your resolution</div>';
        html += '<div class="card">';
        html += '<p>Share your details with bettors to be selected as an arbiter. You earn 10% of the winner\'s profit on every dispute resolution.</p>';
        html += '<div class="betcard__grid">';
        html += '<dl><dt>Your Public Key</dt><dd class="mono" style="font-size:11px;word-break:break-all">' + esc(MY_PUBKEY) + '</dd></dl>';
        html += '<dl><dt>Your Address</dt><dd class="mono" style="font-size:11px;word-break:break-all">' + esc(MY_HEX_ADDR) + '</dd></dl>';
        html += '<dl><dt>Your Maxima Key (for ChainMail)</dt><dd class="mono" style="font-size:11px;word-break:break-all">' + esc(MY_MXKEY) + '</dd></dl>';
        html += '</div></div>';
    } else {
        html += '<p>' + arbBets.length + ' bet(s) awaiting your resolution. You earn 3% of the winner\'s profit.</p>';
        arbBets.forEach(function(bet) {
            html += renderBetCard(bet, "arbiter");
        });
    }

    el.innerHTML = html;
}

// -- Activity View --

function renderActivityView(el) {
    loadActivity(function(logs) {
        var html = '<h2>Activity Log</h2>';
        if (logs.length === 0) {
            html += '<div class="empty">No activity yet</div>';
        } else {
            html += '<div class="log">';
            logs.forEach(function(l) {
                var time = new Date(parseInt(l.TIMESTAMP)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                var typeClass = "log__" + (l.TYPE || "info");
                html += '<div class="log__row ' + typeClass + '"><span class="log__time">' + time + '</span> ' + esc(l.MSG) + '</div>';
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

function esc(s) {
    if (!s) return "";
    var d = document.createElement("div");
    d.appendChild(document.createTextNode(s));
    return d.innerHTML;
}