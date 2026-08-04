# Openly Housekeeping — Design Document

**Version:** 0.1 (draft)
**Date:** 2026-04-09
**Baseline:** Openly v2.2.0, contract V3.1, MAST 3-leaf

---

## 1. The Problem

During testing with `REFRESH_AGE = 10` (auto-refresh every 10 blocks), 1400+
pending actions accumulated. Root causes:

1. **Auto-refresh on read-permission apps.** `service.js` fires `txnsign` on
   every stale coin. In "read" permission mode, each `txnsign` creates a pending
   action in MiniHub. At `REFRESH_AGE = 10` with even a handful of coins, this
   compounds fast.

2. **Failed transactions not cleaned up.** Some error paths called `txndelete`
   but the pending action in MDS was already created and never denied.

3. **Rapid clicks creating duplicate txncreate.** The `TXN_LOCKED` queue in
   txn.js serializes transactions but does not prevent the user from clicking
   "Post" or "Take" multiple times before the lock is acquired.

4. **MiniHub approval never seen.** Pending actions sit in MiniHub's Pending
   Actions screen. Most users never navigate there, so they pile up forever.

---

## 2. UI Layout

### 2.1 Entry Point: More Menu

Add a "Housekeeping" card to `renderMoreView()` in app.js, below the existing
Arbiter/History/Activity cards:

```
More
  [Arbiter]         — Resolve disputed bets
  [History]         — Transaction log
  [Activity Log]    — All system messages
  [Housekeeping]    — Pending actions & system health  <-- NEW
```

The card shows a warning badge when there are pending actions or stale
transaction workspaces:

```html
<div class="qcard" onclick="showView('housekeeping')">
  Housekeeping <span class="badge badge--warn">14 pending</span>
  <span class="qcard__meta">Clean up stuck transactions</span>
</div>
```

Badge logic: `pendingCount + staleTxnCount > 0` shows the count in gold.
The More tab itself gets a small dot indicator when count > 0.

### 2.2 Housekeeping View

Single scrollable screen, three sections stacked vertically:

```
[Housekeeping]

--- Pending Actions (14) ---
These are MDS actions waiting for approval in MiniHub.
Most are from auto-refresh and can be safely denied.

  [Clear All Pending]     (red button, confirm dialog)
  [View List]             (expand to see individual items)

--- Transaction Workspaces (3) ---
Open txncreate sessions. Stale ones lock coins.

  autorefresh_1712345678   created 2h ago   [Delete]
  autorefresh_1712345999   created 1h ago   [Delete]
  wager_fill_1712346123    created 3h ago   [Delete]

  [Delete All Stale]      (items older than 30 min)

--- Health Check ---
  Contract registered     [OK]
  Coinnotify active       [OK]
  Wallet keys loaded      [OK]
  Permission mode         [read]  (pending actions expected)
  Orphaned coins          [0 found]
```

---

## 3. MDS Commands for Each Operation

### 3.1 Pending Actions

| Action | Command | Notes |
|--------|---------|-------|
| List pending | `mds action:pending` | Returns array of `{uid, command, ...}` |
| Deny one | `mds action:deny uid:<uid>` | Removes from pending list |
| Accept one | `mds action:accept uid:<uid>` | Executes the command |
| Deny all | Loop: `mds action:deny uid:<uid>` for each | No bulk command exists |

Implementation for "Clear All Pending":
```javascript
function clearAllPending(callback) {
    MDS.cmd("mds action:pending", function(res) {
        if (!res.status || !res.response || res.response.length === 0) {
            callback(0); return;
        }
        var actions = res.response;
        var idx = 0;
        function denyNext() {
            if (idx >= actions.length) { callback(actions.length); return; }
            MDS.cmd("mds action:deny uid:" + actions[idx].uid, function() {
                idx++;
                denyNext();
            });
        }
        denyNext();
    });
}
```

### 3.2 Transaction Workspaces

| Action | Command | Notes |
|--------|---------|-------|
| List open | `txnlist` | Returns array of transaction workspace objects |
| Delete one | `txndelete id:<id>` | Frees locked coins |
| Delete all stale | Loop `txndelete` for workspaces older than threshold | No bulk command |

Note: `txnlist` does not include a creation timestamp. We must infer staleness
from the transaction ID naming convention (e.g., `autorefresh_<timestamp>`) or
treat all workspaces as potentially stale if they are not in the active
`TXN_LOCKED` queue.

### 3.3 Health Check

| Check | Command | What to verify |
|-------|---------|----------------|
| Contract registered | `scripts` | `WAGER_SCRIPT_ADDRESS` appears in response |
| Coinnotify active | `coinnotify action:list` | Mail address is registered |
| Wallet keys loaded | `keys` | Response contains at least one key |
| Permission mode | `mds` | Check this app's permission field |
| Orphaned coins | `coins address:<WAGER_SCRIPT_ADDRESS>` | Compare against local DB bets |

Orphaned coin detection:
```javascript
function findOrphanedCoins(callback) {
    MDS.cmd("coins address:" + WAGER_SCRIPT_ADDRESS, function(res) {
        if (!res.status) { callback([]); return; }
        var coins = res.response || [];
        MDS.sql("SELECT DISTINCT coinid FROM bets", function(dbRes) {
            var knownIds = {};
            if (dbRes.rows) dbRes.rows.forEach(function(r) { knownIds[r.COINID] = true; });
            var orphans = coins.filter(function(c) { return !knownIds[c.coinid]; });
            callback(orphans);
        });
    });
}
```

---

## 4. Detecting Stale vs Legitimate Pending Actions

### The Core Distinction

A pending action is **legitimate** if the user intentionally triggered it and is
waiting for it (e.g., they clicked "Post Bet" and need to approve the txnsign in
MiniHub). A pending action is **stale** if it was created automatically or the
user has moved on.

### Detection Heuristics

1. **Command content.** Parse the `command` field of each pending action:
   - Contains `autorefresh_` in the txn ID --> auto-refresh, safe to deny
   - Contains `txnsign` but no matching `PENDING_TXID` in app state --> stale
   - Contains `send` --> likely a manual action, warn before denying

2. **Age.** Pending actions older than 30 minutes are almost certainly stale.
   The user has either left the app or forgotten about them. Exception: dispute
   resolution transactions could legitimately wait longer.

3. **Batch size.** If there are 50+ pending actions, it is overwhelmingly likely
   they are all auto-refresh artifacts. A user does not manually trigger 50
   transactions in a session.

4. **Current session state.** If `PENDING_TXID` is set in app.js, that specific
   UID should be preserved. Everything else can be safely denied.

### UI Presentation

When the user taps "Clear All Pending":

- If `PENDING_TXID` is set: "You have 1 active transaction waiting for approval.
  Clear the other 13?" with [Keep Active, Clear All] buttons.
- If all appear to be auto-refresh: "14 pending actions (all from auto-refresh).
  Safe to clear." with a single [Clear All] button.
- If some look manual: "14 pending actions. 12 are auto-refresh, 2 may be
  manual transactions. Review?" with [Clear Auto-Refresh Only, Clear All, Cancel].

---

## 5. Prevention: Stopping the Pile-Up

### 5.1 Check Permission Mode Before Auto-Refresh

The single most impactful fix. In `checkAndRefreshCoins()` in service.js, check
the app's permission level first. If the app is in "read" mode, skip auto-refresh
entirely because every txnsign will create a pending action that the user must
manually approve in MiniHub.

```javascript
// At top of checkAndRefreshCoins():
function checkAndRefreshCoins() {
    if (!WAGER_SCRIPT_ADDRESS || REFRESH_RUNNING) return;

    // Don't auto-refresh in read mode — creates unapproved pending actions
    MDS.cmd("mds", function(mdsRes) {
        if (!mdsRes.status) return;
        var myApp = (mdsRes.response || []).find(function(a) {
            return a.conf && a.conf.name === "Openly";
        });
        if (myApp && myApp.permission === "read") {
            // Log once, don't spam
            if (!REFRESH_READ_WARNED) {
                MDS.log("Auto-refresh skipped: app is in read mode. Set to write in MiniHub.");
                REFRESH_READ_WARNED = true;
            }
            return;
        }
        doRefreshCoins(); // existing refresh logic, extracted to function
    });
}
```

This is the fix that would have prevented the 1400 pending actions entirely.

### 5.2 Debounce User Clicks

The `TXN_LOCKED` queue prevents concurrent transactions but does not prevent
the user from queueing up duplicates. Add a simple UI-level debounce:

```javascript
// In app.js — disable buttons during transaction
function disableActionButtons() {
    document.querySelectorAll('.btn--action').forEach(function(b) {
        b.disabled = true;
        b.classList.add('btn--disabled');
    });
}
function enableActionButtons() {
    document.querySelectorAll('.btn--action').forEach(function(b) {
        b.disabled = false;
        b.classList.remove('btn--disabled');
    });
}
```

Call `disableActionButtons()` when a transaction starts, `enableActionButtons()`
in both success and error callbacks. The `POST_PENDING` flag in `doPost()` is
already doing this for the Post view -- extend the same pattern to fillBet,
settlePropose, and disputeEscalate.

### 5.3 Clean Up Pending Actions on Service Start

On `inited`, run `mds action:pending` and auto-deny any actions whose command
contains `autorefresh_`. These are leftovers from a previous session and the
coins they referenced have probably changed coinid by now.

```javascript
// In service.js, inside msg.event === "inited":
function cleanupStalePending() {
    MDS.cmd("mds action:pending", function(res) {
        if (!res.status || !res.response) return;
        var stale = res.response.filter(function(a) {
            return a.command && a.command.indexOf("autorefresh_") >= 0;
        });
        if (stale.length === 0) return;
        MDS.log("Cleaning " + stale.length + " stale auto-refresh pending actions");
        stale.forEach(function(a) {
            MDS.cmd("mds action:deny uid:" + a.uid);
        });
    });
}
```

### 5.4 REFRESH_AGE Guard

Already done in v2.2.0: `REFRESH_AGE = 1200` (was 10 during testing). Add a
floor check so it cannot be accidentally set too low:

```javascript
var REFRESH_AGE = Math.max(1200, REFRESH_AGE || 1200);
```

### 5.5 txndelete on Every Exit Path

Audit all transaction flows to confirm `txndelete` is called on every error
path. The current codebase is mostly good about this (txn.js calls txndelete on
all failure branches). The gap is when the process crashes or MDS restarts
mid-transaction -- these orphaned workspaces should be cleaned up by the
Housekeeping screen or on service init via `txnlist` + `txndelete`.

---

## 6. Implementation Plan

### Phase 1: Prevention (high impact, low effort)

1. Add permission check to `checkAndRefreshCoins()` in service.js
2. Add `cleanupStalePending()` to service.js `inited` handler
3. Add `REFRESH_AGE` floor guard in state.js

### Phase 2: Housekeeping UI

4. Add "housekeeping" view to `showView()` switch in app.js
5. Add `renderHousekeepingView()` with pending count, clear button, txnlist
6. Add badge count to More menu card
7. Add health check panel (contract, coinnotify, keys, permission mode)

### Phase 3: Polish

8. Add orphaned coin detection and recovery
9. Add per-item pending action list with individual deny/accept
10. Add "last cleaned" timestamp to MDS.keypair for showing freshness

---

## 7. Data Flow Summary

```
User taps More > Housekeeping
  |
  +--> mds action:pending    --> count + list of pending UIDs
  +--> txnlist               --> count + list of open workspaces
  +--> scripts               --> contract registered?
  +--> coinnotify action:list --> mail address registered?
  +--> keys                  --> wallet keys loaded?
  +--> mds                   --> permission mode (read/write)?
  |
  v
Render Housekeeping view with all results
  |
  User taps [Clear All Pending]
  |
  +--> Confirm dialog (warn if PENDING_TXID active)
  +--> Loop: mds action:deny uid:<uid> for each
  +--> Re-render with updated count
  |
  User taps [Delete All Stale] (txn workspaces)
  |
  +--> Loop: txndelete id:<id> for each
  +--> Re-render with updated count
```

---

## 8. Open Questions

1. **Should auto-cleanup run silently?** The service already handles pending
   on init, but should it also periodically clear old pending actions (e.g.,
   in `MDS_TIMER_10SECONDS`)? Risk: denying a legitimate action the user just
   hasn't gotten to yet. Recommendation: only auto-cleanup `autorefresh_` items,
   leave everything else for the user.

2. **Bulk accept?** Some pending actions might be legitimate transactions the
   user wants to approve. The Housekeeping screen could offer "Accept All" but
   this is dangerous -- accepting a stale transaction with an expired coinid
   will fail and waste gas. Recommendation: deny-only for bulk, accept only
   individually after inspection.

3. **Badge on the More tab icon?** Adding a dot/badge to the bottom nav More
   button when housekeeping items exist would improve discoverability. This
   requires checking pending count on every view render, which is one extra
   `mds action:pending` call. Acceptable overhead if cached with a 60-second TTL.
