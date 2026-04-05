/**
 * Wager — KISS VM Prediction Market Contract
 *
 * State layout:
 *   Port 0  = ownerpk        (owner's signing public key)
 *   Port 1  = owneraddr      (owner's payout address)
 *   Port 2  = arbpk          (arbiter's signing public key)
 *   Port 3  = arbaddr        (arbiter's payout address — receives 10% of winner's profit on dispute)
 *   Port 4  = phase          (0=open order, 1=matched bet)
 *   Port 5  = timeout        (blocks before arbiter timeout in phase 1)
 *   Port 6  = side           (1=YES, 0=NO — owner's side)
 *   Port 7  = wantstake      (amount counter must put up)
 *   Port 8  = counterpk      (counter's signing public key — set at fill)
 *   Port 9  = counteraddr    (counter's payout address — set at fill)
 *   Port 10 = ownerstake     (enforced = @AMOUNT at fill time)
 *   Port 11 = outcome        (set by arbiter: 1=YES, 0=NO)
 *
 * Paths:
 *   Phase 0, SIGNEDBY(owner)        → Cancel (owner reclaims)
 *   Phase 0, anyone                 → Fill (combine stakes, phase→1)
 *   Phase 1, SIGNEDBY(both bettors)  → Self-settle (0% fee — players agree on outcome)
 *   Phase 1, SIGNEDBY(arbiter) o=0|1 → Arbiter resolve (10% of profit — players disagreed)
 *   Phase 1, SIGNEDBY(arbiter) o=2   → Arbiter void (10% of pot — tie/undecidable, 90% refund each)
 *   Phase 1, @COINAGE GT timeout    → Timeout (refund both, no fee)
 */

var WAGER_SCRIPT =
    "LET opk=PREVSTATE(0) LET oa=PREVSTATE(1) LET apk=PREVSTATE(2) LET aa=PREVSTATE(3) " +
    "LET ph=PREVSTATE(4) LET to=PREVSTATE(5) LET sd=PREVSTATE(6) LET ws=PREVSTATE(7) " +
    "IF ph EQ 0 AND SIGNEDBY(opk) THEN RETURN TRUE ENDIF " +
    "IF ph EQ 0 THEN " +
        "ASSERT SAMESTATE(0 3) ASSERT STATE(4) EQ 1 ASSERT SAMESTATE(5 7) " +
        "ASSERT STATE(10) EQ @AMOUNT " +
        "ASSERT VERIFYOUT(@INPUT @ADDRESS @AMOUNT+ws @TOKENID TRUE) " +
        "RETURN TRUE " +
    "ENDIF " +
    "LET cpk=PREVSTATE(8) LET ca=PREVSTATE(9) LET os=PREVSTATE(10) " +
    "IF ph EQ 1 AND SIGNEDBY(opk) AND SIGNEDBY(cpk) THEN RETURN TRUE ENDIF " +
    "IF ph EQ 1 AND SIGNEDBY(apk) THEN " +
        "LET o=STATE(11) " +
        "IF o EQ 2 THEN " +
            "LET f=@AMOUNT/10 LET r=os-os/10 " +
            "ASSERT VERIFYOUT(@INPUT oa r @TOKENID FALSE) " +
            "ASSERT VERIFYOUT(@INPUT+1 ca @AMOUNT-f-r @TOKENID FALSE) " +
            "ASSERT VERIFYOUT(@INPUT+2 aa f @TOKENID FALSE) " +
            "RETURN TRUE " +
        "ENDIF " +
        "IF o EQ sd THEN " +
            "LET f=(@AMOUNT-os)/10 " +
            "ASSERT VERIFYOUT(@INPUT oa @AMOUNT-f @TOKENID FALSE) " +
        "ELSE " +
            "LET f=os/10 " +
            "ASSERT VERIFYOUT(@INPUT ca @AMOUNT-f @TOKENID FALSE) " +
        "ENDIF " +
        "ASSERT VERIFYOUT(@INPUT+1 aa f @TOKENID FALSE) " +
        "RETURN TRUE " +
    "ENDIF " +
    "IF ph EQ 1 AND @COINAGE GT to THEN " +
        "ASSERT VERIFYOUT(@INPUT oa os @TOKENID FALSE) " +
        "ASSERT VERIFYOUT(@INPUT+1 ca @AMOUNT-os @TOKENID FALSE) " +
        "RETURN TRUE " +
    "ENDIF " +
    "RETURN FALSE";

var WAGER_SCRIPT_ADDRESS = "";

function registerContract(callback) {
    MDS.cmd('newscript trackall:true script:"' + WAGER_SCRIPT + '"', function(res) {
        if (res.status) {
            WAGER_SCRIPT_ADDRESS = res.response.address;
            MDS.log("Wager contract registered at: " + WAGER_SCRIPT_ADDRESS);
        }
        if (callback) callback(res);
    });
}