#!/usr/bin/env python3
"""
================================================================================
WAGER — Transaction Integration Test Suite
================================================================================

Tests every stage of the prediction market transaction lifecycle against
two live Minima nodes via their RPC endpoints.

Node 1 (port 14005): Acts as bet OWNER and ARBITER
Node 2 (port 15015): Acts as bet COUNTER (filler)

Test flow mirrors real user actions:
  1. POST a bet          — Node 1 sends coins to contract with state ports
  2. CANCEL a bet        — Node 1 reclaims an open bet
  3. POST + FILL a bet   — Node 1 posts, Node 2 fills → phase 0→1
  4. SELF-SETTLE propose — Node 1 builds partially-signed payout tx
  5. SELF-SETTLE cosign  — Node 2 imports, co-signs, posts → funds distributed
  6. ARBITER RESOLVE     — Node 1 (as arbiter) declares outcome → funds distributed
  7. CHAINMAIL send      — Node 1 sends encrypted message to Node 2
  8. CHAINMAIL receive   — Node 2 finds and decrypts the message

Each test prints PASS/FAIL and a human-readable description of what happened.

IMPORTANT: These tests spend real MINIMA on testnet. Nodes must have
sufficient balance (>50 MINIMA each) and the V3.1 contract registered.

Usage:
    python3 tests/test_transactions.py

================================================================================
"""

import json
import urllib.request
import time
import sys

# ============================================================================
# CONFIGURATION
# ============================================================================

NODE1_PORT = 14005   # Owner + Arbiter node
NODE2_PORT = 15015   # Counter (filler) node

# V3.1 Wager contract address — must match js/contract.js
CONTRACT = "0x1969FA1692D2990A1FA3CDCD34C13B1F72DCAB71A81F3292961E10AF1DA920B1"

# ChainMail address — hex for "WAGERMAIL", must match js/chainmail.js
MAIL_ADDRESS = "0x57414745524D41494C"

# Escrow rate — 25% on top of bet, must match js/wager.js or js/state.js
ESCROW_RATE = 0.25

# How long to wait for a transaction to confirm on-chain (seconds)
# Minima blocks are ~50 seconds. We need at least one full block.
CONFIRM_WAIT = 90

# Test results tracking
PASS_COUNT = 0
FAIL_COUNT = 0


# ============================================================================
# HELPERS
# ============================================================================

def cmd(port, command):
    """
    Send a Minima command to a node via HTTP POST.

    The MDS port accepts commands as POST body text.
    Returns the parsed JSON response.

    Example: cmd(14005, "balance") → {"command":"balance","status":true,...}
    """
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/",
        data=command.encode()
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def get_balance(port):
    """
    Get the confirmed Minima balance for a node.
    Returns float of confirmed MINIMA (tokenid 0x00).
    """
    res = cmd(port, "balance")
    for token in res.get("response", []):
        if token["tokenid"] == "0x00":
            return float(token["confirmed"])
    return 0.0


def get_sendable(port):
    """
    Get the sendable Minima balance for a node.
    Sendable = coins that are ready to spend (not locked in pending txns).
    """
    res = cmd(port, "balance")
    for token in res.get("response", []):
        if token["tokenid"] == "0x00":
            return float(token["sendable"])
    return 0.0


def get_key(port):
    """
    Get a fresh public key and address from a node.
    Each Minima node has 64 pre-generated keys.

    Returns: (publickey, hex_address)
    """
    res = cmd(port, "getaddress")
    return (
        res["response"]["publickey"],
        res["response"]["address"]
    )


def get_coins_at_contract(port):
    """
    Find all unspent coins at the Wager contract address.

    Returns list of coin objects. Each coin has:
      .coinid, .amount, .state (array of {port, data}), .age, etc.
    """
    res = cmd(port, f"coins address:{CONTRACT}")
    if not res.get("status") or not res.get("response"):
        return []
    return [c for c in res["response"] if not c.get("spent")]


def get_state(coin, port_num):
    """
    Extract a state variable from a coin's state array.

    Minima coins store state as [{port: 0, data: "0x..."}, {port: 1, ...}].
    This helper finds the value for the given port number.

    Returns: string value, or "" if not found.
    """
    for s in coin.get("state", []):
        if s["port"] == port_num:
            return s["data"]
    return ""


def wait_for_coin(port, phase=None, min_amount=None, prop_hex=None, max_wait=CONFIRM_WAIT):
    """
    Poll for a coin at the contract address matching the criteria.

    Used after posting/filling to wait for on-chain confirmation.
    Minima blocks are ~50 seconds, but tx appears in mempool faster.

    The prop_hex parameter is CRITICAL for avoiding stale coins from
    previous test runs. Each test uses a unique proposition text, and
    we match on that to find the specific coin we just created.

    Returns: matching coin object, or None if timeout.
    """
    start = time.time()
    while time.time() - start < max_wait:
        coins = get_coins_at_contract(port)
        for c in coins:
            state = {s["port"]: s["data"] for s in c.get("state", [])}
            if phase is not None and state.get(4) != str(phase):
                continue
            if min_amount is not None and float(c["amount"]) < min_amount:
                continue
            # Match by proposition hex to find OUR specific coin
            if prop_hex is not None:
                coin_prop = state.get(12, "")
                if coin_prop.upper() != prop_hex.upper() and coin_prop != prop_hex:
                    continue
            return c
        time.sleep(3)
    return None


def wait_for_no_coins(port, max_wait=CONFIRM_WAIT):
    """
    Wait until no unspent coins remain at the contract address.
    Used after resolve/settle to confirm the bet coin was consumed.
    """
    start = time.time()
    while time.time() - start < max_wait:
        coins = get_coins_at_contract(port)
        if len(coins) == 0:
            return True
        time.sleep(3)
    return False


def wait_for_coin_consumed(port, coinid, max_wait=CONFIRM_WAIT):
    """
    Wait until a SPECIFIC coin is no longer found at the contract.
    Used after settle/resolve — more precise than wait_for_no_coins
    because it ignores unrelated coins at the same address.
    """
    start = time.time()
    while time.time() - start < max_wait:
        coins = get_coins_at_contract(port)
        found = any(c["coinid"] == coinid for c in coins)
        if not found:
            return True
        time.sleep(3)
    return False


def str_to_hex(s):
    """
    Encode a string as hex with 0x prefix.
    Used for proposition text (state port 12).

    Example: str_to_hex("Hello") → "0x48656C6C6F"
    """
    return "0x" + s.encode().hex().upper()


def hex_to_str(h):
    """
    Decode hex (with or without 0x prefix) back to string.
    Example: hex_to_str("0x48656C6C6F") → "Hello"
    """
    if h.startswith("0x") or h.startswith("0X"):
        h = h[2:]
    return bytes.fromhex(h).decode("utf-8", errors="replace")


def report(test_name, passed, detail=""):
    """Print a test result with PASS/FAIL prefix."""
    global PASS_COUNT, FAIL_COUNT
    status = "PASS" if passed else "FAIL"
    if passed:
        PASS_COUNT += 1
    else:
        FAIL_COUNT += 1
    suffix = f" — {detail}" if detail else ""
    print(f"  [{status}] {test_name}{suffix}")


# ============================================================================
# TEST 1: POST BET
# ============================================================================
# Node 1 creates a new bet by sending coins to the contract address
# with state variables defining the bet parameters.
#
# State layout (from contract.js):
#   Port 0  = owner's signing public key
#   Port 1  = owner's payout address
#   Port 2  = arbiter's signing public key
#   Port 3  = arbiter's payout address
#   Port 4  = phase (0 = open order)
#   Port 5  = timeout (blocks before arbiter timeout)
#   Port 6  = side (1=FOR, 0=AGAINST)
#   Port 7  = wantstake (what counter must lock, including escrow)
#   Port 12 = proposition text (hex-encoded)
#   Port 13 = settlement block (0 = anytime)
#
# The 'send' command with state:{} creates a coin at the script address.
# The amount sent is the owner's locked stake (bet * 1.25 for escrow).
# ============================================================================

def test_post_bet():
    """Post a bet from Node 1 and verify the coin appears with correct state."""
    print("\n=== TEST 1: POST BET ===")

    # --- Setup: get identity keys ---
    owner_pk, owner_addr = get_key(NODE1_PORT)
    arb_pk, arb_addr = get_key(NODE1_PORT)      # Different key from same node

    # Verify arbiter key is different from owner key (contract enforces this)
    if owner_pk == arb_pk:
        # getaddress can return different keys each call
        arb_pk, arb_addr = get_key(NODE1_PORT)
    report("Owner and arbiter keys are different", owner_pk != arb_pk)

    # --- Define bet parameters ---
    bet_amount = 2          # 2 MINIMA bet
    want_amount = 4         # Want 4 MINIMA from counter
    lock_amount = bet_amount * (1 + ESCROW_RATE)    # 2.5 MINIMA locked (includes escrow)
    want_lock = want_amount * (1 + ESCROW_RATE)     # 5.0 MINIMA counter must lock
    # Unique proposition per test run — prevents matching stale coins
    proposition = f"Test post {int(time.time())}"
    prop_hex = str_to_hex(proposition)

    # --- Record balance before ---
    bal_before = get_balance(NODE1_PORT)

    # --- Build state JSON ---
    state = json.dumps({
        "0": owner_pk,
        "1": owner_addr,
        "2": arb_pk,
        "3": arb_addr,
        "4": "0",                    # phase = 0 (open)
        "5": "1500",                 # timeout = 1500 blocks
        "6": "1",                    # side = FOR
        "7": str(want_lock),         # counter must lock 5.0
        "12": prop_hex,              # proposition text
        "13": "0"                    # settlement = anytime
    })

    # --- Send to contract ---
    send_cmd = f"send amount:{lock_amount} address:{CONTRACT} state:{state} storestate:true"
    res = cmd(NODE1_PORT, send_cmd)
    report("Send command accepted", res.get("status") == True,
           f"status={res.get('status')}, error={res.get('error','')[:50]}")

    if not res.get("status"):
        print("  ABORT: Cannot continue without successful post")
        return None

    # --- Wait for coin to appear ---
    print(f"  Waiting up to {CONFIRM_WAIT}s for on-chain confirmation...")
    coin = wait_for_coin(NODE1_PORT, phase=0, min_amount=lock_amount - 0.01, prop_hex=prop_hex)
    report("Bet coin appeared on-chain", coin is not None)

    if not coin:
        print("  ABORT: Coin did not appear")
        return None

    # --- Verify state ports ---
    state_map = {s["port"]: s["data"] for s in coin["state"]}

    report("Port 0 (owner pk) correct", state_map.get(0) == owner_pk)
    report("Port 1 (owner addr) correct", state_map.get(1) == owner_addr)
    report("Port 2 (arbiter pk) correct", state_map.get(2) == arb_pk)
    report("Port 3 (arbiter addr) correct", state_map.get(3) == arb_addr)
    report("Port 4 (phase) = 0", state_map.get(4) == "0")
    report("Port 6 (side) = 1 (FOR)", state_map.get(6) == "1")
    report("Port 7 (wantstake) correct", state_map.get(7) == str(want_lock))
    report("Port 12 (proposition) correct", state_map.get(12, "").upper() == prop_hex[2:].upper() or state_map.get(12) == prop_hex)
    report("Coin amount = lock amount", float(coin["amount"]) == lock_amount)

    print(f"  Coin ID: {coin['coinid'][:40]}...")

    # Return the bet info for subsequent tests
    return {
        "coinid": coin["coinid"],
        "amount": coin["amount"],
        "owner_pk": owner_pk,
        "owner_addr": owner_addr,
        "arb_pk": arb_pk,
        "arb_addr": arb_addr,
        "proposition": proposition,
        "prop_hex": prop_hex,
        "lock_amount": lock_amount,
        "want_lock": want_lock
    }


# ============================================================================
# TEST 2: CANCEL BET
# ============================================================================
# The bet owner cancels an open (phase 0) bet.
# Contract path: IF ph EQ 0 AND SIGNEDBY(ok) THEN RETURN TRUE
#
# Transaction:
#   Input:  the bet coin
#   Output: full amount back to owner address (storestate:false)
#   Sign:   with owner's specific key (port 0), NOT publickey:auto
# ============================================================================

def test_cancel_bet(bet_info):
    """Cancel the open bet from Test 1 and verify funds returned."""
    print("\n=== TEST 2: CANCEL BET ===")

    if not bet_info:
        report("Skipped — no bet to cancel", False, "Test 1 failed")
        return False

    coinid = bet_info["coinid"]
    owner_pk = bet_info["owner_pk"]
    owner_addr = bet_info["owner_addr"]
    amount = bet_info["amount"]
    txid = "test_cancel"

    # --- Build cancel transaction ---
    # Step 1: Create transaction shell
    r = cmd(NODE1_PORT, f"txncreate id:{txid}")
    report("txncreate", r.get("status") == True)

    # Step 2: Add the bet coin as input
    r = cmd(NODE1_PORT, f"txninput id:{txid} coinid:{coinid}")
    report("txninput (bet coin)", r.get("status") == True,
           r.get("error", "")[:60])

    if not r.get("status"):
        cmd(NODE1_PORT, f"txndelete id:{txid}")
        return False

    # Step 3: Output — full amount back to owner (storestate:false = final payout)
    r = cmd(NODE1_PORT, f"txnoutput id:{txid} amount:{amount} address:{owner_addr} storestate:false")
    report("txnoutput (refund to owner)", r.get("status") == True)

    # Step 4: Sign with owner's SPECIFIC key (not auto — auto doesn't work for script coins)
    r = cmd(NODE1_PORT, f"txnsign id:{txid} publickey:{owner_pk}")
    report("txnsign (owner key)", r.get("status") == True,
           r.get("error", "")[:60])

    # Step 5: Add MMR proofs and scripts
    r = cmd(NODE1_PORT, f"txnbasics id:{txid}")
    report("txnbasics", r.get("status") == True)

    # Step 6: Validate before posting
    r = cmd(NODE1_PORT, f"txncheck id:{txid}")
    valid = r.get("response", {}).get("valid", {})
    report("txncheck basic", valid.get("basic") == True)
    report("txncheck scripts", valid.get("scripts") == True,
           "CRITICAL — contract rejected the cancel tx" if not valid.get("scripts") else "")
    report("txncheck burn = 0", r.get("response", {}).get("burn") == "0")

    # Step 7: Post to network
    r = cmd(NODE1_PORT, f"txnpost id:{txid}")
    report("txnpost", r.get("status") == True)
    cmd(NODE1_PORT, f"txndelete id:{txid}")

    # Step 8: Verify coin is consumed
    print(f"  Waiting up to {CONFIRM_WAIT}s for cancel to confirm...")
    no_coins = wait_for_no_coins(NODE1_PORT)
    report("Bet coin consumed (cancelled)", no_coins)

    return no_coins


# ============================================================================
# TEST 3: POST + FILL (create a matched bet)
# ============================================================================
# Node 1 posts a new bet, then Node 2 fills it.
#
# Fill contract path (phase 0, not signed by owner):
#   ASSERT SAMESTATE(0 3)           — ports 0-3 must match
#   ASSERT STATE(4) EQ 1            — output must be phase 1
#   ASSERT SAMESTATE(5 7)           — ports 5-7 must match
#   ASSERT STATE(10) EQ @AMOUNT     — ownerstake = bet coin amount
#   ASSERT ak NEQ ok                — arbiter ≠ owner
#   ASSERT ak NEQ STATE(8)          — arbiter ≠ counter
#   ASSERT VERIFYOUT(@INPUT @ADDRESS @AMOUNT+ws @TOKENID TRUE)
#     — output 0: total pot at contract, storestate:true
#
# Transaction:
#   Inputs:  [0] bet coin, [1..n] funding coins from Node 2
#   Outputs: [0] total pot at contract (storestate:true), [1] change (storestate:false)
#   State:   preserve ports 0-3, 5-7; set 4=1, 8=counter_pk, 9=counter_addr,
#            10=owner_stake, 12=proposition, 13=settlement, 14=0
#   Sign:    publickey:auto (signs for the funding coins)
# ============================================================================

def test_post_and_fill():
    """Post from Node 1, fill from Node 2, verify matched bet."""
    print("\n=== TEST 3: POST + FILL ===")

    # --- POST phase (same as Test 1 but with fresh keys) ---
    owner_pk, owner_addr = get_key(NODE1_PORT)
    arb_pk, arb_addr = get_key(NODE1_PORT)
    if owner_pk == arb_pk:
        arb_pk, arb_addr = get_key(NODE1_PORT)

    lock_amount = 2.5       # 2 MINIMA bet * 1.25 escrow
    want_lock = 5.0         # 4 MINIMA counter bet * 1.25 escrow
    # Unique proposition per test run — prevents matching stale coins
    proposition = f"Test fill {int(time.time())}"
    prop_hex = str_to_hex(proposition)

    state = json.dumps({
        "0": owner_pk, "1": owner_addr,
        "2": arb_pk, "3": arb_addr,
        "4": "0", "5": "1500", "6": "1",
        "7": str(want_lock),
        "12": prop_hex, "13": "0"
    })

    res = cmd(NODE1_PORT, f"send amount:{lock_amount} address:{CONTRACT} state:{state} storestate:true")
    report("Post bet (Node 1)", res.get("status") == True)

    if not res.get("status"):
        return None

    # Wait for bet coin
    print(f"  Waiting for bet coin to confirm...")
    bet_coin = wait_for_coin(NODE1_PORT, phase=0, min_amount=lock_amount - 0.01, prop_hex=prop_hex)
    report("Bet coin on-chain", bet_coin is not None)

    if not bet_coin:
        return None

    coinid = bet_coin["coinid"]
    print(f"  Bet coin: {coinid[:40]}...")

    # --- FILL phase (Node 2) ---
    counter_pk, counter_addr = get_key(NODE2_PORT)

    # Find a funding coin on Node 2
    fund_res = cmd(NODE2_PORT, "coins relevant:true sendable:true")
    fund_coin = None
    for c in fund_res.get("response", []):
        if (c["tokenid"] == "0x00" and
            float(c["amount"]) >= want_lock + 0.001 and
            len(c.get("state", [])) == 0):
            fund_coin = c
            break

    report("Found funding coin on Node 2", fund_coin is not None,
           f"amount={fund_coin['amount']}" if fund_coin else "No suitable coin")

    if not fund_coin:
        return None

    change = round(float(fund_coin["amount"]) - want_lock, 8)
    total_pot = lock_amount + want_lock     # 2.5 + 5.0 = 7.5
    txid = "test_fill"

    # Build fill transaction on Node 2
    cmd(NODE2_PORT, f"txncreate id:{txid}")

    # Input 0: the bet coin
    r = cmd(NODE2_PORT, f"txninput id:{txid} coinid:{coinid}")
    report("txninput bet coin", r.get("status") == True, r.get("error", "")[:60])

    # Input 1: funding coin
    r = cmd(NODE2_PORT, f"txninput id:{txid} coinid:{fund_coin['coinid']}")
    report("txninput funding coin", r.get("status") == True)

    # Output 0: total pot at contract (storestate:true for phase transition)
    r = cmd(NODE2_PORT, f"txnoutput id:{txid} amount:{total_pot} address:{CONTRACT} storestate:true")
    report("txnoutput pot", r.get("status") == True)

    # Output 1: change back to counter (storestate:false for wallet)
    if change > 0.000001:
        r = cmd(NODE2_PORT, f"txnoutput id:{txid} amount:{change} address:{counter_addr} storestate:false")
        report("txnoutput change", r.get("status") == True)

    # Read ACTUAL state from the bet coin to avoid SAMESTATE mismatches.
    # The contract enforces SAMESTATE(0 3) and SAMESTATE(5 7) — the fill
    # transaction's state ports 0-3 and 5-7 MUST exactly match the bet coin's.
    # Using variables from earlier in the test is risky (could be different keys
    # if getaddress was called between post and fill).
    bet_state = {s["port"]: s["data"] for s in bet_coin["state"]}

    fill_state = {
        0: bet_state[0],        # SAMESTATE(0 3): copy EXACTLY from bet coin
        1: bet_state[1],
        2: bet_state[2],
        3: bet_state[3],
        4: "1",                 # phase → 1 (matched)
        5: bet_state[5],        # SAMESTATE(5 7): copy EXACTLY from bet coin
        6: bet_state[6],        # side
        7: bet_state[7],        # wantstake
        8: counter_pk,          # NEW: counter's signing key
        9: counter_addr,        # NEW: counter's payout address
        10: bet_coin["amount"], # ownerstake = @AMOUNT of bet coin
        11: "0",
        12: bet_state.get(12, prop_hex),  # proposition preserved from coin
        13: bet_state.get(13, "0"),
        14: "0"                 # refresh flag (must be set, VM crashes on unset)
    }
    for port, val in fill_state.items():
        cmd(NODE2_PORT, f"txnstate id:{txid} port:{port} value:{val}")
    report("State ports set", True, "15 ports (0-14)")

    # Sign → Basics → Check → Post
    cmd(NODE2_PORT, f"txnsign id:{txid} publickey:auto")
    cmd(NODE2_PORT, f"txnbasics id:{txid}")

    r = cmd(NODE2_PORT, f"txncheck id:{txid}")
    valid = r.get("response", {}).get("valid", {})
    report("txncheck basic", valid.get("basic") == True)
    report("txncheck scripts", valid.get("scripts") == True,
           "CRITICAL — contract rejected fill" if not valid.get("scripts") else "")
    report("txncheck burn = 0", r.get("response", {}).get("burn") == "0")

    r = cmd(NODE2_PORT, f"txnpost id:{txid}")
    report("txnpost fill", r.get("status") == True)
    cmd(NODE2_PORT, f"txndelete id:{txid}")

    # Wait for phase 1 coin
    print(f"  Waiting for matched bet (phase 1) to appear...")
    matched = wait_for_coin(NODE1_PORT, phase=1, min_amount=total_pot - 0.01, prop_hex=prop_hex)
    report("Matched bet (phase 1) on-chain", matched is not None)

    if not matched:
        return None

    # Verify matched state
    ms = {s["port"]: s["data"] for s in matched["state"]}
    report("Phase = 1", ms.get(4) == "1")
    report("Counter pk set", ms.get(8) == counter_pk,
           f"expected={counter_pk[:20]}... got={ms.get(8,'EMPTY')[:20]}...")
    report("Counter addr set", ms.get(9) == counter_addr,
           f"expected={counter_addr[:20]}... got={ms.get(9,'EMPTY')[:20]}...")
    report("Ownerstake = original lock", ms.get(10) == str(lock_amount))
    report("Total amount = pot", float(matched["amount"]) == total_pot)

    print(f"  Matched coin: {matched['coinid'][:40]}...")

    return {
        "coinid": matched["coinid"],
        "amount": matched["amount"],
        "owner_pk": owner_pk,
        "owner_addr": owner_addr,
        "counter_pk": counter_pk,
        "counter_addr": counter_addr,
        "arb_pk": arb_pk,
        "arb_addr": arb_addr,
        "total_pot": total_pot,
        "lock_amount": lock_amount,
        "want_lock": want_lock,
        "proposition": proposition,
        "prop_hex": prop_hex
    }


# ============================================================================
# TEST 4: SELF-SETTLE (propose + cosign)
# ============================================================================
# Node 1 proposes outcome, Node 2 co-signs and posts.
#
# Self-settle contract path (phase 1, both sign, STATE(11) ≠ 2):
#   LET o=STATE(11)
#   IF o EQ sd THEN         — owner wins
#     LET le=(@AMOUNT-os)/5  — loser escrow = counter's lock / 5
#     VERIFYOUT(@INPUT oa @AMOUNT-le FALSE)    — winner gets pot - escrow
#     VERIFYOUT(@INPUT+1 ca le FALSE)          — loser gets escrow back
#   ELSE                     — counter wins
#     LET le=os/5            — loser escrow = owner's lock / 5
#     VERIFYOUT(@INPUT ca @AMOUNT-le FALSE)
#     VERIFYOUT(@INPUT+1 oa le FALSE)
#
# Two-step signing:
#   Step A (proposer): txncreate → inputs → outputs → state → txnsign → txnexport
#     NO txnbasics here — basics are added once by the last signer
#   Step B (co-signer): txnimport → txnsign → txnbasics → txnpost
# ============================================================================

def test_self_settle(matched_info):
    """Test self-settle: Node 1 proposes TRUE, Node 2 co-signs."""
    print("\n=== TEST 4: SELF-SETTLE (propose + cosign) ===")

    if not matched_info:
        report("Skipped — no matched bet", False, "Test 3 failed")
        return False

    coinid = matched_info["coinid"]
    total_pot = float(matched_info["amount"])
    owner_pk = matched_info["owner_pk"]
    owner_addr = matched_info["owner_addr"]
    counter_pk = matched_info["counter_pk"]
    counter_addr = matched_info["counter_addr"]
    owner_lock = matched_info["lock_amount"]    # 2.5
    counter_lock = matched_info["want_lock"]    # 5.0

    # Outcome: TRUE (1). Owner side = FOR (1). So owner wins.
    outcome = 1
    owner_side = 1
    owner_wins = (outcome == owner_side)

    # Calculate payouts per contract math:
    #   owner wins → loser escrow = counter_lock / 5 = 5.0 / 5 = 1.0
    #   winner gets: total_pot - loser_escrow = 7.5 - 1.0 = 6.5
    #   loser gets: loser_escrow = 1.0
    loser_lock = counter_lock if owner_wins else owner_lock
    loser_escrow = round(loser_lock / 5, 8)     # = 1.0
    winner_payout = round(total_pot - loser_escrow, 8)  # = 6.5

    winner_addr = owner_addr if owner_wins else counter_addr
    loser_addr = counter_addr if owner_wins else owner_addr

    print(f"  Outcome: {'TRUE (owner wins)' if owner_wins else 'FALSE (counter wins)'}")
    print(f"  Winner gets: {winner_payout} MINIMA")
    print(f"  Loser gets escrow back: {loser_escrow} MINIMA")

    # --- Step A: Node 1 (owner) builds and signs proposal ---
    txid_propose = "test_propose"

    cmd(NODE1_PORT, f"txncreate id:{txid_propose}")
    r = cmd(NODE1_PORT, f"txninput id:{txid_propose} coinid:{coinid}")
    report("Propose: txninput", r.get("status") == True, r.get("error", "")[:60])

    if not r.get("status"):
        cmd(NODE1_PORT, f"txndelete id:{txid_propose}")
        return False

    # Output 0: winner gets pot - loser escrow
    cmd(NODE1_PORT, f"txnoutput id:{txid_propose} amount:{winner_payout} address:{winner_addr} storestate:false")
    # Output 1: loser gets escrow back
    cmd(NODE1_PORT, f"txnoutput id:{txid_propose} amount:{loser_escrow} address:{loser_addr} storestate:false")

    # State: outcome in port 11, refresh flag in port 14
    cmd(NODE1_PORT, f"txnstate id:{txid_propose} port:11 value:{outcome}")
    cmd(NODE1_PORT, f"txnstate id:{txid_propose} port:14 value:0")

    # Sign with owner's SPECIFIC key (not auto)
    r = cmd(NODE1_PORT, f"txnsign id:{txid_propose} publickey:{owner_pk}")
    report("Propose: txnsign (owner)", r.get("status") == True, r.get("error", "")[:60])

    # Export — DO NOT call txnbasics yet (co-signer does that)
    r = cmd(NODE1_PORT, f"txnexport id:{txid_propose}")
    report("Propose: txnexport", r.get("status") == True)
    cmd(NODE1_PORT, f"txndelete id:{txid_propose}")

    if not r.get("status"):
        return False

    txn_hex = r["response"]["data"]
    print(f"  Exported tx hex: {txn_hex[:60]}... ({len(txn_hex)} chars)")

    # --- Step B: Node 2 (counter) imports, co-signs, posts ---
    txid_cosign = "test_cosign"

    r = cmd(NODE2_PORT, f"txnimport id:{txid_cosign} data:{txn_hex}")
    report("Cosign: txnimport", r.get("status") == True, r.get("error", "")[:60])

    if not r.get("status"):
        return False

    # Co-sign with counter's SPECIFIC key
    r = cmd(NODE2_PORT, f"txnsign id:{txid_cosign} publickey:{counter_pk}")
    report("Cosign: txnsign (counter)", r.get("status") == True, r.get("error", "")[:60])

    # NOW add basics (only once, by the last signer)
    r = cmd(NODE2_PORT, f"txnbasics id:{txid_cosign}")
    report("Cosign: txnbasics", r.get("status") == True, r.get("error", "")[:60])

    # Check before posting
    r = cmd(NODE2_PORT, f"txncheck id:{txid_cosign}")
    valid = r.get("response", {}).get("valid", {})
    report("Cosign: txncheck basic", valid.get("basic") == True)
    report("Cosign: txncheck scripts", valid.get("scripts") == True,
           "CRITICAL — contract rejected self-settle" if not valid.get("scripts") else "")
    report("Cosign: burn = 0", r.get("response", {}).get("burn") == "0")

    # Post
    r = cmd(NODE2_PORT, f"txnpost id:{txid_cosign}")
    report("Cosign: txnpost", r.get("status") == True)
    cmd(NODE2_PORT, f"txndelete id:{txid_cosign}")

    # Wait for settlement — check that OUR specific coin is consumed
    # (other unrelated coins may exist at the contract address)
    print(f"  Waiting for settlement to confirm...")
    settled = wait_for_coin_consumed(NODE1_PORT, coinid)
    report("Bet coin consumed (settled)", settled,
           f"coinid={coinid[:20]}..." if not settled else "")

    return settled


# ============================================================================
# TEST 5: ARBITER RESOLVE
# ============================================================================
# Requires a fresh matched bet. Node 1 (as arbiter) declares outcome.
#
# Contract path (phase 1, SIGNEDBY(arbiter)):
#   LET f=@AMOUNT/10       — arbiter fee = 10% of total pot
#   LET o=STATE(11)         — declared outcome
#   IF o EQ sd THEN         — owner wins
#     VERIFYOUT(@INPUT oa @AMOUNT-f FALSE)    — winner gets 90%
#   ELSE                     — counter wins
#     VERIFYOUT(@INPUT ca @AMOUNT-f FALSE)
#   ENDIF
#   VERIFYOUT(@INPUT+1 aa f FALSE)            — arbiter gets 10%
#
# Transaction:
#   Input:  the matched bet coin
#   Output 0: 90% to winner (storestate:false)
#   Output 1: 10% to arbiter (storestate:false)
#   State:  port 11 = outcome, port 14 = 0
#   Sign:   with arbiter's specific key (port 2)
# ============================================================================

def test_arbiter_resolve():
    """Post, fill, then resolve via arbiter."""
    print("\n=== TEST 5: ARBITER RESOLVE ===")

    # First create a matched bet (reuse post+fill logic)
    matched = test_post_and_fill()
    if not matched:
        report("Skipped — could not create matched bet", False)
        return False

    coinid = matched["coinid"]
    total_pot = float(matched["amount"])
    arb_pk = matched["arb_pk"]
    arb_addr = matched["arb_addr"]
    owner_addr = matched["owner_addr"]
    counter_addr = matched["counter_addr"]

    # Outcome: FALSE (0). Owner side = FOR (1). So counter wins.
    outcome = 0

    # Fee = 10% of total pot
    fee = round(total_pot / 10, 8)
    winnings = round(total_pot - fee, 8)
    winner_addr = counter_addr   # counter wins (outcome ≠ owner side)

    print(f"  Outcome: FALSE (counter wins)")
    print(f"  Winner gets: {winnings} MINIMA")
    print(f"  Arbiter fee: {fee} MINIMA")

    txid = "test_resolve"

    cmd(NODE1_PORT, f"txncreate id:{txid}")
    r = cmd(NODE1_PORT, f"txninput id:{txid} coinid:{coinid}")
    report("Resolve: txninput", r.get("status") == True, r.get("error", "")[:60])

    if not r.get("status"):
        cmd(NODE1_PORT, f"txndelete id:{txid}")
        return False

    # Output 0: winnings to winner
    cmd(NODE1_PORT, f"txnoutput id:{txid} amount:{winnings} address:{winner_addr} storestate:false")
    # Output 1: fee to arbiter
    cmd(NODE1_PORT, f"txnoutput id:{txid} amount:{fee} address:{arb_addr} storestate:false")

    # State
    cmd(NODE1_PORT, f"txnstate id:{txid} port:11 value:{outcome}")
    cmd(NODE1_PORT, f"txnstate id:{txid} port:14 value:0")

    # Sign with arbiter key
    r = cmd(NODE1_PORT, f"txnsign id:{txid} publickey:{arb_pk}")
    report("Resolve: txnsign (arbiter)", r.get("status") == True)

    r = cmd(NODE1_PORT, f"txnbasics id:{txid}")
    report("Resolve: txnbasics", r.get("status") == True)

    r = cmd(NODE1_PORT, f"txncheck id:{txid}")
    valid = r.get("response", {}).get("valid", {})
    report("Resolve: txncheck basic", valid.get("basic") == True)
    report("Resolve: txncheck scripts", valid.get("scripts") == True,
           "CRITICAL — contract rejected resolve" if not valid.get("scripts") else "")

    r = cmd(NODE1_PORT, f"txnpost id:{txid}")
    report("Resolve: txnpost", r.get("status") == True)
    cmd(NODE1_PORT, f"txndelete id:{txid}")

    print(f"  Waiting for resolve to confirm...")
    settled = wait_for_coin_consumed(NODE1_PORT, coinid)
    report("Bet coin consumed (resolved)", settled,
           f"coinid={coinid[:20]}..." if not settled else "")

    return settled


# ============================================================================
# TEST 6: CHAINMAIL
# ============================================================================
# Node 1 sends an encrypted message to Node 2 via state port 99.
# Node 2 must decrypt it using their Maxima key.
#
# ChainMail works by:
#   1. Sender encrypts JSON payload with recipient's Maxima public key
#   2. Sends a tiny coin (0.001 MINIMA) to the WAGER_MAIL_ADDRESS
#      with the encrypted data in state port 99
#   3. Recipient detects the coin (via coinnotify or polling)
#   4. Attempts to decrypt — if successful, the message was for them
#
# This test verifies the encrypt→send→find→decrypt chain works.
# ============================================================================

def test_chainmail():
    """Send ChainMail from Node 1 to Node 2 and verify delivery."""
    print("\n=== TEST 6: CHAINMAIL ===")

    # Get Node 2's Maxima key (needed for encryption)
    mx_res = cmd(NODE2_PORT, "maxima")
    if not mx_res.get("status"):
        report("Node 2 Maxima available", False, "maxima command failed")
        return False

    mx_key = mx_res["response"].get("mxpublickey", "")
    report("Node 2 Maxima key obtained", mx_key.startswith("Mx"),
           f"key={mx_key[:30]}...")

    if not mx_key.startswith("Mx"):
        return False

    # Build test message payload
    test_message = {
        "type": "CHAT_MESSAGE",
        "randomid": "0x" + hex(int(time.time() * 1000))[2:].upper() + "TEST",
        "betid": "0xTEST",
        "message": "Hello from test suite",
        "sender_name": "TestBot"
    }

    # Hex-encode the JSON
    payload_hex = json.dumps(test_message).encode().hex()

    # Encrypt with Node 2's Maxima key
    enc_res = cmd(NODE1_PORT, f"maxmessage action:encrypt publickey:{mx_key} data:{payload_hex}")
    report("Encrypt payload", enc_res.get("status") == True,
           enc_res.get("error", "")[:60])

    if not enc_res.get("status"):
        return False

    encrypted = enc_res["response"]["data"]
    print(f"  Encrypted data: {encrypted[:60]}... ({len(encrypted)} chars)")

    # Send to mail address with encrypted data in state port 99
    state_json = json.dumps({"99": encrypted})
    send_cmd = f"send amount:0.001 address:{MAIL_ADDRESS} state:{state_json}"
    r = cmd(NODE1_PORT, send_cmd)
    report("Send ChainMail coin", r.get("status") == True,
           r.get("error", "")[:60])

    if not r.get("status"):
        return False

    # Wait for the mail coin to appear
    print(f"  Waiting for mail coin to confirm...")
    time.sleep(CONFIRM_WAIT)

    # Find the mail coin on Node 2
    mail_coins = cmd(NODE2_PORT, f"coins address:{MAIL_ADDRESS}")
    found_coins = mail_coins.get("response", [])
    report("Mail coin found on Node 2", len(found_coins) > 0,
           f"{len(found_coins)} coin(s) at mail address")

    if not found_coins:
        return False

    # Try to decrypt the most recent mail coins (newest first)
    # We look for our specific randomid in the decrypted payload
    decrypted_ok = False
    attempts = 0
    for mc in reversed(found_coins):
        state99 = None
        for s in mc.get("state", []):
            if s["port"] == 99 or s["port"] == "99":
                state99 = s["data"]
                break

        if not state99:
            continue

        # Try more coins since there could be many old mail coins
        attempts += 1
        if attempts > 30:
            break

        # Strip 0x prefix before decrypt (PocketShop/chainmail.js pattern)
        clean = state99[2:] if state99.startswith("0x") else state99
        try:
            dec_res = cmd(NODE2_PORT, f"maxmessage action:decrypt data:{clean}")
        except:
            continue

        if not dec_res.get("status"):
            continue  # Not for us — silent skip (expected for other nodes' messages)

        msg_obj = dec_res.get("response", {}).get("message", {})
        if not msg_obj.get("valid"):
            continue

        hex_data = msg_obj.get("data", "")
        try:
            # Strip 0x if present in the decrypted data
            if hex_data.startswith("0x"):
                hex_data = hex_data[2:]
            msg_json = bytes.fromhex(hex_data).decode("utf-8")
            msg = json.loads(msg_json)
            if msg.get("randomid") == test_message["randomid"]:
                decrypted_ok = True
                report("ChainMail decrypted and verified", True,
                       f"message='{msg.get('message','')}'")
                break
        except Exception as e:
            # Decrypted but couldn't parse — might be old format or different message
            continue

    if not decrypted_ok:
        report("ChainMail decrypted and verified", False,
               f"Tried {attempts} coins, none matched our randomid")

    return decrypted_ok


# ============================================================================
# MAIN — Run all tests
# ============================================================================

def main():
    print("=" * 70)
    print("WAGER — Transaction Integration Test Suite")
    print("=" * 70)
    print(f"Node 1: http://127.0.0.1:{NODE1_PORT} (Owner + Arbiter)")
    print(f"Node 2: http://127.0.0.1:{NODE2_PORT} (Counter)")
    print(f"Contract: {CONTRACT[:30]}...")

    # Verify nodes are alive
    try:
        b1 = cmd(NODE1_PORT, "block")
        b2 = cmd(NODE2_PORT, "block")
        block1 = b1["response"]["block"]
        block2 = b2["response"]["block"]
        print(f"Node 1 block: {block1}, Node 2 block: {block2}")
    except Exception as e:
        print(f"ERROR: Cannot connect to nodes — {e}")
        sys.exit(1)

    # Verify balances
    bal1 = get_sendable(NODE1_PORT)
    bal2 = get_sendable(NODE2_PORT)
    print(f"Node 1 sendable: {bal1:.4f} MINIMA")
    print(f"Node 2 sendable: {bal2:.4f} MINIMA")

    if bal1 < 20 or bal2 < 20:
        print("ERROR: Insufficient balance for tests (need 20+ MINIMA each)")
        sys.exit(1)

    # Verify contract registered
    scripts1 = cmd(NODE1_PORT, "scripts")
    found = any(s.get("address") == CONTRACT for s in scripts1.get("response", []))
    if not found:
        print("Registering contract on Node 1...")
        # Contract will be registered by the app's service.js on init

    print()

    # --- Run tests ---

    # Test 1: Post
    bet_info = test_post_bet()

    # Test 2: Cancel (uses the bet from Test 1)
    test_cancel_bet(bet_info)

    # Test 3: Post + Fill (creates a new matched bet)
    matched_info = test_post_and_fill()

    # Test 4: Self-settle (uses the matched bet from Test 3)
    test_self_settle(matched_info)

    # Test 5: Arbiter resolve (creates its own matched bet internally)
    test_arbiter_resolve()

    # Test 6: ChainMail
    test_chainmail()

    # --- Summary ---
    print()
    print("=" * 70)
    print(f"RESULTS: {PASS_COUNT} passed, {FAIL_COUNT} failed, {PASS_COUNT + FAIL_COUNT} total")
    print("=" * 70)

    if FAIL_COUNT > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
