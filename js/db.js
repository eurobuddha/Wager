/**
 * Wager — Database Layer (H2 SQL)
 *
 * Tables:
 *   bets       — all known bets (open, matched, resolved)
 *   markets    — event definitions (event text + arbiter)
 *   activity   — activity log
 */

var DB_READY = false;

function initDB(callback) {
    MDS.sql("SELECT 1 FROM bets LIMIT 1", function(res) {
        if (res.status) {
            DB_READY = true;
            if (callback) callback();
        } else {
            createTables(function() {
                DB_READY = true;
                if (callback) callback();
            });
        }
    });
}

function createTables(callback) {
    MDS.sql(
        "CREATE TABLE IF NOT EXISTS `bets` (" +
        "  `id` bigint auto_increment," +
        "  `betid` varchar(160) NOT NULL," +
        "  `coinid` varchar(160)," +
        "  `market` varchar(512) NOT NULL," +
        "  `arbpk` varchar(512) NOT NULL," +
        "  `arbaddr` varchar(256) NOT NULL," +
        "  `arbname` varchar(256)," +
        "  `side` int NOT NULL," +
        "  `ownerstake` varchar(80)," +
        "  `counterstake` varchar(80)," +
        "  `ownerpk` varchar(512)," +
        "  `owneraddr` varchar(256)," +
        "  `ownermxkey` varchar(1024)," +
        "  `counterpk` varchar(512)," +
        "  `counteraddr` varchar(256)," +
        "  `countermxkey` varchar(1024)," +
        "  `arbitermxkey` varchar(1024)," +
        "  `phase` int NOT NULL," +
        "  `outcome` int," +
        "  `timeout` int NOT NULL," +
        "  `myrole` varchar(20)," +
        "  `status` varchar(32) NOT NULL," +
        "  `created` bigint NOT NULL" +
        ")", function() {
        MDS.sql(
            "CREATE TABLE IF NOT EXISTS `markets` (" +
            "  `id` bigint auto_increment," +
            "  `name` varchar(512) NOT NULL," +
            "  `arbpk` varchar(512) NOT NULL," +
            "  `arbname` varchar(256)," +
            "  `deadline` varchar(80)," +
            "  `created` bigint NOT NULL" +
            ")", function() {
            MDS.sql(
                "CREATE TABLE IF NOT EXISTS `activity` (" +
                "  `id` bigint auto_increment," +
                "  `msg` varchar(512) NOT NULL," +
                "  `type` varchar(10) NOT NULL," +
                "  `timestamp` bigint NOT NULL" +
                ")", function() {
            MDS.sql(
                "CREATE TABLE IF NOT EXISTS `messages` (" +
                "  `id` bigint auto_increment," +
                "  `randomid` varchar(128) NOT NULL," +
                "  `betid` varchar(160)," +
                "  `type` varchar(64) NOT NULL," +
                "  `sender_mxkey` varchar(1024)," +
                "  `sender_name` varchar(256)," +
                "  `data` clob," +
                "  `direction` varchar(16)," +
                "  `created` bigint NOT NULL" +
                ")", function() { if (callback) callback(); });
        });
        });
    });
}

// -- Bets --

function insertBet(bet, callback) {
    MDS.sql(
        "INSERT INTO bets (betid, coinid, market, arbpk, arbaddr, arbname, side, " +
        "ownerstake, counterstake, ownerpk, owneraddr, ownermxkey, counterpk, counteraddr, " +
        "countermxkey, arbitermxkey, phase, outcome, timeout, myrole, status, created) VALUES (" +
        "'" + sqlEsc(bet.betid) + "', " +
        "'" + sqlEsc(bet.coinid || "") + "', " +
        "'" + sqlEsc(bet.market) + "', " +
        "'" + sqlEsc(bet.arbpk) + "', " +
        "'" + sqlEsc(bet.arbaddr) + "', " +
        "'" + sqlEsc(bet.arbname || "") + "', " +
        bet.side + ", " +
        "'" + sqlEsc(bet.ownerstake) + "', " +
        "'" + sqlEsc(bet.counterstake || "") + "', " +
        "'" + sqlEsc(bet.ownerpk || "") + "', " +
        "'" + sqlEsc(bet.owneraddr || "") + "', " +
        "'" + sqlEsc(bet.ownermxkey || "") + "', " +
        "'" + sqlEsc(bet.counterpk || "") + "', " +
        "'" + sqlEsc(bet.counteraddr || "") + "', " +
        "'" + sqlEsc(bet.countermxkey || "") + "', " +
        "'" + sqlEsc(bet.arbitermxkey || "") + "', " +
        bet.phase + ", " +
        (bet.outcome != null ? bet.outcome : "NULL") + ", " +
        bet.timeout + ", " +
        "'" + sqlEsc(bet.myrole || "") + "', " +
        "'" + sqlEsc(bet.status) + "', " +
        Date.now() + ")",
        callback
    );
}

function updateBetStatus(betid, status, phase, callback) {
    MDS.sql("UPDATE bets SET status='" + sqlEsc(status) + "', phase=" + phase +
            " WHERE betid='" + sqlEsc(betid) + "'", callback);
}

function updateBetCoin(betid, coinid, callback) {
    MDS.sql("UPDATE bets SET coinid='" + sqlEsc(coinid) + "' WHERE betid='" + sqlEsc(betid) + "'", callback);
}

function updateBetFill(betid, coinid, counterpk, counteraddr, counterstake, callback) {
    MDS.sql("UPDATE bets SET coinid='" + sqlEsc(coinid) + "', " +
            "counterpk='" + sqlEsc(counterpk) + "', " +
            "counteraddr='" + sqlEsc(counteraddr) + "', " +
            "counterstake='" + sqlEsc(counterstake) + "', " +
            "phase=1, status='MATCHED' " +
            "WHERE betid='" + sqlEsc(betid) + "'", callback);
}

function updateBetOutcome(betid, outcome, status, callback) {
    MDS.sql("UPDATE bets SET outcome=" + outcome + ", status='" + sqlEsc(status) +
            "', phase=2 WHERE betid='" + sqlEsc(betid) + "'", callback);
}

function loadBet(betid, callback) {
    MDS.sql("SELECT * FROM bets WHERE betid='" + sqlEsc(betid) + "'", function(res) {
        callback(res.status && res.rows && res.rows.length > 0 ? res.rows[0] : null);
    });
}

function loadAllBets(callback) {
    MDS.sql("SELECT * FROM bets ORDER BY created DESC LIMIT 500", function(res) {
        callback(res.status ? (res.rows || []) : []);
    });
}

function deleteBet(betid, callback) {
    MDS.sql("DELETE FROM bets WHERE betid='" + sqlEsc(betid) + "'", callback);
}

// -- Markets --

function insertMarket(market, callback) {
    MDS.sql(
        "INSERT INTO markets (name, arbpk, arbname, deadline, created) VALUES (" +
        "'" + sqlEsc(market.name) + "', " +
        "'" + sqlEsc(market.arbpk) + "', " +
        "'" + sqlEsc(market.arbname || "") + "', " +
        "'" + sqlEsc(market.deadline || "") + "', " +
        Date.now() + ")",
        callback
    );
}

function loadMarkets(callback) {
    MDS.sql("SELECT * FROM markets ORDER BY created DESC LIMIT 100", function(res) {
        callback(res.status ? (res.rows || []) : []);
    });
}

// -- Activity Log --

function logActivity(msg, type) {
    MDS.sql("INSERT INTO activity (msg, type, timestamp) VALUES ('" +
            sqlEsc(msg) + "', '" + sqlEsc(type || "info") + "', " + Date.now() + ")");
}

function loadActivity(callback) {
    MDS.sql("SELECT * FROM activity ORDER BY timestamp DESC LIMIT 200", function(res) {
        callback(res.status ? (res.rows || []) : []);
    });
}

// -- Mx Keys --

function updateBetMxKeys(betid, field, mxkey, callback) {
    MDS.sql("UPDATE bets SET " + field + "='" + sqlEsc(mxkey) + "' WHERE betid='" + sqlEsc(betid) + "'", callback);
}

// -- Messages --

function insertMessage(msg, callback) {
    MDS.sql(
        "INSERT INTO messages (randomid, betid, type, sender_mxkey, sender_name, data, direction, created) VALUES (" +
        "'" + sqlEsc(msg.randomid) + "', " +
        "'" + sqlEsc(msg.betid || "") + "', " +
        "'" + sqlEsc(msg.type) + "', " +
        "'" + sqlEsc(msg.sender_mxkey || "") + "', " +
        "'" + sqlEsc(msg.sender_name || "") + "', " +
        "'" + sqlEsc(msg.data || "") + "', " +
        "'" + sqlEsc(msg.direction || "received") + "', " +
        Date.now() + ")",
        callback
    );
}

function messageExists(randomid, callback) {
    MDS.sql("SELECT * FROM messages WHERE randomid='" + sqlEsc(randomid) + "'", function(res) {
        callback(res.status && res.rows && res.rows.length > 0);
    });
}

function loadPendingProposals(callback) {
    MDS.sql("SELECT * FROM messages WHERE type='SETTLE_PROPOSE' AND direction='received' ORDER BY created DESC LIMIT 50", function(res) {
        callback(res.status ? (res.rows || []) : []);
    });
}

// -- Helpers --

function sqlEsc(val) {
    if (val === null || val === undefined) return "";
    return String(val).replace(/'/g, "''");
}