# Openly V4 — Phase 0 Contract Validation Results

Contract-first validation of the hardened V4 prediction-market contract, run on two
private Minima nodes before any Android code. Harness: `tests/test_v4.py`.
Date: 2026-08-04. Result: **11 PASS / 0 FAIL.**

## Pinned artifacts

| | |
|---|---|
| Script address | `0xA4A22FD98BE0346547764EB39477CB6FB3E0C6CD22C10BB9D8D590B131B15DE0` |
| MAST root | `0x265E914D6805AF4047CD83897AB2CF5E0585D648EE5B407AF1484DC00D39CDA6` |
| Main script | clean form 1177 chars (under the ~1200 KISS limit) |
| Comms channel | `0x4F50454E4C59` = hex("OPENLY") |

Full constants + leaf proofs: `tests/OpenlyContract.java.txt`.

## What passed

**A. Registration + parse** — main script `parseok:true`; identical address on both nodes;
clean form 1177 chars.

**B. Positive lifecycle**
- post → phase-0 coin (lock 12.5 = stake 10 × 1.25)
- owner cancel (SIGNEDBY(owner) phase-0 path) consumes the coin
- post visible on peer after `coinnotify action:add address:ADDR`
- counter fill → phase 1, pot 25 (proves `SAMESTATE(0 11)` fill path works)
- 2-of-2 self-settle posts and consumes the matched coin

**C. Settlement exactness (the finding-#2 fix)** — matched pot 25, owner wins (outcome=1):
`le = (25 − 12.5)/5 = 2.5`, winner receives `22.5`, exact on-chain. No float brick: the
V3.1 failure was purely JS `Math.floor(x*1e8)/1e8`; `/5` and `/10` terminate in base-10, so
BigDecimal `MathContext(64, DOWN)` and the KISS VM agree bit-for-bit.

**D. Adversarial — every one rejected (the finding-#4 fix)**
- fill rewriting the proposition (port 7) → phase-1 never appears (V3.1's hole, now closed)
- fill forcing `STATE(17) ≠ 0` → rejected
- fill under-funding the recreated pot by 1 → rejected

## Measurements (gate downstream design)

- **Single-signature settle `txnexport` = 4861 bytes.** Fits a single 8 KB comms chunk →
  **the top-ranked risk (settlement transport size) is retired**; SETTLE_TXN chunking is a
  safety margin, not a routine path.

## Not yet covered (tracked for completion of Phase 0)

The security-critical and core-lifecycle vectors are green. Remaining harness vectors to add
before locking Phase 0 fully:
- arbiter resolve (both outcomes) — exact 10% fee
- void leaf (2-of-2, outcome=2) refund exactness
- refresh leaf: nonce/coinid tracking across refresh×2; reject mutation of any pinned port;
  reject missing `+1` increment; reject past the 200 cap
- timeout leaf: reject before `@COINAGE GT` port 4; proportional refund after
- CoSigner negative suite: settle export with an extra attacker input / wrong split / extra
  output / wrong outcome / bad sha3 — each must be refused before `txnsign` (Phase 6)
- confirm KISS non-short-circuit `AND` + missing-`STATE` error via `runscript`

## Reproduce

Two private nodes (solo genesis + connected peer):
```
java -jar minima.jar -data <d1> -port 21001 -rpc 21005 -rpcenable -solo -daemon
java -jar minima.jar -data <d2> -port 22001 -rpc 22005 -rpcenable -test -nop2p \
     -connect 127.0.0.1:21001 -daemon
python3 tests/test_v4.py
```
