/**
 * Wager — Main Application (UI + Event Handling)
 *
 * Depends on: contract.js, chainmail.js, db.js, wager.js (loaded before this file)
 */

// -- Views --
var CURRENT_VIEW = "markets";
var CURRENT_MARKET = null;
var FILL_BET = null;
var PREFILL = null; // for counter-bet pre-fill

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
                    MDS.log("Wager v0.1.3 ready. Contract=" + WAGER_SCRIPT_ADDRESS);
                    logActivity("Wager ready", "info");
                    refreshBalance();
                    refreshBets(function() { renderCurrentView(); });
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
    var sideLabel = bet.side === 1 ? "FOR" : "AGAINST";
    var sideClass = bet.side === 1 ? "side--yes" : "side--no";
    var odds = calcOdds(bet.amount, bet.wantstake || "0");
    var stake = parseFloat(bet.amount).toFixed(4);
    var prop = bet.proposition || "";
    var propShort = prop.length > 40 ? prop.substring(0, 40) + "..." : prop;
    var canFill = isOpen && !bet.isMine && !bet.isMyArb;

    // Summary row
    var html = '<div class="betcard" id="' + id + '">';
    html += '<div class="betcard__summary" onclick="toggleCard(\'' + id + '\')">';
    if (prop) {
        html += '<span class="betcard__prop">' + esc(propShort) + '</span>';
    }
    html += '<span class="' + sideClass + ' betcard__side">' + sideLabel + '</span>';
    html += '<span class="betcard__stake">' + stake + ' M</span>';
    html += '<span class="odds betcard__odds">' + odds + '</span>';
    if (role) html += '<span class="betcard__role">' + role + '</span>';
    html += '<span class="betcard__chevron">&#9662;</span>';
    html += '</div>';

    // Expanded detail
    html += '<div class="betcard__detail">';

    // Proposition (full text)
    if (prop) {
        html += '<div class="betcard__proposition">' + esc(prop) + '</div>';
    }

    // Odds breakdown
    var counterOdds = isOpen ? calcCounterOdds(bet.amount, bet.wantstake) : "—";
    var totalPot = isOpen ? (parseFloat(bet.amount) + parseFloat(bet.wantstake)).toFixed(4) : stake;
    html += '<div class="betcard__grid">';
    html += '<dl><dt>For Odds</dt><dd>' + odds + '</dd></dl>';
    html += '<dl><dt>Against Odds</dt><dd>' + counterOdds + '</dd></dl>';
    html += '<dl><dt>Total Pot</dt><dd>' + totalPot + ' MINIMA</dd></dl>';
    html += '<dl><dt>Timeout</dt><dd>' + bet.timeout + ' blocks</dd></dl>';
    html += '</div>';

    // Payout preview
    if (isOpen) {
        var tp = parseFloat(totalPot);
        var osLock = parseFloat(bet.amount);
        var csLock = parseFloat(bet.wantstake);
        var osBet = osLock / (1 + ESCROW_RATE);
        var csBet = csLock / (1 + ESCROW_RATE);

        html += '<div class="betcard__payouts">';
        html += '<div><strong>Locked:</strong> FOR ' + osLock.toFixed(4) + ' (' + osBet.toFixed(4) + ' bet + ' + (osLock-osBet).toFixed(4) + ' escrow) | AGAINST ' + csLock.toFixed(4) + ' (' + csBet.toFixed(4) + ' + ' + (csLock-csBet).toFixed(4) + ')</div>';
        html += '<div><strong>Agree on result (0% fee):</strong> winner gets both bets + own escrow, loser gets escrow back</div>';
        html += '<div><strong>Arbiter decides (10% fee):</strong> winner gets pot - fee, loser forfeits all (125%)</div>';
        html += '<div><strong>Void:</strong> both refunded 90% of locked, arbiter 10%</div>';
        html += '</div>';
    }

    // Arbiter info
    html += '<div class="betcard__arbiter">';
    html += '<dt>Arbiter</dt>';
    html += '<dd class="mono">' + esc(bet.arbpk || "—") + '</dd>';
    html += '</div>';

    // Parties (if matched)
    if (!isOpen && bet.ownerstake) {
        var os = parseFloat(bet.ownerstake);
        var cs = (parseFloat(bet.amount) - os).toFixed(4);
        html += '<div class="betcard__parties">';
        html += '<div><span class="side--yes">FOR</span> stake: ' + os.toFixed(4) + ' — <span class="mono muted">' + esc((bet.owneraddr || "").substring(0, 20)) + '...</span></div>';
        html += '<div><span class="side--no">AGAINST</span> stake: ' + cs + ' — <span class="mono muted">' + esc((bet.counteraddr || "").substring(0, 20)) + '...</span></div>';
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
        html += '<button class="btn btn--accent" onclick="event.stopPropagation(); doFill(\'' + bet.coinid + '\')">Take Bet</button> ';
        html += '<button class="btn btn--ghost btn--sm" onclick="event.stopPropagation(); doCounter(\'' + bet.coinid + '\')">Counter</button>';
    }
    if (!isOpen && bet.isMyArb) {
        html += '<button class="btn btn--yes" onclick="event.stopPropagation(); doResolve(\'' + bet.coinid + '\', 1)">Won</button> ';
        html += '<button class="btn btn--no" onclick="event.stopPropagation(); doResolve(\'' + bet.coinid + '\', 0)">Lost</button> ';
        html += '<button class="btn btn--ghost btn--sm" onclick="event.stopPropagation(); doResolve(\'' + bet.coinid + '\', 2)">Void</button>';
    }
    if (!isOpen && !bet.isMyArb && (bet.isMine || bet.isMyCounter)) {
        html += '<button class="btn btn--yes btn--sm" onclick="event.stopPropagation(); doPropose(\'' + bet.coinid + '\', 1)">Propose: Won</button> ';
        html += '<button class="btn btn--no btn--sm" onclick="event.stopPropagation(); doPropose(\'' + bet.coinid + '\', 0)">Propose: Lost</button>';
    }
    html += '</div>';

    html += '</div>'; // detail
    html += '</div>'; // betcard
    return html;
}

// -- Markets View --

function renderMarketsView(el) {
    var html = '<h2>Open Markets</h2>';
    if (OPEN_BETS.length === 0) {
        html += '<div class="empty">No open bets — be the first to post one</div>';
    } else {
        // Group by proposition to show two-sided markets
        var markets = {};
        OPEN_BETS.forEach(function(bet) {
            var key = bet.proposition || bet.coinid;
            if (!markets[key]) markets[key] = { prop: bet.proposition, forBets: [], againstBets: [] };
            if (bet.side === 1) markets[key].forBets.push(bet);
            else markets[key].againstBets.push(bet);
        });

        var keys = Object.keys(markets);
        for (var k = 0; k < keys.length; k++) {
            var m = markets[keys[k]];
            if (m.prop) {
                html += '<div class="market">';
                html += '<div class="market__title">' + esc(m.prop) + '</div>';
                html += '<div class="market__sides">';

                // FOR column
                html += '<div class="market__col"><div class="market__colhead side--yes">FOR</div>';
                if (m.forBets.length === 0) {
                    html += '<div class="market__empty">No FOR bets</div>';
                } else {
                    m.forBets.forEach(function(bet) {
                        var role = bet.isMine ? "yours" : null;
                        html += renderBetCard(bet, role);
                    });
                }
                html += '</div>';

                // AGAINST column
                html += '<div class="market__col"><div class="market__colhead side--no">AGAINST</div>';
                if (m.againstBets.length === 0) {
                    html += '<div class="market__empty">No AGAINST bets</div>';
                } else {
                    m.againstBets.forEach(function(bet) {
                        var role = bet.isMine ? "yours" : null;
                        html += renderBetCard(bet, role);
                    });
                }
                html += '</div>';

                html += '</div></div>';
            } else {
                // No proposition — show individually
                var allBets = m.forBets.concat(m.againstBets);
                allBets.forEach(function(bet) {
                    var role = bet.isMine ? "yours" : bet.isMyArb ? "arbiter" : null;
                    html += renderBetCard(bet, role);
                });
            }
        }
    }

    var myMatched = MATCHED_BETS.filter(function(b) { return b.isMine || b.isMyCounter || b.isMyArb; });
    if (myMatched.length > 0) {
        html += '<h2>Matched Bets</h2>';
        myMatched.forEach(function(bet) {
            var role = bet.isMine ? "for" : bet.isMyCounter ? "against" : bet.isMyArb ? "arbiter" : null;
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
    html += '<label>Proposition</label>';
    html += '<input type="text" id="betMarket" placeholder="e.g. Arsenal beats Chelsea incl. extra time" />';
    html += '</div>';

    html += '<div class="form-row">';
    html += '<div class="form-group">';
    html += '<label>Your Side</label>';
    html += '<div class="side-picker">';
    html += '<button class="btn btn--yes active" id="sideYes" onclick="pickSide(1)">FOR</button>';
    html += '<button class="btn btn--no" id="sideNo" onclick="pickSide(0)">AGAINST</button>';
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
    html += '<input type="text" id="betArbAddr" placeholder="0x..." />';
    html += '</div>';
    html += '<div class="form-group">';
    html += '<label>Arbiter Maxima Key</label>';
    html += '<input type="text" id="betArbMxKey" placeholder="Mx..." />';
    html += '</div>';

    html += '<div class="form-group">';
    html += '<label>Timeout</label>';
    html += '<select id="betTimeout">';
    html += '<option value="1500">~21 hours</option>';
    html += '<option value="3000">~42 hours</option>';
    html += '<option value="5000" selected>~3 days</option>';
    html += '<option value="10000">~6 days</option>';
    html += '</select>';
    html += '</div>';

    html += '<div id="postStatus" class="status"></div>';
    html += '<button class="btn btn--accent" onclick="doPost()">Post Bet</button>';
    html += '</div>';
    el.innerHTML = html;

}

var SELECTED_SIDE = 1;

function pickSide(side) {
    SELECTED_SIDE = side;
    document.getElementById("sideYes").classList.toggle("active", side === 1);
    document.getElementById("sideNo").classList.toggle("active", side === 0);
    updateOddsPreview();
}

var ESCROW_RATE = 0.25;

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
    var myOdds = calcOdds(bet, want);
    var theirOdds = calcOdds(want, bet);
    var side = SELECTED_SIDE === 1 ? "FOR" : "AGAINST";

    el.innerHTML =
        'Your odds (' + side + '): <strong>' + myOdds + '</strong> — ' +
        'Counter odds: <strong>' + theirOdds + '</strong><br/>' +
        'You lock: ' + myLock.toFixed(4) + ' (' + bet.toFixed(2) + ' bet + ' + myEscrow.toFixed(2) + ' escrow)<br/>' +
        'They lock: ' + theirLock.toFixed(4) + ' (' + want.toFixed(2) + ' bet + ' + theirEscrow.toFixed(2) + ' escrow)<br/>' +
        '<span class="muted">Agree: 0% fee | Arbiter: 10% fee, loser forfeits 125%</span>';
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

    if (!market) { showStatus(statusEl, "Enter a proposition", "err"); return; }
    if (!stake || parseFloat(stake) < 0.01) { showStatus(statusEl, "Minimum bet is 0.01", "err"); return; }
    if (!wantstake || parseFloat(wantstake) < 0.01) { showStatus(statusEl, "Minimum counter bet is 0.01", "err"); return; }
    if (!arbpk || !arbaddr) { showStatus(statusEl, "Enter arbiter details", "err"); return; }

    var lockAmt = (parseFloat(stake) * (1 + ESCROW_RATE)).toFixed(8);
    var wantLock = (parseFloat(wantstake) * (1 + ESCROW_RATE)).toFixed(8);

    showStatus(statusEl, "Posting bet...", "warn");

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
            showStatus(statusEl, "Bet posted!", "ok");
            if (arbmxkey) notifyArbiter("", arbmxkey, market, stake);
            setTimeout(function() { refreshBets(renderCurrentView); }, 2000);
        } else {
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
    var betAmt = lockAmt / (1 + ESCROW_RATE);
    var escrow = lockAmt - betAmt;
    var odds = calcCounterOdds(bet.amount, bet.wantstake);
    var prop = bet.proposition ? "\n\n\"" + bet.proposition + "\"" : "";

    if (!confirm("Take Bet — " + counterSide + " at " + odds + prop + "\n\nYou lock: " + lockAmt.toFixed(4) + " MINIMA (" + betAmt.toFixed(2) + " bet + " + escrow.toFixed(2) + " escrow)\n\nAgree on result: 0% fee\nArbiter needed: 10% fee, loser forfeits 125%")) return;

    MDS.notify("Taking bet...");
    fillBet(bet, function(ok, err) {
        if (ok) {
            MDS.notify("Bet matched!");
            refreshBets(renderCurrentView);
        } else {
            MDS.notify("Fill failed: " + (err || "unknown"));
        }
    });
}

// -- Counter Modal --

var COUNTER_BET = null;

function doCounter(coinid) {
    var bet = OPEN_BETS.find(function(b) { return b.coinid === coinid; });
    if (!bet) return;
    COUNTER_BET = bet;
    showCounterModal();
}

function showCounterModal() {
    var bet = COUNTER_BET;
    if (!bet) return;

    var mySide = bet.side === 1 ? "AGAINST" : "FOR";
    var origOddsRatio = parseFloat(bet.wantstake) / parseFloat(bet.amount);
    var origBet = parseFloat(bet.amount) / (1 + ESCROW_RATE);
    var origWant = parseFloat(bet.wantstake) / (1 + ESCROW_RATE);

    var modal = document.getElementById("counterModal");
    if (!modal) {
        modal = document.createElement("div");
        modal.id = "counterModal";
        modal.className = "modal";
        document.body.appendChild(modal);
    }

    modal.innerHTML =
        '<div class="modal__overlay" onclick="closeCounterModal()"></div>' +
        '<div class="modal__content">' +
        '<div class="modal__header">' +
        '<h3>Counter Bet</h3>' +
        '<span class="modal__close" onclick="closeCounterModal()">&times;</span>' +
        '</div>' +

        '<div class="modal__prop">' + esc(bet.proposition || "Unknown proposition") + '</div>' +

        '<div class="modal__info">' +
        '<div class="modal__row"><span class="muted">Original bet</span><span>' + (bet.side === 1 ? "FOR" : "AGAINST") + ' at ' + calcOdds(bet.amount, bet.wantstake) + '</span></div>' +
        '<div class="modal__row"><span class="muted">Your side</span><span class="' + (mySide === "FOR" ? "side--yes" : "side--no") + '"><strong>' + mySide + '</strong></span></div>' +
        '<div class="modal__row"><span class="muted">Arbiter</span><span class="mono" style="font-size:11px">' + esc((bet.arbpk || "").substring(0, 24)) + '...</span></div>' +
        '</div>' +

        '<div class="form-group">' +
        '<label>Your Stake (MINIMA)</label>' +
        '<input type="number" id="counterStake" min="0.01" step="1" value="' + origWant.toFixed(2) + '" oninput="updateCounterPreview()" />' +
        '</div>' +

        '<div class="form-group">' +
        '<label>Your Odds</label>' +
        '<div class="counter__slider">' +
        '<button class="btn btn--ghost btn--sm" onclick="adjustCounterOdds(-0.1)">&#9664;</button>' +
        '<input type="range" id="counterOddsSlider" min="0.1" max="10" step="0.1" value="' + origOddsRatio.toFixed(1) + '" oninput="updateCounterPreview()" />' +
        '<button class="btn btn--ghost btn--sm" onclick="adjustCounterOdds(0.1)">&#9654;</button>' +
        '<span class="counter__oddsLabel" id="counterOddsLabel">' + origOddsRatio.toFixed(1) + ':1</span>' +
        '</div>' +
        '</div>' +

        '<div class="counter__preview" id="counterPreview"></div>' +

        '<div class="modal__actions">' +
        '<button class="btn btn--accent" onclick="submitCounter()">Post Counter Bet</button>' +
        '<button class="btn btn--ghost" onclick="closeCounterModal()">Cancel</button>' +
        '</div>' +

        '<div id="counterStatus" class="status"></div>' +
        '</div>';

    modal.style.display = "flex";
    updateCounterPreview();
}

function closeCounterModal() {
    var modal = document.getElementById("counterModal");
    if (modal) modal.style.display = "none";
    COUNTER_BET = null;
}

function adjustCounterOdds(delta) {
    var slider = document.getElementById("counterOddsSlider");
    var val = Math.round((parseFloat(slider.value) + delta) * 10) / 10;
    if (val < 0.1) val = 0.1;
    if (val > 10) val = 10;
    slider.value = val;
    updateCounterPreview();
}

function updateCounterPreview() {
    var stake = parseFloat(document.getElementById("counterStake").value) || 0;
    var oddsRatio = parseFloat(document.getElementById("counterOddsSlider").value) || 1;
    var label = document.getElementById("counterOddsLabel");
    var preview = document.getElementById("counterPreview");

    label.innerText = oddsRatio.toFixed(1) + ":1";

    if (stake <= 0) { preview.innerHTML = "Enter your stake"; return; }

    var wantFromCounter = stake * oddsRatio;
    var myEscrow = stake * ESCROW_RATE;
    var theirEscrow = wantFromCounter * ESCROW_RATE;
    var myLock = stake + myEscrow;
    var theirLock = wantFromCounter + theirEscrow;
    var totalPot = myLock + theirLock;

    preview.innerHTML =
        '<strong>Your bet: ' + stake.toFixed(2) + ' MINIMA</strong> at <strong>' + oddsRatio.toFixed(1) + ':1</strong><br/>' +
        'If you win: +' + wantFromCounter.toFixed(2) + ' profit<br/>' +
        'If you lose: -' + stake.toFixed(2) + ' (or -' + myLock.toFixed(2) + ' if arbiter needed)<br/>' +
        'You lock: ' + myLock.toFixed(2) + ' (bet + ' + (myEscrow).toFixed(2) + ' escrow)<br/>' +
        'Taker must lock: ' + theirLock.toFixed(2) + '<br/>' +
        '<span class="muted">Agree: 0% fee | Arbiter: 10%, loser forfeits 125%</span>';
}

function submitCounter() {
    var bet = COUNTER_BET;
    if (!bet) return;

    var stake = parseFloat(document.getElementById("counterStake").value) || 0;
    var oddsRatio = parseFloat(document.getElementById("counterOddsSlider").value) || 1;
    var statusEl = document.getElementById("counterStatus");

    if (stake < 0.01) { showStatus(statusEl, "Minimum bet is 0.01", "err"); return; }

    var wantFromCounter = stake * oddsRatio;
    var lockAmt = (stake * (1 + ESCROW_RATE)).toFixed(8);
    var wantLock = (wantFromCounter * (1 + ESCROW_RATE)).toFixed(8);
    var mySide = bet.side === 1 ? 0 : 1;
    var prop = bet.proposition || "";

    // Cancel any existing open bet from me on the same proposition first
    var myExisting = OPEN_BETS.filter(function(b) {
        return b.isMine && b.proposition === prop && b.phase === 0;
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
            arbitermxkey: "",
            ownermxkey: MY_MXKEY,
            timeout: bet.timeout || 5000
        }, function(ok, err) {
            if (ok) {
                showStatus(statusEl, "Counter bet posted!", "ok");
                setTimeout(function() { closeCounterModal(); refreshBets(renderCurrentView); }, 1500);
        } else {
            showStatus(statusEl, err || "Failed", "err");
        }
    });
    }

    // Cancel existing bets on same proposition, then post new counter
    if (myExisting.length > 0) {
        cancelExisting(0, function() {
            // Wait a moment for cancels to process
            setTimeout(doPost, 1000);
        });
    } else {
        doPost();
    }
}

function doCancel(coinid) {
    if (!confirm("Cancel this bet?")) return;
    MDS.notify("Cancelling...");
    cancelBet(coinid, function(ok, err) {
        if (ok) { MDS.notify("Cancelled!"); refreshBets(renderCurrentView); }
        else { MDS.notify("Failed: " + (err || "unknown")); }
    });
}

function doResolve(coinid, outcome) {
    var msg;
    if (outcome === 2) {
        msg = "Declare VOID? Both get 90% back, you earn 10% of pot.";
    } else {
        var label = outcome === 1 ? "WON (proposition true)" : "LOST (proposition false)";
        msg = "Declare: " + label + "?\nYou earn 10% of the winner's profit.\nThis is final.";
    }
    if (!confirm(msg)) return;

    MDS.notify("Resolving...");
    var rLabel = outcome === 2 ? "VOID" : outcome === 1 ? "Won" : "Lost";
    resolveBet(coinid, outcome, function(ok, err) {
        if (ok) { MDS.notify("Resolved — " + rLabel); refreshBets(renderCurrentView); }
        else { MDS.notify("Failed: " + (err || "unknown")); }
    });
}

function doPropose(coinid, outcome) {
    var bet = MATCHED_BETS.find(function(b) { return b.coinid === coinid; });
    if (!bet) return;

    var label = outcome === 1 ? "WON (proposition true)" : "LOST (proposition false)";
    if (!confirm("Propose: " + label + "\n\nIf counterparty agrees: 0% fee\nIf they reject: arbiter decides (10% fee)")) return;

    MDS.notify("Building proposal...");
    selfSettle(coinid, outcome, function(ok, err, txnHex) {
        if (ok && txnHex) {
            var counterMxKey = bet.isMine ? bet.countermxkey : bet.ownermxkey;
            if (counterMxKey) {
                sendSettlePropose(counterMxKey, coinid, outcome, txnHex, function() {
                    MDS.notify("Proposal sent — waiting for counterparty");
                });
            } else {
                MDS.notify("Signed — no Mx key for counterparty");
                MDS.log("Self-settle txnHex: " + txnHex);
            }
        } else {
            MDS.notify("Failed: " + (err || "unknown"));
        }
    });
}

function doAcceptProposal(txnHex, betid, proposerMxKey) {
    if (!confirm("Accept settlement? 0% fee.")) return;
    cosignAndPost(txnHex, function(ok, err) {
        if (ok) {
            MDS.notify("Settled — 0% fee!");
            if (proposerMxKey) sendSettleAccept(proposerMxKey, betid);
            refreshBets(renderCurrentView);
        } else { MDS.notify("Failed: " + (err || "unknown")); }
    });
}

function doRejectProposal(betid, proposerMxKey, arbMxKey) {
    if (!confirm("Reject? Goes to arbiter (10% fee for loser).")) return;
    sendSettleReject(proposerMxKey, arbMxKey, betid, function() {
        MDS.notify("Dispute sent to arbiter");
        refreshBets(renderCurrentView);
    });
}

function doTimeout(coinid) {
    if (!confirm("Trigger timeout refund?")) return;
    timeoutBet(coinid, function(ok, err) {
        if (ok) { MDS.notify("Refunded!"); refreshBets(renderCurrentView); }
        else { MDS.notify("Failed: " + (err || "unknown")); }
    });
}

// -- My Bets View --

function renderMyBetsView(el) {
    var mine = OPEN_BETS.filter(function(b) { return b.isMine; });
    var myMatched = MATCHED_BETS.filter(function(b) { return b.isMine || b.isMyCounter; });
    var html = '<h2>My Bets</h2>';

    if (mine.length === 0 && myMatched.length === 0) {
        html += '<div class="empty">No bets yet</div>';
        el.innerHTML = html; return;
    }
    if (mine.length > 0) {
        html += '<h3>Open</h3>';
        mine.forEach(function(bet) { html += renderBetCard(bet, "yours"); });
    }
    if (myMatched.length > 0) {
        html += '<h3>Matched</h3>';
        myMatched.forEach(function(bet) {
            var role = bet.isMine ? "for" : "against";
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
        html += '<p>Share your details to be selected as an arbiter. You earn 10% of the winner\'s profit on disputes.</p>';
        html += '<div class="betcard__grid">';
        html += '<dl><dt>Public Key</dt><dd class="mono" style="font-size:11px;word-break:break-all">' + esc(MY_PUBKEY) + '</dd></dl>';
        html += '<dl><dt>Address</dt><dd class="mono" style="font-size:11px;word-break:break-all">' + esc(MY_HEX_ADDR) + '</dd></dl>';
        html += '<dl><dt>Maxima Key</dt><dd class="mono" style="font-size:11px;word-break:break-all">' + esc(MY_MXKEY) + '</dd></dl>';
        html += '</div></div>';
    } else {
        html += '<p>' + arbBets.length + ' bet(s) awaiting resolution. You earn 10% of winner\'s profit.</p>';
        arbBets.forEach(function(bet) { html += renderBetCard(bet, "arbiter"); });
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
                html += '<div class="log__row log__' + (l.TYPE || "info") + '"><span class="log__time">' + time + '</span> ' + esc(l.MSG) + '</div>';
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