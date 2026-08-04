# Wager Chat 2.0 — Design Document

**Version:** 0.1 (draft)
**Target release:** Wager v2.1.0
**Date:** 2026-04-09

## 1. Overview

Chat 2.0 adds real-time Maxima-based messaging alongside the existing ChainMail system.
ChainMail (on-chain, encrypted, 0.001 M per message) stays for critical transaction
messages. Maxima (off-chain, free, instant) handles casual conversation and discovery.

**What changes:**
- New `js/maxchat.js` module for all Maxima direct messaging
- New `contacts` and `chat_messages` SQL tables
- New "Chat" tab in bottom nav (replaces "More" overflow)
- Auto-contact exchange when two users interact on the same bet
- 1-on-1 real-time chat threads attached to bets
- Public lobby/chatroom for discovery (Maxima broadcast)

**What stays the same:**
- ChainMail for BET_CREATED, BET_MATCHED, SETTLE_PROPOSE, SETTLE_ACCEPT, SETTLE_REJECT, DISPUTE
- All existing transaction flows, contract logic, and state port layout
- MxKeys stored in coin state ports 15-17 and bets DB table


## 2. Auto-Contact Exchange

### Problem
Users currently have MxKeys (from coin state ports 15-17 and the bets table) but
no Maxima contact relationship. Maxima requires an explicit `contactadd` before
direct messaging works.

### Flow

Contact exchange happens silently at two trigger points:

**Trigger A — Filling a bet (filler side):**
```
User fills a bet -> fillBet() succeeds -> txn confirmed
  -> Read owner's MxKey from coin state port 15
  -> Call: maxima action:contactadd address:<owner_mxkey>
  -> Insert into contacts table (mxkey, name, source='bet_fill', betid)
  -> Send a MAXIMA_HELLO message via Maxima direct (see below)
```

**Trigger B — Receiving BET_MATCHED message (owner side):**
```
handleBetMatched() fires -> message contains counter_mxkey
  -> Call: maxima action:contactadd address:<counter_mxkey>
  -> Insert into contacts table (mxkey, name, source='bet_matched', betid)
```

**Trigger C — Receiving a MAXIMA_HELLO (either side):**
```
MAXIMA event arrives -> application='wager' -> type='HELLO'
  -> Extract sender's contact_id from msg.data.from
  -> Call: maxima action:contactadd address:<sender_mxkey> (if not already added)
  -> Insert/update contacts table
  -> Reply with MAXIMA_HELLO_ACK (confirms bidirectional contact)
```

### MAXIMA_HELLO message format
```json
{
  "type": "HELLO",
  "mxkey": "<sender's MxKey>",
  "name": "<sender's Maxima name>",
  "betid": "<coinid that triggered the exchange>",
  "version": "2.1.0"
}
```

### API calls
```javascript
// Add contact (idempotent — safe to call if already added)
MDS.cmd("maxima action:contactadd address:" + mxkey, function(res) { ... });

// Send HELLO via Maxima direct message
var helloData = strToHex(JSON.stringify(helloPayload));
MDS.cmd("maxima action:send to:" + contactId + " application:wager data:" + helloData, ...);
```

### Contact ID vs MxKey
Maxima `contactadd` takes an MxKey (Mx...) and returns a contact entry with an `id`
field. The `action:send` command uses this `id` (or the full contact address), not the
raw MxKey. After adding a contact, look them up:
```javascript
MDS.cmd("maxima action:contactlist", function(res) {
    var contacts = res.response || [];
    var match = contacts.find(function(c) { return c.publickey === mxkey; });
    if (match) {
        // match.id is what you pass to action:send to:<id>
    }
});
```


## 3. Database Schema Changes

### New table: `contacts`
```sql
CREATE TABLE IF NOT EXISTS contacts (
    id         BIGINT AUTO_INCREMENT,
    mxkey      VARCHAR(1024) NOT NULL,
    contact_id VARCHAR(256),
    name       VARCHAR(256),
    source     VARCHAR(64),
    betid      VARCHAR(160),
    last_seen  BIGINT,
    created    BIGINT NOT NULL
);
```
- `mxkey` — The Mx... public key (unique identifier)
- `contact_id` — Maxima's internal contact ID (populated after contactadd succeeds)
- `name` — Display name (from Maxima or from HELLO message)
- `source` — How we got this contact: 'bet_fill', 'bet_matched', 'lobby', 'manual'
- `betid` — The bet that triggered the exchange (nullable)
- `last_seen` — Timestamp of last message received from this contact

### New table: `chat_messages`
```sql
CREATE TABLE IF NOT EXISTS chat_messages (
    id          BIGINT AUTO_INCREMENT,
    msg_id      VARCHAR(128) NOT NULL,
    thread_id   VARCHAR(256) NOT NULL,
    sender_key  VARCHAR(1024) NOT NULL,
    sender_name VARCHAR(256),
    body        VARCHAR(4096),
    direction   VARCHAR(16) NOT NULL,
    read_flag   INT DEFAULT 0,
    created     BIGINT NOT NULL
);
```
- `msg_id` — Random unique ID for dedup (same pattern as ChainMail randomid)
- `thread_id` — Identifies the conversation. Format: `dm:<mxkey_hash>` for 1-on-1, `lobby` for chatroom
- `sender_key` — Sender's MxKey
- `body` — Plain text message (max 4096 chars, truncated on receive)
- `direction` — 'sent' or 'received'
- `read_flag` — 0 = unread, 1 = read (for badge counts)

### Existing `messages` table
Unchanged. Continues to store ChainMail transaction messages (SETTLE_PROPOSE, etc.).
The existing CHAT_MESSAGE type in the messages table is deprecated — new chat goes
to `chat_messages` via Maxima instead of ChainMail.


## 4. Message Protocol (Maxima)

All Maxima messages for Wager use `application:wager`. The data field is a hex-encoded
JSON object.

### Message types

| Type | Purpose | Direction |
|------|---------|-----------|
| HELLO | Contact exchange handshake | 1-to-1 |
| HELLO_ACK | Confirms contact exchange | 1-to-1 |
| DM | Direct message (1-on-1 chat) | 1-to-1 |
| LOBBY_MSG | Chatroom message | Broadcast |
| TYPING | Typing indicator (optional, v2.2) | 1-to-1 |

### DM message format
```json
{
  "type": "DM",
  "msg_id": "0xABCD1234...",
  "body": "Hey, are you going to settle this bet?",
  "betid": "0x...",
  "sender_name": "Alice",
  "sender_key": "Mx...",
  "ts": 1712678400000
}
```

### LOBBY_MSG format
```json
{
  "type": "LOBBY_MSG",
  "msg_id": "0xABCD1234...",
  "body": "Anyone want to bet on the Lakers game tonight?",
  "sender_name": "Alice",
  "sender_key": "Mx...",
  "ts": 1712678400000
}
```

### Sending a direct message
```javascript
function sendMaximaMsg(contactId, payload, callback) {
    var hexData = strToHex(JSON.stringify(payload));
    MDS.cmd("maxima action:send to:" + contactId +
            " application:wager data:" + hexData, function(res) {
        if (res.status) {
            callback(true);
        } else {
            callback(false, res.error);
        }
    });
}
```

### Receiving messages (in service.js)
```javascript
if (msg.event === "MAXIMA") {
    if (msg.data.application === "wager") {
        try {
            var payload = JSON.parse(hexToStr(msg.data.data));
            var from = msg.data.from;  // sender's contact address
            handleMaximaMessage(payload, from);
        } catch(e) {
            MDS.log("Bad Maxima message: " + e);
        }
    }
}
```


## 5. Module: js/maxchat.js

New file. Handles all Maxima chat operations. Loaded by both index.html and service.js.

### Functions

```
addWagerContact(mxkey, name, source, betid, callback)
    — Calls maxima contactadd, inserts into contacts table, sends HELLO

lookupContact(mxkey, callback)
    — Queries contacts table, returns {mxkey, contact_id, name} or null

sendDM(mxkey, body, betid, callback)
    — Looks up contact_id, builds DM payload, sends via Maxima, stores in chat_messages

sendLobbyMsg(body, callback)
    — Broadcasts LOBBY_MSG to all Maxima contacts running Wager

handleMaximaMessage(payload, from)
    — Routes HELLO, HELLO_ACK, DM, LOBBY_MSG to handlers

loadThread(threadId, limit, offset, callback)
    — Reads chat_messages for a thread, returns rows

getUnreadCount(callback)
    — SELECT COUNT(*) FROM chat_messages WHERE read_flag=0 AND direction='received'

markThreadRead(threadId, callback)
    — UPDATE chat_messages SET read_flag=1 WHERE thread_id=<threadId>

getContactList(callback)
    — Returns all contacts with last message preview and unread count
```


## 6. 1-on-1 Chat UX

### On bet cards (existing location, upgraded)
The current inline chat input on matched bet cards stays but switches from ChainMail
to Maxima. The `sendChatDirect()` function in app.js changes to call `sendDM()` from
maxchat.js instead of `sendChainMail()`.

**Before (v2.0.x):**
```
sendChainMail(counterMxKey, payload, callback)  // 0.001 M, ~50s delay
```

**After (v2.1.0):**
```
sendDM(counterMxKey, text, coinid, callback)  // free, instant
```

The chat preview row on collapsed bet cards now shows a green dot if the counterparty
is a confirmed Maxima contact (instant messaging available) or a grey dot if
ChainMail-only (legacy contact, no HELLO exchanged yet).

### Full chat thread view
Tapping the chat preview on a bet card opens a full-screen chat thread:

```
+------------------------------------------+
|  < Back          Alice          [i]      |
|------------------------------------------|
|                                          |
|  [Alice 2:30pm]                          |
|  Hey, ready to settle this?              |
|                                          |
|              [You 2:31pm]                |
|              Yeah, proposing TRUE now     |
|                                          |
|  -- System: SETTLE_PROPOSE sent --       |
|  -- System: SETTLE_ACCEPT received --    |
|                                          |
|------------------------------------------|
|  [Type a message...]            [Send]   |
+------------------------------------------+
```

**Key details:**
- Thread interleaves Maxima DMs with ChainMail system messages (SETTLE_PROPOSE, etc.)
- System messages are rendered differently (centered, muted, no bubble)
- Query: `SELECT * FROM chat_messages WHERE thread_id='dm:<hash>' UNION SELECT * FROM messages WHERE betid=<coinid> ORDER BY created`
- Thread ID is derived from counterparty MxKey: `dm:` + first 32 chars of MxKey hash
- Messages auto-scroll to bottom, load older messages on scroll-up (paginated)


## 7. Chatroom / Lobby

### Concept
A single shared chatroom where all Wager users with mutual Maxima contacts can
broadcast messages. This serves as a discovery mechanism — users can post about
bets they want to make, find counterparties, and initiate bets.

### How it works
Maxima does not have a true broadcast-to-strangers. It sends to known contacts only.
The lobby is therefore a **contact-scoped broadcast**: your message reaches everyone
in your Maxima contact list who runs Wager.

```javascript
function sendLobbyMsg(body, callback) {
    var payload = {
        type: "LOBBY_MSG",
        msg_id: "0x" + genRandomHex(32),
        body: body,
        sender_name: MY_MXNAME,
        sender_key: MY_MXKEY,
        ts: Date.now()
    };
    var hexData = strToHex(JSON.stringify(payload));

    MDS.cmd("maxima action:contactlist", function(res) {
        var contacts = res.response || [];
        var sent = 0;
        contacts.forEach(function(c) {
            MDS.cmd("maxima action:send to:" + c.id +
                    " application:wager data:" + hexData, function() {
                sent++;
            });
        });
        // Store own copy
        insertChatMessage({
            msg_id: payload.msg_id,
            thread_id: "lobby",
            sender_key: MY_MXKEY,
            sender_name: MY_MXNAME,
            body: body,
            direction: "sent"
        }, callback);
    });
}
```

### Lobby UI
```
+------------------------------------------+
|  Wager Lobby             [12 contacts]   |
|------------------------------------------|
|                                          |
|  [Bob 1:15pm]                            |
|  Anyone want 2:1 on Lakers tonight?      |
|                                          |
|  [Alice 1:18pm]                          |
|  I'll take that. DM me.                  |
|                                          |
|  [You 1:20pm]                            |
|  What's the line on the Celtics game?    |
|                                          |
|------------------------------------------|
|  [Type a message...]            [Send]   |
+------------------------------------------+
```

### Growth model
The lobby grows organically:
1. User A posts a bet. User B fills it. They auto-exchange contacts.
2. Now both A and B see each other's lobby messages.
3. User B later fills User C's bet. Now B and C are contacts.
4. B's lobby messages reach both A and C. The network grows with every bet.

### Relay (future, v2.2+)
A future enhancement could relay lobby messages one hop: when you receive a
LOBBY_MSG, optionally re-broadcast it to your contacts who haven't seen it
(tracked by msg_id dedup). This creates a gossip protocol that reaches users
2 hops away. Not in v2.1.0 — keep it simple first.


## 8. UI Layout — Chat Tab

### Bottom nav change
Replace the "More" tab with "Chat". Move the overflow items (Arbiter, History,
Activity) into a hamburger menu or settings icon in the top bar.

**Before:**
```
[ Markets ]  [ Post ]  [ My Bets ]  [ More ]
```

**After:**
```
[ Markets ]  [ Post ]  [ My Bets ]  [ Chat ]
```

### index.html change
```html
<button class="bottomnav__tab" data-view="chat" onclick="showView('chat')">
    <span class="bottomnav__icon" id="chatTabIcon">💬</span>
    <span id="chatTabLabel">Chat</span>
    <span class="badge" id="chatBadge" style="display:none"></span>
</button>
```

### Chat tab screens

The Chat view has two sub-views toggled by a segmented control at the top:

```
+------------------------------------------+
|  [ Lobby ]        [ Contacts ]           |
|------------------------------------------|
```

**Lobby sub-view:** The chatroom (section 7 above).

**Contacts sub-view:** List of all contacts with last message preview:
```
+------------------------------------------+
|  [ Lobby ]        [ Contacts ]           |
|------------------------------------------|
|                                          |
|  Alice                          2:31pm   |
|  Yeah, proposing TRUE now          (2)   |
|                                          |
|  Bob                            1:15pm   |
|  Anyone want 2:1 on Lakers?             |
|                                          |
|  Charlie                       yesterday |
|  No messages yet                         |
|                                          |
+------------------------------------------+
```
- Each row shows: name, last message preview, timestamp, unread count badge
- Tapping a contact opens the 1-on-1 DM thread (section 6)
- Contacts sorted by last_seen DESC (most recent activity first)

### Unread badge on Chat tab
The Chat tab icon shows a badge with total unread count across all threads:
```javascript
function updateChatBadge() {
    getUnreadCount(function(count) {
        var badge = document.getElementById("chatBadge");
        if (count > 0) {
            badge.textContent = count > 99 ? "99+" : count;
            badge.style.display = "inline-block";
        } else {
            badge.style.display = "none";
        }
    });
}
```

### showView routing
```javascript
// In renderCurrentView(), add:
else if (CURRENT_VIEW === "chat") renderChatView(main);

// Render function:
function renderChatView(el) {
    var html = '<div class="chat-tabs">';
    html += '<button class="chat-tab active" onclick="showChatSub(\'lobby\')">Lobby</button>';
    html += '<button class="chat-tab" onclick="showChatSub(\'contacts\')">Contacts</button>';
    html += '</div>';
    html += '<div id="chatContent"></div>';
    el.innerHTML = html;
    showChatSub('lobby');
}
```

### Overflow items relocation
The items currently behind "More" (Arbiter, History, Activity) move to a dropdown
triggered by a gear icon in the top bar:

```html
<div class="topbar__right">
    <div class="topbar__bal" id="balance">-- M</div>
    <button class="topbar__menu" onclick="toggleMenu()">&#9776;</button>
</div>
```

Menu contains: Arbiter, History, Activity, Settings (future).


## 9. Migration Path

### Phase 1 — Dual mode (v2.1.0)
Both ChainMail and Maxima chat coexist:

1. **Transaction messages stay on ChainMail.** SETTLE_PROPOSE, SETTLE_ACCEPT,
   SETTLE_REJECT, DISPUTE, BET_CREATED, BET_MATCHED continue to use ChainMail.
   These must survive node restarts and work without prior contact exchange.

2. **Chat messages switch to Maxima.** The `sendChatDirect()` function checks if
   the counterparty is a confirmed Maxima contact. If yes, send via Maxima (free,
   instant). If no, fall back to ChainMail (for bets created before v2.1.0).

```javascript
function sendChatDirect(inputEl) {
    // ... (existing validation) ...

    lookupContact(counterMxKey, function(contact) {
        if (contact && contact.contact_id) {
            // Maxima path — free, instant
            sendDM(counterMxKey, text, coinid, function(ok) {
                if (!ok) notify("Message failed", "err");
            });
        } else {
            // ChainMail fallback — old path
            sendChainMail(counterMxKey, payload, function(ok) {
                if (!ok) notify("Message failed", "err");
            });
        }
    });
}
```

3. **Auto-contact on existing matched bets.** On first launch of v2.1.0, run a
   one-time migration that scans all MATCHED bets in the DB and calls
   `addWagerContact()` for each counterparty MxKey found:

```javascript
function migrateExistingContacts(callback) {
    MDS.keypair.get("wager_contacts_migrated", function(kres) {
        if (kres.value === "1") { callback(); return; }

        MDS.sql("SELECT DISTINCT OWNERMXKEY, COUNTERMXKEY FROM bets WHERE status='MATCHED'",
            function(res) {
                var keys = [];
                (res.rows || []).forEach(function(r) {
                    if (r.OWNERMXKEY && r.OWNERMXKEY !== MY_MXKEY) keys.push(r.OWNERMXKEY);
                    if (r.COUNTERMXKEY && r.COUNTERMXKEY !== MY_MXKEY) keys.push(r.COUNTERMXKEY);
                });
                // Deduplicate
                var unique = [];
                var seen = {};
                keys.forEach(function(k) { if (!seen[k]) { seen[k]=true; unique.push(k); }});

                var idx = 0;
                function addNext() {
                    if (idx >= unique.length) {
                        MDS.keypair.set("wager_contacts_migrated", "1");
                        callback();
                        return;
                    }
                    addWagerContact(unique[idx], "", "migration", "", function() {
                        idx++;
                        addNext();
                    });
                }
                addNext();
            });
    });
}
```

4. **Old ChainMail CHAT_MESSAGE still processed.** The `handleChatMessage()` in
   service.js continues to work. Received ChainMail chats get inserted into both
   the old `messages` table and the new `chat_messages` table so they appear in
   the new Chat UI.

### Phase 2 — ChainMail chat deprecated (v2.2.0+)
Once the network has upgraded and most contacts are Maxima-exchanged:
- Remove ChainMail fallback for chat messages
- CHAT_MESSAGE type in ChainMail protocol becomes ignored
- Transaction messages (SETTLE_*, DISPUTE, etc.) remain on ChainMail permanently


## 10. service.js Changes

Add the MAXIMA event handler alongside the existing NOTIFYCOIN and NEWBLOCK handlers:

```javascript
if (msg.event === "MAXIMA") {
    if (msg.data && msg.data.application === "wager") {
        try {
            var payload = JSON.parse(hexToStr(msg.data.data));
            var fromContact = msg.data.from;
            handleMaximaMessage(payload, fromContact);
        } catch(e) {
            MDS.log("Maxima parse error: " + e);
        }
    }
}
```

The `handleMaximaMessage()` function (defined in maxchat.js, loaded by service.js):
```javascript
function handleMaximaMessage(payload, from) {
    if (!payload || !payload.type) return;

    if (payload.type === "HELLO") {
        // Auto-add contact, reply with ACK
        addWagerContact(payload.mxkey, payload.name, "hello", payload.betid, function() {
            // Send ACK back
            var ack = { type: "HELLO_ACK", mxkey: MY_MXKEY, name: MY_MXNAME };
            sendMaximaMsg(from, ack, function() {});
        });
    }

    else if (payload.type === "HELLO_ACK") {
        // Update contact as confirmed
        MDS.sql("UPDATE contacts SET name='" + sqlEsc(payload.name) +
                "' WHERE mxkey='" + sqlEsc(payload.mxkey) + "'");
    }

    else if (payload.type === "DM") {
        if (!payload.msg_id) return;
        // Dedup
        MDS.sql("SELECT id FROM chat_messages WHERE msg_id='" + sqlEsc(payload.msg_id) + "'",
            function(res) {
                if (res.rows && res.rows.length > 0) return;
                var threadId = "dm:" + payload.sender_key.substring(0, 32);
                insertChatMessage({
                    msg_id: payload.msg_id,
                    thread_id: threadId,
                    sender_key: payload.sender_key,
                    sender_name: payload.sender_name,
                    body: (payload.body || "").substring(0, 4096),
                    direction: "received"
                }, function() {
                    // Update contact last_seen
                    MDS.sql("UPDATE contacts SET last_seen=" + Date.now() +
                            " WHERE mxkey='" + sqlEsc(payload.sender_key) + "'");
                    // Notify user
                    MDS.notify((payload.sender_name || "Someone") + ": " +
                               (payload.body || "").substring(0, 60));
                    // Tell UI to refresh
                    MDS.comms.broadcast(JSON.stringify({action: "chat_update"}));
                });
            });
    }

    else if (payload.type === "LOBBY_MSG") {
        if (!payload.msg_id) return;
        MDS.sql("SELECT id FROM chat_messages WHERE msg_id='" + sqlEsc(payload.msg_id) + "'",
            function(res) {
                if (res.rows && res.rows.length > 0) return;
                insertChatMessage({
                    msg_id: payload.msg_id,
                    thread_id: "lobby",
                    sender_key: payload.sender_key,
                    sender_name: payload.sender_name,
                    body: (payload.body || "").substring(0, 4096),
                    direction: "received"
                }, function() {
                    MDS.comms.broadcast(JSON.stringify({action: "chat_update"}));
                });
            });
    }
}
```


## 11. File Changes Summary

| File | Change |
|------|--------|
| `js/maxchat.js` | **NEW** — Maxima chat module (all functions from section 5) |
| `js/db.js` | Add `contacts` and `chat_messages` table creation in `createTables()` |
| `js/db.js` | Add `insertChatMessage()`, `insertContact()`, `loadContacts()` helpers |
| `js/app.js` | Add `renderChatView()`, `showChatSub()`, `renderLobbyView()`, `renderContactsView()`, `renderThreadView()` |
| `js/app.js` | Update `sendChatDirect()` to use Maxima with ChainMail fallback |
| `js/app.js` | Add `renderCurrentView()` case for "chat" |
| `js/app.js` | Add `updateChatBadge()` called on refresh cycle |
| `js/app.js` | Relocate Arbiter/History/Activity to top-bar menu |
| `service.js` | Add `MAXIMA` event handler block |
| `service.js` | Load `maxchat.js` via `MDS.load("./js/maxchat.js")` |
| `service.js` | Add contact exchange calls in `handleBetMatched()` |
| `index.html` | Replace "More" nav tab with "Chat" tab + badge |
| `index.html` | Add `<script src="js/maxchat.js">` |
| `index.html` | Add top-bar hamburger menu for overflow views |
| `css/style.css` | Chat thread styles, lobby styles, badge styles, menu styles |


## 12. Edge Cases and Gotchas

**Node restarts:** Maxima messages are ephemeral. If the node is offline when a DM
arrives, it is lost. This is acceptable for casual chat. Transaction messages use
ChainMail specifically because they survive restarts (stored on-chain, re-scanned
by `scanUnprocessedMail()`).

**Contact not yet added:** If a user tries to DM someone before HELLO/ACK completes,
the send will fail. The UI should show "Connecting..." until the contact is confirmed,
then enable the input.

**MxKey rotation:** Maxima keys can change if a user reinstalls Minima. The contacts
table may have stale keys. On HELLO receive, update the contact's mxkey if the name
matches but key differs. Flag old threads as "contact changed."

**Message size:** Maxima has a data size limit (approximately 64KB per message).
Chat messages are small (body capped at 4096 chars), so this is not a concern.
Do not send images or files in v2.1.0.

**Lobby spam:** Since lobby messages go to all contacts, a malicious user could spam.
Mitigations for v2.1.0: rate-limit lobby sends to 1 per 10 seconds client-side.
Future: add block/mute per contact.

**Duplicate contacts:** The `addWagerContact()` function must check if the MxKey
already exists in the contacts table before inserting. Use:
```sql
SELECT id FROM contacts WHERE mxkey='<key>' LIMIT 1
```

**ChainMail CHAT_MESSAGE bridge:** When service.js receives a ChainMail CHAT_MESSAGE
(old protocol), also insert it into `chat_messages` so it appears in the new UI:
```javascript
function handleChatMessage(message, senderMxKey) {
    // Existing notification code...

    // Bridge to new chat system
    var threadId = "dm:" + (senderMxKey || "").substring(0, 32);
    insertChatMessage({
        msg_id: message.randomid,
        thread_id: threadId,
        sender_key: senderMxKey,
        sender_name: message.sender_name,
        body: message.message,
        direction: "received"
    });
}
```


## 13. Implementation Order

1. **DB tables** — Add contacts + chat_messages tables to db.js
2. **maxchat.js** — Core module: addWagerContact, sendDM, sendLobbyMsg, handleMaximaMessage
3. **service.js** — Add MAXIMA event handler, load maxchat.js, add contact exchange to handleBetMatched
4. **Migration** — migrateExistingContacts() on first v2.1.0 launch
5. **Chat tab UI** — index.html nav change, renderChatView, lobby sub-view, contacts sub-view
6. **Thread view** — Full chat thread with interleaved system messages
7. **Bet card upgrade** — Switch sendChatDirect to Maxima-first, add contact status dot
8. **Top bar menu** — Relocate overflow views from "More" tab
9. **Badge + polish** — Unread counts, read tracking, auto-scroll
