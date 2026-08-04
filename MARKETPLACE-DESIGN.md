# Openly Marketplace Design — From 1-vs-1 to Multi-Party Betting

**Version:** 0.1 (draft)
**Date:** 2026-04-09
**Baseline:** Wager v2.1.x, contract V3.1 (~1183 chars), MAST 3-leaf

---

## 1. Recommended Architecture: Stacked 1-vs-1 Coins (Option A+C Hybrid)

### Decision

Keep every bet as a **separate 1-vs-1 UTXO** using the existing V3.1 contract.
The marketplace is built **entirely in the UI and application layer** by grouping
coins that share the same proposition text and arbiter.

This is the right call for five reasons:

1. **Zero contract changes.** The V3.1 script is at 1183 chars against a ~1200 limit.
   There is no room for pool logic, proportional payout math, or participant lists.
   A pool contract would need to track N participants and compute N outputs, which
   blows past the 1024-instruction limit for any N > 2.

2. **UTXO model alignment.** Minima is UTXO-based with no global state. A "pool coin"
   that multiple people deposit into requires either (a) serialized writes (one deposit
   at a time, each consuming and recreating the coin) or (b) a separate deposit
   mechanism. Option (a) is a concurrency nightmare on a P2P network with block times.
   Option (b) is a second contract. Both are fragile.

3. **Independent settlement.** Each 1-vs-1 coin settles independently. If Alice and
   Bob self-settle but Carol and Dave dispute, the arbiter handles only the Carol/Dave
   coin. No one blocks anyone else.

4. **Battle-tested.** The V3.1 contract works on-chain today. Every new codepath is a
   new bug surface. The marketplace value comes from aggregation, not from new on-chain
   primitives.

5. **Composability.** A taker who wants to bet 15 fills three coins (5, 8, and 2 from
   the remaining 12). Each fill is a standard fillBet transaction. The UI orchestrates
   this as a single user action.

### What "Marketplace" Means in This Architecture

A **market** is defined by: `(proposition_text, arbiter_pubkey)`.

All open coins sharing the same market are logically grouped. The UI presents them
as a single order book with aggregated depth. Taking a position means filling one or
more individual coins, each producing an independent matched bet.

---

## 2. Proposition Identity — The Market Key

### Problem

Currently, proposition text is free-form. Two users posting "Lakers win tonight" and
"lakers win tonight" create different markets. The marketplace needs a canonical key.

### Solution: Market Definition Object

When creating a bet, the user either:
- **Selects an existing market** from the `markets` DB table (exact proposition + arbiter)
- **Creates a new market** (proposition text + arbiter), which gets stored in `markets`

The **market key** is: `SHA3(proposition_hex + arbiter_pubkey)`.

This is computed client-side and stored in a new state port or (better) just used as
a local index. The on-chain data already contains both proposition (port 12) and
arbiter pubkey (port 2), so the market key is derivable from any coin.

### Implementation

```javascript
function marketKey(propositionHex, arbiterPk) {
    // Deterministic key from the two values that define a market
    return SHA3(propositionHex + arbiterPk);
}

function groupByMarket(openBets) {
    var markets = {};
    openBets.forEach(function(bet) {
        var key = marketKey(bet.propositionHex, bet.arbpk);
        if (!markets[key]) {
            markets[key] = {
                proposition: bet.proposition,
                arbpk: bet.arbpk,
                arbaddr: bet.arbaddr,
                forOffers: [],   // side=1 open coins
                againstOffers: [] // side=0 open coins
            };
        }
        if (bet.side === 1) markets[key].forOffers.push(bet);
        else markets[key].againstOffers.push(bet);
    });
    return markets;
}
```

No contract change needed. The market key is a UI-layer concept.

---

## 3. Order Book Mechanics

### 3.1 What the User Sees

```
+----------------------------------------------------------+
|  "Lakers beat Celtics tonight"                           |
|  Arbiter: SportsOracle                                   |
|  Settlement: Block 450000                                |
+----------------------------------------------------------+
|                                                          |
|   FOR (TRUE)              AGAINST (FALSE)                |
|   ──────────              ───────────────                |
|   5.0 M @ 2:1             3.0 M @ 1:1                   |
|   8.0 M @ 3:1            12.0 M @ 2:1                   |
|   2.5 M @ 1:1             7.0 M @ 3:1                   |
|   ─────────               ──────────                     |
|   Total: 15.5 M           Total: 22.0 M                 |
|                                                          |
|   [ Take AGAINST ▼ ]      [ Take FOR ▼ ]                |
+----------------------------------------------------------+
```

Each line in the book is one open coin. The odds shown are derived from
`ownerstake : wantstake` for that coin. "Take AGAINST" means you are taking the
opposite side of all the FOR offers (you believe FALSE).

### 3.2 Odds as Price

In this system, odds ARE the price. A coin with 10M locked wanting 5M back represents
2:1 odds. The order book sorts by attractiveness to the taker:

- **Best odds first**: A taker wanting to bet AGAINST sorts FOR offers by highest
  owner-to-counter ratio (the taker pays less per unit of potential winnings)
- Each offer is an independent coin with its own odds

### 3.3 Taking Multiple Offers ("Sweep the Book")

User wants to bet 15M AGAINST. Available FOR offers:
- Coin A: 5M locked, wants 5M (1:1)
- Coin B: 8M locked, wants 4M (2:1)
- Coin C: 12M locked, wants 12M (1:1)

The UI sorts by best odds for the taker: B first (2:1, cheapest), then A or C (1:1).

**Fill sequence:**
1. Fill Coin B entirely: taker puts up 4M, pot = 12M. (Remaining budget: 11M)
2. Fill Coin A entirely: taker puts up 5M, pot = 10M. (Remaining budget: 6M)
3. Coin C wants 12M but taker only has 6M left. **Cannot partially fill** (see section 4).
   Stop here.

Result: taker filled 2 coins for 9M total stake. 6M unused.

Each fill is a separate `fillBet()` transaction executed sequentially (the TXN_LOCK
serializes them). The UI shows a single "Fill" action with a progress indicator.

### 3.4 Aggregated Depth View (Future Enhancement)

Group offers by odds tier and show aggregated depth:

```
  FOR side depth:
  2:1  —  8.0 M  (1 offer)
  1:1  — 17.0 M  (2 offers)
```

This is purely a rendering choice. No contract or data model change.

---

## 4. Partial Fill — Analysis and Recommendation

### The Problem

Counter wants to bet 7M but the only offer wants 20M. Can the counter take 7M worth
and leave 13M as a still-open offer?

### What Partial Fill Would Require (On-Chain)

A partial fill transaction would need to:
1. Consume the 20M coin (input)
2. Create a matched coin for the filled portion (output 1: at script address, phase=1)
3. Create a remainder coin for the unfilled portion (output 2: at script address, phase=0)
4. Add the counter's 7M funding (input 2+)
5. Handle change back to counter if overfunded

The contract must validate ALL of this. Currently, the fill path checks:
```
ASSERT VERIFYOUT(@INPUT @ADDRESS @AMOUNT+ws @TOKENID TRUE)
```
This creates ONE output at the script address for the full pot. A partial fill needs
TWO outputs at the script address — one for the filled portion, one for the remainder.

### Contract Impact

The fill path would need to become something like:
```
IF STATE(20) EQ 1 THEN
  LET fa=STATE(21)
  ASSERT VERIFYOUT(@INPUT @ADDRESS fa+STATE(22) @TOKENID TRUE)
  ASSERT VERIFYOUT(@INPUT+1 @ADDRESS @AMOUNT-fa @TOKENID TRUE)
ELSE
  ASSERT VERIFYOUT(@INPUT @ADDRESS @AMOUNT+ws @TOKENID TRUE)
ENDIF
```

This adds ~200 chars to the main script. The current main script is already at the
limit. Even with MAST, the partial-fill path is a "common" path (not rare like
timeout), so putting it in MAST defeats the purpose — MAST leaves cost gas on every
execution that hits them.

### Recommendation: No Partial Fill in V1

**Do not implement partial fill.** Instead:

1. **Encourage granular posting.** The "Post Bet" UI should suggest splitting large
   bets into smaller chunks. Instead of one 20M offer, post four 5M offers. This is
   the natural UTXO approach — more coins, each independently fillable.

2. **UI guidance.** When posting, show: "Tip: smaller offers fill faster. Consider
   splitting into multiple offers."

3. **Batch post.** Add a convenience function: `postBetBatch(params, splitCount)` that
   posts N identical coins in sequence. User posts "20M split 4 ways" and gets four
   5M coins.

4. **Revisit in V2** if user feedback demands it. A partial-fill MAST leaf could be
   added later, but only if the script budget allows.

---

## 5. Arbiter Model — One Arbiter Per Market

### Decision

All bets in the same market share the same arbiter. This is already naturally enforced
by the market key: `SHA3(proposition_hex + arbiter_pubkey)`.

### Why Same Arbiter

1. **Consistent resolution.** If two coins on the same proposition have different
   arbiters, they could receive contradictory rulings. Coin A's arbiter says TRUE,
   Coin B's arbiter says FALSE. The proposition was the same event. This is incoherent.

2. **Arbiter can batch-settle.** With one arbiter for all coins on a market, the arbiter
   sees all matched coins and can resolve them in sequence. Each `resolveBet()` call is
   independent, but the arbiter only decides the outcome once.

3. **Self-settle still per-pair.** Two counterparties on Coin A can self-settle (both
   sign) without involving anyone from Coin B. The arbiter is only needed if they disagree.

### Arbiter Scalability

With N matched coins on a market, the arbiter may need to resolve up to N disputes.
Each resolution is a separate transaction. This is O(N) work for the arbiter.

**Mitigation:** Most bets self-settle (0% fee incentive). The arbiter only handles
disputes. In practice, the arbiter resolves a small fraction of N.

**Future enhancement (V2):** Arbiter batch-resolve tool. A dedicated UI for arbiters
that shows all disputes on a market and lets them resolve all with one click (fires
N transactions sequentially).

---

## 6. Settlement Flow for Multi-Party Markets

### Scenario

Market: "Lakers beat Celtics"
- Coin 1: Alice (FOR, 10M) vs Bob (AGAINST, 10M)
- Coin 2: Alice (FOR, 5M) vs Carol (AGAINST, 5M)
- Coin 3: Dave (FOR, 8M) vs Eve (AGAINST, 4M)

Lakers win. All three coins should settle TRUE (FOR wins).

### Settlement Paths (unchanged from 1-vs-1)

**Path A — Self-settle (0% fee):**
Each pair settles independently:
- Coin 1: Alice proposes TRUE. Bob accepts (co-signs). Alice gets pot minus Bob's escrow return.
- Coin 2: Alice proposes TRUE. Carol accepts. Same math.
- Coin 3: Dave proposes TRUE. Eve accepts.

Each is a separate on-chain transaction. The auto-accept optimization (dual-propose)
works: if Bob also proposes TRUE before seeing Alice's proposal, the auto-cosign fires.

**Path B — Arbiter resolve (10% fee):**
Carol disputes Coin 2 (refuses to accept TRUE). The arbiter resolves:
- Arbiter signs Coin 2 with outcome=1 (TRUE). Alice gets 90%, arbiter gets 10%.
- Coins 1 and 3 settled normally via self-settle.

**Path C — Timeout:**
Eve goes offline. Coin 3 ages past timeout. Anyone can claim the timeout MAST path.
Both Dave and Eve get their original stakes back (proportional refund).

### New: Market-Level Settle Hint

To improve UX when a user has multiple bets on the same market:

When Alice proposes TRUE on Coin 1, the UI asks: "You have 2 bets on this market.
Propose TRUE for all?" If yes, `selfSettle()` is called for each coin in sequence.

This is purely UI orchestration. No contract change.

### What If Counterparties Disagree Across Coins?

This is fine. Each coin is independent. Bob can accept TRUE on Coin 1 while Carol
disputes TRUE on Coin 2. The arbiter resolves only Coin 2. No cross-coin dependency.

---

## 7. Liquidity Pool Concept — Analysis and Rejection

### The Polymarket Model

A true prediction market pool would work like:
- Anyone deposits to FOR or AGAINST side of a pool
- Shares are proportional to deposit size
- Settlement pays all winners proportionally from the total pool
- Continuous deposit/withdrawal until market closes

### Why This Cannot Work on Minima V3.1

1. **No loops in payouts.** The contract must VERIFYOUT for each recipient. With N
   participants, that is N VERIFYOUT calls. KISS VM has 1024 instructions max. Each
   VERIFYOUT costs ~5 instructions plus the address lookup. Practical limit: ~10-15
   participants per coin. But the contract cannot know N at deploy time — it must be
   hardcoded or use a loop, and WHILE loops with VERIFYOUT inside are gas-expensive.

2. **State port limits.** Storing N participants' addresses and stakes requires 2N
   state ports (address + amount). With 255 ports and overhead, max ~100 participants.
   But the contract needs to READ all of them at settlement time, which burns instructions.

3. **Proportional math.** Computing `(myStake / totalSideStake) * totalPot` for each
   participant requires division per participant. In a loop of N, that is N divisions,
   N multiplications, N VERIFYOUT calls. Script size explodes.

4. **No atomic multi-deposit.** In UTXO, adding to a pool means consuming the pool
   coin and recreating it with more funds. This is sequential — only one deposit can
   happen per block. On Minima's ~50s block time, 10 depositors take ~8 minutes to
   all get in.

### The Stack Model Achieves the Same Goal

The stacked 1-vs-1 model IS a marketplace. It provides:
- Multiple participants per side (each in their own coin)
- Aggregated depth visible in the order book
- Independent settlement (more robust than a pool)
- No single point of failure (one bad coin does not affect others)

The only thing lost compared to a pool is continuous price discovery with a single
number. But on Minima's scale (not millions of traders), the discrete order book is
more appropriate.

---

## 8. Smart Contract Changes Needed

**None.**

The V3.1 contract handles the marketplace as-is. Every marketplace bet is a standard
1-vs-1 bet. The contract does not need to know it is part of a larger market.

### Contract Stays the Same

```
State ports 0-17: unchanged
Fill path: unchanged
Self-settle path: unchanged
Arbiter resolve path: unchanged
Timeout MAST: unchanged
Refresh MAST: unchanged
Void MAST: unchanged
```

### Future Contract Changes (V4, if needed)

If partial fill demand is high, a V4 contract could add a MAST leaf for split-fill:
```
MAST leaf: partial fill
  ASSERT SAMESTATE(0 3) ASSERT STATE(4) EQ 1
  LET fa=STATE(21)
  ASSERT VERIFYOUT(@INPUT @ADDRESS fa+STATE(22) @TOKENID TRUE)
  ASSERT VERIFYOUT(@INPUT+1 @ADDRESS @AMOUNT-fa @TOKENID TRUE)
  RETURN TRUE
```
This would be ~250 chars as a MAST leaf (independent of main script size). But it
adds complexity to the fill transaction builder and creates two coins from one, which
doubles the settlement surface. Defer unless demand is clear.

---

## 9. UI Changes for the Order Book

### 9.1 Markets View (replaces flat list of open bets)

**Current:** Flat list of all open coins, each shown as a card.
**New:** Grouped by market. Each market is a collapsible section.

```
+----------------------------------------------------------+
|  MARKETS                                    [+ New Bet]  |
+----------------------------------------------------------+
|                                                          |
|  ┌─ "Lakers beat Celtics" ────────────── SportsOracle ─┐ |
|  │  FOR: 3 offers, 23.0M total                         │ |
|  │  AGAINST: 2 offers, 15.0M total                     │ |
|  │  Best FOR odds: 3:1  |  Best AGAINST odds: 2:1      │ |
|  │                              [ View Book ] [ Take ]  │ |
|  └──────────────────────────────────────────────────────┘ |
|                                                          |
|  ┌─ "BTC > $100K by June" ──────────── CryptoArbiter ─┐ |
|  │  FOR: 1 offer, 5.0M                                 │ |
|  │  AGAINST: 0 offers                                  │ |
|  │  Best FOR odds: 1:1                                 │ |
|  │                              [ View Book ] [ Take ]  │ |
|  └──────────────────────────────────────────────────────┘ |
+----------------------------------------------------------+
```

### 9.2 Order Book Detail View

Tapping "View Book" opens the depth view from section 3.1. Shows individual offers
sorted by odds, with a "Take" flow at the bottom.

### 9.3 Take Flow (Sweep)

When user taps "Take AGAINST" on a market:

```
+----------------------------------------------------------+
|  Take AGAINST: "Lakers beat Celtics"                     |
+----------------------------------------------------------+
|                                                          |
|  Available FOR offers (you take the other side):         |
|                                                          |
|  [x] 8.0M @ 2:1 by Alice    — you pay: 4.0M            |
|  [x] 5.0M @ 1:1 by Bob      — you pay: 5.0M            |
|  [ ] 10.0M @ 1:1 by Carol   — you pay: 10.0M           |
|                                                          |
|  Selected: 2 offers                                      |
|  Your total stake: 9.0M (incl 25% escrow: 11.25M)       |
|  Potential winnings: 16.25M (minus escrow returns)       |
|                                                          |
|  Amount to risk: [ 9.0    ] M                            |
|  [ Fill Selected Offers ]                                |
|                                                          |
+----------------------------------------------------------+
```

The user can:
- **Check/uncheck individual offers** to choose which to fill
- **Enter a total amount** and the UI auto-selects offers (best odds first) up to that amount
- Offers that exceed remaining budget are greyed out

### 9.4 Post Flow (Market-Aware)

When posting a new bet, the user selects an existing market or creates one:

```
+----------------------------------------------------------+
|  Post a Bet                                              |
+----------------------------------------------------------+
|                                                          |
|  Market: [ Select existing... ▼ ]                        |
|          [ ] Create new market                           |
|                                                          |
|  Your side: ( ) FOR  ( ) AGAINST                         |
|  Your stake: [ 10.0 ] M                                  |
|  Wanted stake: [ 10.0 ] M                                |
|  Odds: 1:1                                               |
|                                                          |
|  Split into: [ 1 ▼ ] offers                              |
|  (Smaller offers fill faster)                            |
|                                                          |
|  [ Post Bet ]                                            |
+----------------------------------------------------------+
```

The "Split into" dropdown lets the user post 1, 2, 3, 4, or 5 identical offers
from a single action.

---

## 10. Batch Post Implementation

### postBetBatch()

```javascript
function postBetBatch(params, splitCount, callback) {
    if (!splitCount || splitCount < 1) splitCount = 1;
    if (splitCount > 5) splitCount = 5; // Safety cap

    var perStake = (parseFloat(params.stake) / splitCount).toFixed(8);
    var perWant = (parseFloat(params.wantstake) / splitCount).toFixed(8);

    var posted = 0;
    var failed = 0;

    function postNext() {
        if (posted + failed >= splitCount) {
            notify("Batch complete: " + posted + " posted, " + failed + " failed", posted > 0 ? "ok" : "err");
            callback(posted > 0);
            return;
        }
        var batchParams = Object.assign({}, params, {
            stake: perStake,
            wantstake: perWant
        });
        postBet(batchParams, function(ok) {
            if (ok) posted++; else failed++;
            postNext();
        });
    }
    postNext();
}
```

### fillMultiple()

```javascript
function fillMultiple(bets, callback) {
    var filled = 0;
    var failed = 0;

    function fillNext() {
        if (filled + failed >= bets.length) {
            notify("Filled " + filled + " of " + bets.length + " offers", filled > 0 ? "ok" : "err");
            callback(filled);
            return;
        }
        fillBet(bets[filled + failed], function(ok) {
            if (ok) filled++; else failed++;
            fillNext();
        });
    }
    fillNext();
}
```

Both functions use the existing `postBet` and `fillBet` under the hood. The TXN_LOCK
serializes them. Each is a fully independent on-chain transaction.

---

## 11. Database Changes

### Markets Table Enhancement

The existing `markets` table gets a computed key column:

```sql
ALTER TABLE markets ADD COLUMN marketkey VARCHAR(128);
```

Populated as: `SHA3(proposition_hex + arbiter_pubkey)`. Used for grouping.

### Bets Table Enhancement

Add a marketkey column for fast lookups:

```sql
ALTER TABLE bets ADD COLUMN marketkey VARCHAR(128);
```

Set at insert time. Enables: `SELECT * FROM bets WHERE marketkey='...' AND status='OPEN'`.

### No New Tables

The marketplace does not require new tables. Markets already exist. Bets already exist.
The grouping is a query-time operation.

---

## 12. Migration Path

### Phase 0 — Current (no changes, already works)

Users post and fill 1-vs-1 bets. No marketplace view. This is Wager v2.1.x.

### Phase 1 — Market Grouping (UI only)

**Target: v2.2.0**

Changes:
- `groupByMarket()` function in state.js
- Markets view replaces flat open-bet list
- Order book detail view per market
- "Select existing market" in post flow
- `marketkey` column added to bets and markets tables
- No contract changes
- No transaction builder changes

What users get:
- See all offers on the same proposition grouped together
- See aggregated depth per side
- Easier to find and compare offers

### Phase 2 — Multi-Fill (UI orchestration)

**Target: v2.3.0**

Changes:
- `fillMultiple()` in txn.js
- Take flow with offer selection and budget input
- Progress indicator for sequential fills
- No contract changes

What users get:
- Take multiple offers in one action
- Choose size by combining offers
- Best-odds-first auto-selection

### Phase 3 — Batch Post + Market Settle Hints

**Target: v2.4.0**

Changes:
- `postBetBatch()` in txn.js
- Split-post UI in post flow
- Market-level settle hint ("Propose TRUE for all your bets on this market?")
- Arbiter batch-resolve tool (if arbiter demand exists)
- No contract changes

### Phase 4 — Partial Fill (if demand warrants)

**Target: v3.0.0 (major version — contract change)**

Changes:
- New MAST leaf for split-fill
- New contract V4 with updated MAST root
- Updated fillBet to handle partial amounts
- Remainder coin tracking
- Full regression testing of all settlement paths

This phase is **optional** and should only happen if real users consistently report
that offers are too large to fill. The batch-post feature in Phase 3 may eliminate
the need entirely.

---

## 13. Risks and Limitations

### Race Conditions on Fill

Two users try to fill the same coin simultaneously. One succeeds, the other fails
(coin already spent). This is inherent to UTXO and cannot be avoided.

**Mitigation:** The `fillBet` function already handles stale coinids (searches by
proposition if coinid not found). The UI should show "Offer taken by someone else"
gracefully and suggest trying the next offer.

With multiple offers on the same market, a failed fill is less painful — the user
just fills the next available coin.

### Proposition Text Canonicalization

Free-form text means "Lakers win" and "Lakers Win" are different markets. The
`marketKey` function hashes the raw hex, so case matters.

**Mitigation:** When selecting an existing market, the user picks from a dropdown
(exact match). When creating a new market, the UI lowercases and trims. Long-term,
market templates or categories could help.

### Arbiter Trust Concentration

One arbiter per market means all bettors must trust the same party. If the arbiter
is malicious or disappears, all disputed coins on that market are stuck until timeout.

**Mitigation:** Timeout MAST already handles arbiter disappearance (proportional
refund after timeout blocks). For trust, the app should show arbiter reputation
(number of resolved bets, dispute rate) — future feature.

### Sequential Fill Latency

Filling 5 coins sequentially takes 5 transaction cycles. At ~50s per block, that
is ~4 minutes if all go into different blocks. In practice, multiple fills can land
in the same block if submitted quickly.

**Mitigation:** The TXN_LOCK serializes construction, not confirmation. All 5
transactions can be built and posted within seconds. They confirm independently.
The UI shows them as "pending" with a progress bar.

### No Atomic Multi-Fill

If the user wants to fill 3 coins and the second one fails (already taken), the
first is already confirmed and the third still proceeds. There is no atomic
"fill all or none."

**Mitigation:** This is acceptable. Each fill is a complete, valid bet. The user
does not lose money from a partial batch — they just get fewer bets than intended.
The UI updates the remaining offers after each fill.

### Scale Limits

Each market could have hundreds of open coins. The `coins address:` command returns
all coins at the script address (ALL markets combined). With 1000 open coins across
50 markets, parsing is cheap but the initial load grows.

**Mitigation:** Pagination in the coins query (Minima supports `coins relevant:true`
for own coins). For the marketplace view, cache and diff rather than full reload.
At Minima's current user scale, this is not a near-term problem.

---

## 14. Summary of Changes by Layer

| Layer | What Changes | What Stays |
|-------|-------------|------------|
| **Contract** | Nothing | V3.1 script, all MAST leaves, state port layout |
| **txn.js** | Add `postBetBatch()`, `fillMultiple()` | `postBet()`, `fillBet()`, all settle/resolve functions |
| **state.js** | Add `groupByMarket()`, `marketKey()` | `parseBetCoin()`, `refreshBets()`, all proposal logic |
| **db.js** | Add `marketkey` column to bets + markets | All existing tables and queries |
| **app.js** | New Markets view, order book detail, take flow, batch post UI | My Bets view, settlement flow, chat |
| **contract.js** | Nothing | Script text, MAST proofs, registration |

**Total new JS code estimate:** ~400 lines across state.js, txn.js, app.js.
**Contract risk:** Zero (no changes).
**Breaking changes:** None. All existing bets continue to work. The marketplace is additive.
