/**
 * Wager — Background Service
 * Registers the prediction market contract and tracks all coins at the script address
 */

var SCRIPT = 'LET opk=PREVSTATE(0) LET oa=PREVSTATE(1) LET apk=PREVSTATE(2) LET aa=PREVSTATE(3) LET ph=PREVSTATE(4) LET to=PREVSTATE(5) LET sd=PREVSTATE(6) LET ws=PREVSTATE(7) IF ph EQ 0 AND SIGNEDBY(opk) THEN RETURN TRUE ENDIF IF ph EQ 0 THEN ASSERT SAMESTATE(0 3) ASSERT STATE(4) EQ 1 ASSERT SAMESTATE(5 7) ASSERT STATE(10) EQ @AMOUNT ASSERT VERIFYOUT(@INPUT @ADDRESS @AMOUNT+ws @TOKENID TRUE) RETURN TRUE ENDIF LET cpk=PREVSTATE(8) LET ca=PREVSTATE(9) LET os=PREVSTATE(10) IF ph EQ 1 AND SIGNEDBY(opk) AND SIGNEDBY(cpk) THEN RETURN TRUE ENDIF IF ph EQ 1 AND SIGNEDBY(apk) THEN LET o=STATE(11) IF o EQ 2 THEN LET f=@AMOUNT/10 LET r=os-os/10 ASSERT VERIFYOUT(@INPUT oa r @TOKENID FALSE) ASSERT VERIFYOUT(@INPUT+1 ca @AMOUNT-f-r @TOKENID FALSE) ASSERT VERIFYOUT(@INPUT+2 aa f @TOKENID FALSE) RETURN TRUE ENDIF IF o EQ sd THEN LET f=(@AMOUNT-os)/10 ASSERT VERIFYOUT(@INPUT oa @AMOUNT-f @TOKENID FALSE) ELSE LET f=os/10 ASSERT VERIFYOUT(@INPUT ca @AMOUNT-f @TOKENID FALSE) ENDIF ASSERT VERIFYOUT(@INPUT+1 aa f @TOKENID FALSE) RETURN TRUE ENDIF IF ph EQ 1 AND @COINAGE GT to THEN ASSERT VERIFYOUT(@INPUT oa os @TOKENID FALSE) ASSERT VERIFYOUT(@INPUT+1 ca @AMOUNT-os @TOKENID FALSE) RETURN TRUE ENDIF RETURN FALSE';

var SCRIPT_ADDR = "";

MDS.init(function(msg) {
    if (msg.event === "inited") {
        MDS.cmd('newscript script:"' + SCRIPT + '" trackall:true', function(res) {
            if (res.status) {
                SCRIPT_ADDR = res.response.address;
                MDS.log("Wager service: contract at " + SCRIPT_ADDR);
            }
        });
    }

    if (msg.event === "NEWBLOCK") {
        if (!SCRIPT_ADDR) {
            MDS.cmd('newscript script:"' + SCRIPT + '" trackall:true', function(res) {
                if (res.status) SCRIPT_ADDR = res.response.address;
            });
        }
    }
});