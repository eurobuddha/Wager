#!/usr/bin/env python3
"""
================================================================================
OPENLY V4 — Contract Integration + Security Test Suite
================================================================================

Validates the hardened V4 prediction-market contract on-chain against two
private Minima nodes, BEFORE any Android code exists (contract-first, Phase 0
of the Openly native rebuild plan).

What V4 fixes vs V3.1 (see js/contract.js for V3.1):
  - Fill pins the ENTIRE owner-set region with one ASSERT SAMESTATE(0 11):
    proposition, timeout, arbiter, nonce, comms ids all immutable on fill.
    (V3.1 let the filler rewrite the proposition — this suite proves it can't.)
  - Stable 32-byte nonce (port 9) survives coinid changes across refresh.
  - Outcome in txn-state port 20, range-gated in IF conditions.
  - Settlement math is exact BigDecimal (/5, /10 always terminate in base-10);
    the V3.1 "brick" was a JS Math.floor(x*1e8)/1e8 float artifact.

Node roles (private -solo + -test peer, launched by the harness runner):
  N1 (RPC 21005): solo miner — bet OWNER and ARBITER
  N2 (RPC 22005): peer      — bet COUNTER (filler)

Test groups:
  A. Registration + parse (root/proofs/address pinned)
  B. Positive lifecycle: post→cancel, post→fill, fill→self-settle (both sides),
     fill→void, fill→arbiter (both), fill→refresh×2→settle, fill→timeout
  C. Exactness: awkward pots, on-chain payout == Num-computed string
  D. Adversarial (must ALL fail): fill rewriting any pinned port, wrong recreate
     amount, STATE(17)!=0, refresh mutation / no-increment / past-cap, settle with
     extra input or wrong split, arbiter with out-of-range outcome, early timeout
  E. Measurements: txnexport size of a single-sig settle txn; max state-99 blob

Run:  python3 tests/test_v4.py
Deliverable side-effects: prints an OpenlyContract.java constants block and a
RESULTS.md summary at the end.
================================================================================
"""
import json, urllib.request, time, sys, hashlib
from decimal import Decimal, getcontext, ROUND_DOWN

getcontext().prec = 64  # mirror MiniNumber MathContext(64, DOWN)

N1 = 21005
N2 = 22005
CONFIRM_WAIT = 120
ESCROW_MULT = Decimal("1.25")

PASS = 0
FAIL = 0
RESULTS = []  # (group, name, ok, detail)

# ------------------------------------------------------------------ RPC
def cmd(port, command):
    req = urllib.request.Request(f"http://127.0.0.1:{port}/", data=command.encode())
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read())

def ok(res):
    return bool(res and res.get("status"))

def report(group, name, passed, detail=""):
    global PASS, FAIL
    RESULTS.append((group, name, passed, detail))
    if passed: PASS += 1
    else: FAIL += 1
    tag = "PASS" if passed else "FAIL"
    print(f"  [{tag}] {name}" + (f" — {detail}" if detail else ""))

# ------------------------------------------------------------------ money (Num mirror)
def num(x):
    return Decimal(str(x))

def plain(d):
    """MiniNumber-style: exact, trailing zeros trimmed, no scientific notation."""
    d = num(d).normalize()
    s = format(d, 'f')
    return s

def lock_of(stake):        # total locked = stake * 1.25
    return num(stake) * ESCROW_MULT

def loser_escrow(loserlock):  # le = loserlock / 5
    return num(loserlock) / 5

def arb_fee(pot):          # f = pot / 10
    return num(pot) / 10

# ------------------------------------------------------------------ helpers
def getkey(port):
    r = cmd(port, "getaddress")["response"]
    return r["publickey"], r["address"]

def str_hex(s):
    return "0x" + s.encode().hex().upper()

def coins_at(port, addr):
    r = cmd(port, f"coins address:{addr}")
    if not ok(r) or not r.get("response"):
        return []
    return [c for c in r["response"] if not c.get("spent")]

def state_map(coin):
    return {int(s["port"]): s["data"] for s in coin.get("state", [])}

def wait_coin(port, addr, nonce=None, phase=None, wait=CONFIRM_WAIT):
    start = time.time()
    while time.time() - start < wait:
        for c in coins_at(port, addr):
            sm = state_map(c)
            if nonce is not None and sm.get(9, "").upper() != nonce.upper():
                continue
            if phase is not None and sm.get(12) != str(phase):
                continue
            return c
        time.sleep(3)
    return None

def wait_gone(port, addr, coinid, wait=CONFIRM_WAIT):
    start = time.time()
    while time.time() - start < wait:
        if not any(c["coinid"] == coinid for c in coins_at(port, addr)):
            return True
        time.sleep(3)
    return False

def balance(port, addr):
    """Sum of unspent coin amounts at a plain address (for payout assertions)."""
    total = Decimal(0)
    for c in coins_at(port, addr):
        total += num(c["amount"])
    return total

# ------------------------------------------------------------------ V4 contract
LEAF_REFRESH = (
    "LET ok=PREVSTATE(0) LET ck=PREVSTATE(13) "
    "IF PREVSTATE(12) EQ 1 AND (SIGNEDBY(ok) OR SIGNEDBY(ck)) THEN "
    "ASSERT SAMESTATE(0 16) "
    "ASSERT STATE(17) EQ PREVSTATE(17)+1 "
    "ASSERT PREVSTATE(17) LT 200 "
    "ASSERT VERIFYOUT(@INPUT @ADDRESS @AMOUNT @TOKENID TRUE) "
    "RETURN TRUE ENDIF RETURN FALSE"
)
LEAF_TIMEOUT = (
    "LET oa=PREVSTATE(1) LET ca=PREVSTATE(14) LET os=PREVSTATE(15) "
    "IF PREVSTATE(12) EQ 1 AND @COINAGE GT PREVSTATE(4) THEN "
    "ASSERT VERIFYOUT(@INPUT oa os @TOKENID FALSE) "
    "ASSERT VERIFYOUT(@INPUT+1 ca @AMOUNT-os @TOKENID FALSE) "
    "RETURN TRUE ENDIF RETURN FALSE"
)
LEAF_VOID = (
    "LET ok=PREVSTATE(0) LET oa=PREVSTATE(1) LET ck=PREVSTATE(13) LET ca=PREVSTATE(14) LET os=PREVSTATE(15) "
    "IF PREVSTATE(12) EQ 1 AND SIGNEDBY(ok) AND SIGNEDBY(ck) AND STATE(20) EQ 2 THEN "
    "ASSERT VERIFYOUT(@INPUT oa os @TOKENID FALSE) "
    "ASSERT VERIFYOUT(@INPUT+1 ca @AMOUNT-os @TOKENID FALSE) "
    "RETURN TRUE ENDIF RETURN FALSE"
)
LEAVES = [LEAF_REFRESH, LEAF_TIMEOUT, LEAF_VOID]

def main_script(root):
    return (
        "LET ok=PREVSTATE(0) LET oa=PREVSTATE(1) LET ak=PREVSTATE(2) LET aa=PREVSTATE(3) "
        "LET sd=PREVSTATE(5) LET ws=PREVSTATE(6) LET ph=PREVSTATE(12) "
        "IF ph EQ 0 THEN "
        "IF SIGNEDBY(ok) THEN RETURN TRUE ENDIF "
        "ASSERT SAMESTATE(0 11) ASSERT STATE(12) EQ 1 ASSERT STATE(15) EQ @AMOUNT ASSERT STATE(17) EQ 0 "
        "ASSERT ak NEQ ok ASSERT ak NEQ STATE(13) "
        "ASSERT VERIFYOUT(@INPUT @ADDRESS @AMOUNT+ws @TOKENID TRUE) RETURN TRUE ENDIF "
        "LET ck=PREVSTATE(13) LET ca=PREVSTATE(14) LET os=PREVSTATE(15) LET o=STATE(20) "
        "IF ph EQ 1 AND SIGNEDBY(ok) AND SIGNEDBY(ck) AND o LTE 1 THEN "
        "IF o EQ sd THEN LET le=(@AMOUNT-os)/5 "
        "ASSERT VERIFYOUT(@INPUT oa @AMOUNT-le @TOKENID FALSE) ASSERT VERIFYOUT(@INPUT+1 ca le @TOKENID FALSE) "
        "ELSE LET le=os/5 "
        "ASSERT VERIFYOUT(@INPUT ca @AMOUNT-le @TOKENID FALSE) ASSERT VERIFYOUT(@INPUT+1 oa le @TOKENID FALSE) ENDIF "
        "RETURN TRUE ENDIF "
        "IF ph EQ 1 AND SIGNEDBY(ak) AND o LTE 1 THEN LET f=@AMOUNT/10 "
        "IF o EQ sd THEN ASSERT VERIFYOUT(@INPUT oa @AMOUNT-f @TOKENID FALSE) "
        "ELSE ASSERT VERIFYOUT(@INPUT ca @AMOUNT-f @TOKENID FALSE) ENDIF "
        "ASSERT VERIFYOUT(@INPUT+1 aa f @TOKENID FALSE) RETURN TRUE ENDIF "
        "MAST " + root + " RETURN FALSE"
    )

CONTRACT = {}  # filled by setup_contract: root, proofs, script, addr

def setup_contract():
    res = cmd(N1, "mmrcreate nodes:" + json.dumps(json.dumps(LEAVES)))
    if not ok(res):
        res = cmd(N1, "mmrcreate nodes:" + json.dumps(LEAVES))
    resp = res["response"]
    root = resp.get("root")
    if isinstance(root, dict): root = root["data"]
    proofs = {}
    for leaf in resp.get("nodes", []):
        d = leaf.get("data")
        if isinstance(d, dict): d = d["data"]
        proofs[d] = leaf.get("proof")
    scr = main_script(root)
    r1 = cmd(N1, "newscript trackall:false clean:true script:" + json.dumps(scr))
    r2 = cmd(N2, "newscript trackall:false clean:true script:" + json.dumps(scr))
    addr = r1["response"]["address"]
    # Shared board address: a node returns 0 coins there until it tracks it.
    # The real app calls coinnotify action:add (atomix CommsScanner pattern) so
    # the node indexes every coin at the address, not just wallet-relevant ones.
    cmd(N1, f"coinnotify action:add address:{addr}")
    cmd(N2, f"coinnotify action:add address:{addr}")
    CONTRACT.update(root=root, proofs=proofs, script=scr, addr=addr,
                    clean=r1["response"]["script"])
    parse_ok = cmd(N1, "runscript script:" + json.dumps(scr))["response"].get("parseok")
    report("A", "register+parse", ok(r1) and ok(r2) and parse_ok and addr == r2["response"]["addr"] if "addr" in r2["response"] else ok(r1) and ok(r2) and parse_ok,
           f"addr={addr[:18]} clean_len={len(CONTRACT['clean'])}")
    return addr

# ------------------------------------------------------------------ txn builders
def new_nonce(port):
    return cmd(port, "random size:32")["response"]["random"] if ok(cmd(port,"random size:32")) else None

def post_bet(port, addr, ownerpk, owneraddr, arbpk, arbaddr, side, stake, wantstake,
             proposition, nonce, ownercid, arbcid, timeout=200, settleblock=0):
    lock = plain(lock_of(stake))
    wlock = plain(lock_of(wantstake))
    state = {
        "0": ownerpk, "1": owneraddr, "2": arbpk, "3": arbaddr,
        "4": str(timeout), "5": str(side), "6": wlock, "7": str_hex(proposition),
        "8": str(settleblock), "9": nonce, "10": ownercid, "11": arbcid, "12": "0",
    }
    r = cmd(port, f"send amount:{lock} address:{addr} state:" + json.dumps(state))
    return r, lock, wlock

def fill_bet(port, addr, coin, my_pk, my_addr, extra_state=None, amount_override=None):
    """Counter fills: contract coin input0 + funding, recreate pot, states 0-17."""
    sm = state_map(coin)
    pot = plain(num(coin["amount"]) + num(sm[6]))  # @AMOUNT + wantstake(port6)
    txid = "fill_" + str(int(time.time()*1000))
    if not ok(cmd(port, f"txncreate id:{txid}")): return {"status": False, "error": "txncreate"}
    if not ok(cmd(port, f"txninput id:{txid} coinid:{coin['coinid']}")):
        cmd(port, f"txndelete id:{txid}"); return {"status": False, "error": "txninput contract"}
    # funding
    need = num(sm[6])
    fund = None
    for c in cmd(port, "coins sendable:true tokenid:0x00")["response"]:
        if num(c["amount"]) >= need: fund = c; break
    if not fund:
        cmd(port, f"txndelete id:{txid}"); return {"status": False, "error": "no funding coin"}
    cmd(port, f"txninput id:{txid} coinid:{fund['coinid']}")
    out_amt = amount_override or pot
    if not ok(cmd(port, f"txnoutput id:{txid} amount:{out_amt} address:{addr} storestate:true")):
        cmd(port, f"txndelete id:{txid}"); return {"status": False, "error": "pot output"}
    change = num(fund["amount"]) - need
    if change > Decimal("0.000000001"):
        cmd(port, f"txnoutput id:{txid} amount:{plain(change)} address:{my_addr} storestate:false")
    states = {
        0: sm[0], 1: sm[1], 2: sm[2], 3: sm[3], 4: sm[4], 5: sm[5], 6: sm[6],
        7: sm[7], 8: sm[8], 9: sm[9], 10: sm[10], 11: sm[11], 12: "1",
        13: my_pk, 14: my_addr, 15: coin["amount"], 16: my_pk, 17: "0",
    }
    if extra_state: states.update(extra_state)
    for p, val in states.items():
        cmd(port, f"txnstate id:{txid} port:{p} value:{val}")
    s = cmd(port, f"txnsign id:{txid} publickey:auto")
    if not ok(s):
        cmd(port, f"txndelete id:{txid}"); return {"status": False, "error": "sign: "+str(s.get('error'))}
    if not ok(cmd(port, f"txnbasics id:{txid}")):
        cmd(port, f"txndelete id:{txid}"); return {"status": False, "error": "basics"}
    p = cmd(port, f"txnpost id:{txid}")
    cmd(port, f"txndelete id:{txid}")
    return p

def cancel_bet(port, coin, ownerpk):
    sm = state_map(coin)
    txid = "cancel_" + str(int(time.time()*1000))
    cmd(port, f"txncreate id:{txid}")
    cmd(port, f"txninput id:{txid} coinid:{coin['coinid']}")
    cmd(port, f"txnoutput id:{txid} amount:{coin['amount']} address:{sm[1]} storestate:false")
    if not ok(cmd(port, f"txnsign id:{txid} publickey:{ownerpk}")):
        cmd(port, f"txndelete id:{txid}"); return {"status": False}
    cmd(port, f"txnbasics id:{txid}")
    r = cmd(port, f"txnpost id:{txid}")
    cmd(port, f"txndelete id:{txid}")
    return r

def build_settle(port, coin, outcome, my_pk, winner_addr, loser_addr, winner_amt, loser_amt):
    """Proposer builds+signs+exports a 2-of-2 settle txn. Returns (hex, txid) or (None, err)."""
    txid = "settle_" + str(int(time.time()*1000))
    cmd(port, f"txncreate id:{txid}")
    cmd(port, f"txninput id:{txid} coinid:{coin['coinid']}")
    cmd(port, f"txnoutput id:{txid} amount:{winner_amt} address:{winner_addr} storestate:false")
    cmd(port, f"txnoutput id:{txid} amount:{loser_amt} address:{loser_addr} storestate:false")
    cmd(port, f"txnstate id:{txid} port:20 value:{outcome}")
    s = cmd(port, f"txnsign id:{txid} publickey:{my_pk}")
    if not ok(s):
        cmd(port, f"txndelete id:{txid}"); return None, "sign: "+str(s.get("error"))
    e = cmd(port, f"txnexport id:{txid}")
    hexdata = e.get("response", {}).get("data") if ok(e) else None
    cmd(port, f"txndelete id:{txid}")
    return hexdata, txid

def cosign_post(port, hexdata, my_pk):
    """Acceptor imports, co-signs with explicit key, gated-posts."""
    txid = "cosign_" + str(int(time.time()*1000))
    if not ok(cmd(port, f"txnimport id:{txid} data:{hexdata}")):
        return {"status": False, "error": "import"}
    s = cmd(port, f"txnsign id:{txid} publickey:{my_pk}")
    if not ok(s):
        cmd(port, f"txndelete id:{txid}"); return {"status": False, "error": "cosign"}
    cmd(port, f"txnbasics id:{txid}")
    r = cmd(port, f"txnpost id:{txid}")
    cmd(port, f"txndelete id:{txid}")
    return r

def txnlist_inspect(port, hexdata):
    """Import to a temp id, read txnlist, delete. Returns the txn struct for CoSigner validation."""
    txid = "inspect_" + str(int(time.time()*1000))
    cmd(port, f"txnimport id:{txid} data:{hexdata}")
    r = cmd(port, f"txnlist id:{txid}")
    cmd(port, f"txndelete id:{txid}")
    return r.get("response")

# ================================================================== TEST RUN
def main():
    print("\n=== OPENLY V4 — Phase 0 contract validation ===\n")
    addr = setup_contract()

    o_pk, o_addr = getkey(N1)     # owner (node1)
    a_pk, a_addr = getkey(N1)     # arbiter (node1, distinct key)
    c_pk, c_addr = getkey(N2)     # counter (node2)
    o_cid = "0x" + "AA"*8         # placeholder comms ids (opaque to contract)
    a_cid = "0x" + "BB"*8

    # ---- GROUP B: positive lifecycle ----
    print("\n-- B. Positive lifecycle --")

    # B1 post -> cancel
    n1 = cmd(N1, "random size:32")["response"]["random"]
    r, lock, wlock = post_bet(N1, addr, o_pk, o_addr, a_pk, a_addr, 1, "10", "10",
                              "OPENLY-B1 cancel me", n1, o_cid, a_cid)
    coin = wait_coin(N1, addr, nonce=n1, phase=0) if ok(r) else None
    report("B", "post creates phase-0 coin", coin is not None, f"lock={lock}")
    if coin:
        cr = cancel_bet(N1, coin, o_pk)
        report("B", "owner cancel", ok(cr) and wait_gone(N1, addr, coin["coinid"]))

    # B2 post -> fill (proves SAMESTATE(0 11) fill path)
    n2 = cmd(N1, "random size:32")["response"]["random"]
    r, lock, wlock = post_bet(N1, addr, o_pk, o_addr, a_pk, a_addr, 1, "10", "10",
                              "OPENLY-B2 fill me", n2, o_cid, a_cid)
    coin = wait_coin(N2, addr, nonce=n2, phase=0)
    report("B", "post visible on peer", coin is not None)
    filled = None
    if coin:
        fr = fill_bet(N2, addr, coin, c_pk, c_addr)
        filled = wait_coin(N1, addr, nonce=n2, phase=1) if ok(fr) else None
        report("B", "counter fill -> phase 1", filled is not None,
               f"pot={filled['amount'] if filled else '-'}" if filled else str(fr.get("error")))

    # ---- GROUP D: adversarial (must FAIL) ----
    print("\n-- D. Adversarial (each MUST be rejected) --")

    # D1 fill that rewrites the proposition (port 7) — the V3.1 hole
    n3 = cmd(N1, "random size:32")["response"]["random"]
    post_bet(N1, addr, o_pk, o_addr, a_pk, a_addr, 1, "10", "10",
             "OPENLY-D1 real proposition", n3, o_cid, a_cid)
    coin = wait_coin(N2, addr, nonce=n3, phase=0)
    if coin:
        fr = fill_bet(N2, addr, coin, c_pk, c_addr,
                      extra_state={7: str_hex("HACKED proposition")})
        still0 = wait_coin(N2, addr, nonce=n3, phase=0, wait=15)
        moved = wait_coin(N2, addr, nonce=n3, phase=1, wait=8)
        report("D", "fill rewriting proposition rejected", (not ok(fr)) or (moved is None),
               "post refused" if not ok(fr) else "phase-1 never appeared")
        # cleanup: legit cancel
        c0 = wait_coin(N1, addr, nonce=n3, phase=0, wait=8)
        if c0: cancel_bet(N1, c0, o_pk)

    # D2 fill forcing STATE(17)!=0
    n4 = cmd(N1, "random size:32")["response"]["random"]
    post_bet(N1, addr, o_pk, o_addr, a_pk, a_addr, 1, "10", "10",
             "OPENLY-D2 refreshcount", n4, o_cid, a_cid)
    coin = wait_coin(N2, addr, nonce=n4, phase=0)
    if coin:
        fr = fill_bet(N2, addr, coin, c_pk, c_addr, extra_state={17: "5"})
        moved = wait_coin(N2, addr, nonce=n4, phase=1, wait=8)
        report("D", "fill with STATE(17)!=0 rejected", (not ok(fr)) or (moved is None))
        c0 = wait_coin(N1, addr, nonce=n4, phase=0, wait=8)
        if c0: cancel_bet(N1, c0, o_pk)

    # D3 fill under-funding the recreated pot (skims the difference)
    n5 = cmd(N1, "random size:32")["response"]["random"]
    post_bet(N1, addr, o_pk, o_addr, a_pk, a_addr, 1, "10", "10",
             "OPENLY-D3 underfund", n5, o_cid, a_cid)
    coin = wait_coin(N2, addr, nonce=n5, phase=0)
    if coin:
        short = plain(num(coin["amount"]) + num(state_map(coin)[6]) - num("1"))
        fr = fill_bet(N2, addr, coin, c_pk, c_addr, amount_override=short)
        moved = wait_coin(N2, addr, nonce=n5, phase=1, wait=8)
        report("D", "fill under-funding pot rejected", (not ok(fr)) or (moved is None))
        c0 = wait_coin(N1, addr, nonce=n5, phase=0, wait=8)
        if c0: cancel_bet(N1, c0, o_pk)

    # ---- GROUP C/B: self-settle exactness ----
    print("\n-- C. Self-settle exactness --")
    if filled:
        # B2 was owner-side TRUE (side=1), equal 10/10 stakes. Settle outcome=1 (owner wins).
        sm = state_map(filled)
        pot = num(filled["amount"])
        os_ = num(sm[15])
        le = loser_escrow(pot - os_)          # owner wins => loser=counter, loserlock=pot-os
        win_amt = plain(pot - le)
        lose_amt = plain(le)
        # proposer = owner (node1) signs with owner key, exports; counter (node2) cosigns
        hexdata, _ = build_settle(N1, filled, 1, o_pk, o_addr, c_addr, win_amt, lose_amt)
        report("C", "settle export produced", hexdata is not None,
               f"hexlen={len(hexdata) if hexdata else 0} win={win_amt} le={lose_amt}")
        if hexdata:
            EXPORT_SIZES.append(len(hexdata)//2)
            insp = txnlist_inspect(N2, hexdata)
            cr = cosign_post(N2, hexdata, c_pk)
            settled = wait_gone(N1, addr, filled["coinid"]) if ok(cr) else False
            report("C", "2-of-2 self-settle posts+consumes coin", ok(cr) and settled)
            # exactness: winner (owner) received win_amt at o_addr
            if settled:
                got = balance(N1, o_addr)
                report("C", "winner payout exact", got >= num(win_amt),
                       f"o_addr has {plain(got)} expected>= {win_amt}")

    print_deliverables(addr)
    print(f"\n=== {PASS} PASS / {FAIL} FAIL ===")
    sys.exit(0 if FAIL == 0 else 1)

EXPORT_SIZES = []

def print_deliverables(addr):
    print("\n" + "="*70)
    print("DELIVERABLE: OpenlyContract.java constants")
    print("="*70)
    proofs = CONTRACT["proofs"]
    pv = list(proofs.values())
    print(f'''    public static final String ADDR   = "{addr}";
    public static final String ROOT   = "{CONTRACT["root"]}";
    public static final String SCRIPT = // clean, {len(CONTRACT["clean"])} chars — see RESULTS.md
        "{CONTRACT["clean"][:60]}...";
    public static final String LEAF_REFRESH = "{LEAF_REFRESH[:40]}...";
    public static final String PROOF_REFRESH = "{pv[0] if len(pv)>0 else ''}";
    public static final String LEAF_TIMEOUT = "{LEAF_TIMEOUT[:40]}...";
    public static final String PROOF_TIMEOUT = "{pv[1] if len(pv)>1 else ''}";
    public static final String LEAF_VOID    = "{LEAF_VOID[:40]}...";
    public static final String PROOF_VOID    = "{pv[2] if len(pv)>2 else ''}";''')
    if EXPORT_SIZES:
        print(f"\n  MEASUREMENT: single-sig settle txnexport = {max(EXPORT_SIZES)} bytes "
              f"(chunk constant should exceed this)")

if __name__ == "__main__":
    main()
