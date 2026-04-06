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
                    MDS.log("Wager v0.3.7 ready. Contract=" + WAGER_SCRIPT_ADDRESS);
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
    // Show bet amounts (without escrow) — escrow is implementation detail
    var locked = parseFloat(bet.amount);
    var betAmt = locked / (1 + ESCROW_RATE);
    var wantLocked = parseFloat(bet.wantstake || "0");
    var wantBet = wantLocked / (1 + ESCROW_RATE);
    var odds = calcOdds(betAmt, wantBet);
    var prop = bet.proposition || "";
    var propShort = prop.length > 40 ? prop.substring(0, 40) + "..." : prop;
    var canFill = isOpen && !bet.isMine && !bet.isMyArb;

    // Find best counter on the other side for market spread
    var bestCounter = 0;
    if (isOpen && prop) {
        var otherSide = bet.side === 1 ? 0 : 1;
        OPEN_BETS.forEach(function(b) {
            if (b.proposition === prop && b.side === otherSide && b.phase === 0) {
                var bBet = parseFloat(b.amount) / (1 + ESCROW_RATE);
                if (bBet > bestCounter) bestCounter = bBet;
            }
        });
    }

    // Multiplier: what you win per 1 staked
    var multVal = betAmt > 0 ? wantBet / betAmt : 0;
    var multiplier = multVal > 0 ? (multVal % 1 === 0 ? multVal.toFixed(0) : multVal.toFixed(1)) + 'x' : '—';

    // Summary row: prop | side | "20 wants 10" | 0.5x | 1:2 | [ask] [market] [counter]
    var html = '<div class="betcard" id="' + id + '">';
    html += '<div class="betcard__summary" onclick="toggleCard(\'' + id + '\')">';
    if (prop) {
        html += '<span class="betcard__prop">' + esc(propShort) + '</span>';
    }
    html += '<span class="betcard__tile ' + sideClass + ' betcard__side">' + sideLabel + '</span>';
    html += '<span class="betcard__tile betcard__stake">' + betAmt.toFixed(0) + ' wants ' + wantBet.toFixed(0) + '</span>';
    html += '<span class="betcard__tile betcard__mult">' + multiplier + '</span>';
    html += '<span class="betcard__tile betcard__odds">' + odds + '</span>';
    html += '<span class="betcard__tile betcard__want">' + Math.min(betAmt, wantBet).toFixed(0) + '</span>';
    if (role) html += '<span class="betcard__role">' + role + '</span>';
    html += '<span class="betcard__chevron">&#9662;</span>';
    html += '</div>';

    // Expanded detail
    html += '<div class="betcard__detail">';

    // Proposition (full text)
    if (prop) {
        html += '<div class="betcard__proposition">' + esc(prop) + '</div>';
    }

    // Odds and amounts — clean, bet-focused
    var counterOdds = isOpen ? calcCounterOdds(betAmt, wantBet) : "—";
    var totalBets = isOpen ? (betAmt + wantBet).toFixed(2) : (locked / (1 + ESCROW_RATE) * 2).toFixed(2);
    html += '<div class="betcard__grid">';
    html += '<dl><dt>FOR Odds</dt><dd>' + odds + '</dd></dl>';
    html += '<dl><dt>AGAINST Odds</dt><dd>' + counterOdds + '</dd></dl>';
    html += '<dl><dt>Bet</dt><dd>' + betAmt.toFixed(2) + ' M</dd></dl>';
    html += '<dl><dt>Wants</dt><dd>' + wantBet.toFixed(2) + ' M</dd></dl>';
    html += '</div>';

    // Payout info — simple, no escrow maths
    if (isOpen) {
        html += '<div class="betcard__payouts">';
        html += '<div>Winner takes: <strong>' + totalBets + ' MINIMA</strong></div>';
        html += '<div>Agree on result: <strong>0% fee</strong> — loser gets escrow back</div>';
        html += '<div>Arbiter decides: <strong>10% fee</strong> — loser forfeits all</div>';
        html += '<div class="muted" style="margin-top:4px">25% escrow locked with each bet as honesty insurance</div>';
        html += '</div>';
    }

    // Arbiter info
    html += '<div class="betcard__arbiter">';
    html += '<dt>Arbiter</dt>';
    html += '<dd class="mono">' + esc(bet.arbpk || "—") + '</dd>';
    html += '</div>';

    // Parties (if matched) — show bet amounts, highlight YOUR leg
    if (!isOpen && bet.ownerstake) {
        var osLock = parseFloat(bet.ownerstake);
        var csLock = parseFloat(bet.amount) - osLock;
        var osBet = osLock / (1 + ESCROW_RATE);
        var csBet = csLock / (1 + ESCROW_RATE);
        var potBet = osBet + csBet;
        var youAreOwner = bet.isMine;
        var youAreCounter = bet.isMyCounter;
        var forMe = (bet.side === 1 && youAreOwner) || (bet.side === 0 && youAreCounter);
        var againstMe = (bet.side === 0 && youAreOwner) || (bet.side === 1 && youAreCounter);
        var myBet = forMe ? osBet : csBet;
        var myProfit = forMe ? csBet : osBet;

        html += '<div class="betcard__parties">';
        html += '<div' + (forMe ? ' class="betcard__myleg"' : '') + '><span class="side--yes">FOR</span> bet ' + osBet.toFixed(2) + ' M to win ' + potBet.toFixed(2) + ' M' + (forMe ? ' <strong>← YOU</strong>' : '') + '</div>';
        html += '<div' + (againstMe ? ' class="betcard__myleg"' : '') + '><span class="side--no">AGAINST</span> bet ' + csBet.toFixed(2) + ' M to win ' + potBet.toFixed(2) + ' M' + (againstMe ? ' <strong>← YOU</strong>' : '') + '</div>';
        if (youAreOwner || youAreCounter) {
            html += '<div class="betcard__yourleg">Your stake: <strong>' + myBet.toFixed(2) + ' M</strong> — Win: <strong>+' + myProfit.toFixed(2) + '</strong> — Lose: <strong>-' + myBet.toFixed(2) + '</strong></div>';
        }
        html += '<div class="muted" style="margin-top:4px">25% escrow locked — returned if you agree, forfeited if arbiter needed</div>';
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
                // Compute bet/want for each side
                var esc = 1 + ESCROW_RATE;
                var forBet = 0, forWant = 0, againstBet = 0, againstWant = 0;
                m.forBets.forEach(function(b) {
                    var bt = parseFloat(b.amount) / esc;
                    var wt = parseFloat(b.wantstake || "0") / esc;
                    if (bt > forBet) { forBet = bt; }
                    if (forWant === 0 || wt < forWant) { forWant = wt; }
                });
                m.againstBets.forEach(function(b) {
                    var bt = parseFloat(b.amount) / esc;
                    var wt = parseFloat(b.wantstake || "0") / esc;
                    if (bt > againstBet) { againstBet = bt; }
                    if (againstWant === 0 || wt < againstWant) { againstWant = wt; }
                });

                // Bet size = largest stake on either side
                var betSize = Math.max(forBet, againstBet);

                // Spread: each side's ask vs the other side's offer
                // Pick the non-crossed pair (ask > offer = gap still open)
                var spreadHi = 0, spreadLo = 0;
                if (againstWant > forBet && againstWant > 0 && forBet > 0) {
                    spreadHi = againstWant; spreadLo = forBet;
                } else if (forWant > againstBet && forWant > 0 && againstBet > 0) {
                    spreadHi = forWant; spreadLo = againstBet;
                }

                var spreadHtml = '';
                if (spreadHi > 0 && spreadLo > 0) {
                    spreadHtml = '<div class="market__midspread">' +
                        '<span class="market__midsize">' + betSize.toFixed(0) + '</span>' +
                        '<hr class="market__midline"/>' +
                        '<span class="market__midprice">' + spreadLo.toFixed(0) + '-' + spreadHi.toFixed(0) + '</span>' +
                        '</div>';
                }

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

                // Market spread connecting tile
                html += spreadHtml;

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
    html += '<label>You Bet (MINIMA)</label>';
    html += '<input type="number" id="betStake" min="0.01" step="0.01" placeholder="30" oninput="updateOddsPreview()" />';
    html += '</div>';

    html += '<div class="form-group">';
    html += '<label>You Want (MINIMA)</label>';
    html += '<input type="number" id="betWantStake" min="0.01" step="0.01" placeholder="90" oninput="updateOddsPreview()" />';
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
    if (bet <= 0 || want <= 0) { el.innerText = "You bet X, you want Y"; return; }

    var totalPot = bet + want;
    var myOdds = calcOdds(bet, want);
    var mv = want / bet;
    var mult = (mv % 1 === 0 ? mv.toFixed(0) : mv.toFixed(1)) + 'x';
    var side = SELECTED_SIDE === 1 ? "FOR" : "AGAINST";

    el.innerHTML =
        '<strong>' + bet.toFixed(0) + ' wants ' + want.toFixed(0) + '</strong> &nbsp; ' + mult + ' &nbsp; ' + myOdds + ' &nbsp; ' + side + '<br/>' +
        'Winner takes: <strong>' + totalPot.toFixed(2) + ' MINIMA</strong> (+' + want.toFixed(2) + ' profit)<br/>' +
        'If you lose: <strong>-' + bet.toFixed(2) + ' MINIMA</strong><br/>' +
        '<span class="muted">25% escrow locked as honesty insurance | Agree: 0% fee | Arbiter: 10%</span>';
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

    // Slider: your counter-offer, from best existing counter up to theirAsk
    // Find best existing counter on my side (same proposition, opposite side)
    var mySideNum = bet.side === 1 ? 0 : 1;
    var bestCounter = 0;
    OPEN_BETS.forEach(function(b) {
        if (b.proposition === bet.proposition && b.side === mySideNum && b.coinid !== bet.coinid) {
            var bAsk = parseFloat(b.wantstake) / (1 + ESCROW_RATE);
            var bBet = parseFloat(b.amount) / (1 + ESCROW_RATE);
            if (bBet > bestCounter) bestCounter = bBet;
        }
    });
    var sliderMin = bestCounter > 0 ? bestCounter : 1;
    var sliderMax = theirAsk;
    if (sliderMax <= sliderMin) sliderMax = sliderMin + 0.1;
    var spread = sliderMax - sliderMin;
    var sliderStep = spread > 20 ? 1 : spread > 2 ? 0.5 : 0.1;
    var sliderDefault = sliderMin;

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
        '<div class="modal__row"><span class="muted">They bet</span><span><strong>' + theirBet.toFixed(2) + ' MINIMA</strong> ' + theirSide + '</span></div>' +
        '<div class="modal__row"><span class="muted">They want from you</span><span>' + theirAsk.toFixed(2) + ' MINIMA</span></div>' +
        '<div class="modal__row"><span class="muted">Your side</span><span class="' + (mySide === "FOR" ? "side--yes" : "side--no") + '"><strong>' + mySide + '</strong></span></div>' +
        '</div>' +

        '<div class="form-group">' +
        '<label>Counter their ask of ' + theirAsk.toFixed(2) + ' MINIMA</label>' +
        '<div class="counter__spread">' +
        '<span class="counter__end counter__end--mine">' + sliderMin.toFixed(2) + '<br/><small>' + (bestCounter > 0 ? 'best bid' : 'min') + '</small></span>' +
        '<div class="counter__sliderWrap">' +
        '<div class="counter__slider">' +
        '<button class="btn btn--ghost btn--sm" onclick="adjustCounterAmt(-' + sliderStep + ')">&#9664;</button>' +
        '<input type="range" id="counterAmtSlider" min="' + sliderMin.toFixed(1) + '" max="' + sliderMax.toFixed(1) + '" step="' + sliderStep + '" value="' + sliderDefault.toFixed(1) + '" oninput="updateCounterPreview()" />' +
        '<button class="btn btn--ghost btn--sm" onclick="adjustCounterAmt(' + sliderStep + ')">&#9654;</button>' +
        '</div>' +
        '<div class="counter__oddsLabel" id="counterAmtLabel">' + sliderDefault.toFixed(2) + ' M</div>' +
        '</div>' +
        '<span class="counter__end counter__end--theirs">' + theirAsk.toFixed(2) + '<br/><small>full ask</small></span>' +
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
    var myBet = parseFloat(document.getElementById("counterAmtSlider").value) || 0;
    var label = document.getElementById("counterAmtLabel");
    var preview = document.getElementById("counterPreview");
    var theirBet = COUNTER_THEIR_BET;

    label.innerText = myBet.toFixed(2) + " M";

    var totalPot = theirBet + myBet;
    var myOdds = calcOdds(myBet, theirBet);
    var theirOdds = calcOdds(theirBet, myBet);

    var theirAsk = COUNTER_THEIR_ASK;
    var isFullAsk = Math.abs(myBet - theirAsk) < 0.01;

    preview.innerHTML =
        '<div style="margin-bottom:8px"><strong>They stake ' + theirBet.toFixed(2) + ', you offer ' + myBet.toFixed(2) + '</strong>' +
        (isFullAsk ? '' : ' <span class="muted">(asked ' + theirAsk.toFixed(2) + ')</span>') + '</div>' +
        '<div>Winner takes: <strong>' + totalPot.toFixed(2) + ' MINIMA</strong></div>' +
        '<div>Your odds: <strong>' + myOdds + '</strong> — Their odds: <strong>' + theirOdds + '</strong></div>' +
        '<div style="margin-top:6px">If you win: <strong>+' + theirBet.toFixed(2) + ' profit</strong></div>' +
        '<div>If you lose: <strong>-' + myBet.toFixed(2) + '</strong></div>' +
        (isFullAsk ? '' : '<div class="muted" style="margin-top:6px">This is a counter-offer — they can accept, counter back, or wait</div>') +
        '<div class="muted" style="margin-top:6px">25% escrow locked as honesty insurance</div>';
}

function submitCounter() {
    var bet = COUNTER_BET;
    if (!bet) return;

    var myBet = parseFloat(document.getElementById("counterAmtSlider").value) || 0;
    var statusEl = document.getElementById("counterStatus");

    if (myBet < 0.01) { showStatus(statusEl, "Minimum bet is 0.01", "err"); return; }

    // My counter: I bet myBet, I want theirBet from the taker
    var theirBet = COUNTER_THEIR_BET;
    var lockAmt = (myBet * (1 + ESCROW_RATE)).toFixed(8);
    var wantLock = (theirBet * (1 + ESCROW_RATE)).toFixed(8);
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