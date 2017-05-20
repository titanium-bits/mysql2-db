const async = require('async');
const dbconfig = require('./config/dbconfig.json');
const db = require('./db');

function dbact(cfg, ops, callback) {
    return db.act(cfg, ops, callback);
}
function dbtransact(cfg, ops, callback) {
    return db.transact(cfg, ops, callback);
}
// some of the time, we'll call db.act, sometimes db.transact, so here's a function reference that can switch between the two...
var dbfn = dbact;

// many of our tests will need to create temporary tables, so here's a function to make sorta-random table names
var tblcnt = 0;
function generateRandomName() {
    return "TMP" + Math.floor(Math.random() * 10000) + "_" + tblcnt;
}


// here's our list of tests. each throws an Error on failure.
var simpleTests = [
    canonicalExample,
    tablelessQuery, differentParamTypes, simpleInsertsWithQueryScalar, insertWithLastInsertId, manyInsertsWithQueryList,
    invalidPoolConfig, invalidSql, emptyResultSet, castFloatFails, castIntegerFails,
    repetitionsFails, repetitiousSuccess
];

// We can reuse each simple test, running it first in an autocommit mode, then in a non-autocommit mode.
// wrap each of the tests with a function that echoes the function name, then calls the function in autocommit and transactional mode
var compositeTests = simpleTests.map((fn) => {
    return (cb) => {
        dbfn = dbact;
        console.log(fn.name + " with autocommit");
        fn(() => {
            dbfn = dbtransact;
            console.log(fn.name + " with transaction");
            fn(cb);
        });
    }
});

// finally, append some additional tests that combine transactional and non-transactional operations
var dualTests = [
    failWithRollback
];

async.series(compositeTests.concat(dualTests), alldone);


function canonicalExample(callback) {
    var tbl = generateRandomName();
    dbfn(
        dbconfig,
        [
            db.execute("create table " + tbl + "(col1 mediumint, col2 varchar(50), col3 varchar(50))"),
            db.execute("insert into " + tbl + "(col1, col2, col3) values (?,?,?)", [0, 'hello', 'world']), // insert row, old-fashioned prepare
            db.execute("insert into " + tbl + "(col1, col2, col3) values (:id, :x, :y)", { id: 1, x: 'Also', y: 'ok' }), // insert row, using named parameters
            db.queryInt("select count(*) from " + tbl + ""), // queryInt retrieves just a single integer; you can also pass a default value, see queryInt docs
            db.execute("insert into " + tbl + "(col1, col2, col3) values ($3, :t, :y)", { t: 'Inter-statement', y: 'reference!' }), // $3 refers to result of statement 3, i.e., the queryInt
            db.queryString("select col2 from " + tbl + " where col1 = 2"), // so this should return the value that we inserted, just above
            db.execute("insert into " + tbl + "(col1, col2, col3) values (?,?,?)", [[3, 'three', 'yeah'], [4, 'four', 'no'], [5, 'five', 'maybe']]), // can insert several items (binding params as above)
            db.execute("update " + tbl + " set col3 = col2 where col1 > :minval", { minval: 2 }), // should affect rows with col1=3, 4, and 5
            db.query("select * from " + tbl + " where col1 < :maxval order by col1 desc", { maxval: 2 }), // dump an array of objects for col1=0 and col1=1
            db.execute("drop table " + tbl + "")
        ], (error, results) => {
            if (error != null) throw new Error("An error was thrown: " + error.message);
            if (results == null) throw new Error("No results were returned");
            if (results.length == 0) throw new Error("There should have been one result per statement");
            if (results[0] != 0) throw new Error("CREATE TABLE actions should return a result of 0 (i.e., 0 rows impacted)");
            if (results[1] != 1) throw new Error("Inserting 1 row should have returned a result of 1 (i.e., 1 row impacted)");
            if (results[2] != 1) throw new Error("Inserting 1 row should have returned a result of 1 (i.e., 1 row impacted)");
            if (results[3] != 2) throw new Error("We inserted 2 rows, so why didn't count(*) return 2?");
            if (results[4] != 1) throw new Error("Inserting 1 row should have returned a result of 1 (i.e., 1 row impacted)");
            if (results[5] != 'Inter-statement') throw new Error("Should have gotten back the value we inserted into the row with col1=2");

            if (results[6] != 3) throw new Error("Inserting 3 rows should have affected 3 rows");
            if (results[7] != 3) throw new Error("Updating 3 rows should have affected three rows (i.e., those with col1 = 3, 4, and 5)");

            if (Array.isArray(results[8]) == false) throw new Error("Calling query() should return an array.");
            if (results[8].length != 2) throw new Error("Querying for the rows with col1 < 2 should have returned 2 rows");
            if ((typeof results[8][0]) != "object") throw new Error("query() should return an array of **objects**");
            if (results[8][0].col1 != 1) throw new Error("We asked for all the rows in order of decreasing col1; why didn't we get col1 as the first entry?");
            if (results[8][1].col2 != 'hello') throw new Error("The col2 column for the second row in our result set (by decreasing col1) should have been 'hello'");

            process.nextTick(callback);
        }
    );
}


function tablelessQuery(callback) {
    dbfn(
        dbconfig,
        db.queryInt("select 1+1"),
        function (err, results) {
            if (err) throw err;
            if (!results) throw new Error("No results");
            if (!results.length) throw new Error("Empty results");
            if (results[0] != 2) throw new Error("Incorrect result; 1+1=" + results[0]);
            process.nextTick(callback);
        }
    );
}

function differentParamTypes(callback) {
    var tbl = generateRandomName();
    dbfn(dbconfig,
        [
            db.execute("create table " + tbl + "(ival MEDIUMINT, fval FLOAT, sval VARCHAR(256), nval VARCHAR(25))"),
            db.execute("insert into " + tbl + "(ival, fval, sval) values (:0, :1, :2)", [3, 0.25, 'happy']),
            db.queryInt("select ival from " + tbl),
            db.queryFloat("select fval from " + tbl),
            db.queryString("select sval from " + tbl),
            db.queryString("select nval from " + tbl),
            db.execute("DROP TABLE " + tbl)
        ], (err, results) => {
            if (err) throw err;
            if (!results) throw new Error("No results");
            if (!results.length) throw new Error("Empty results");
            if (results[1] != 1) throw new Error("One row should have been inserted");
            if (results[2] != 3) throw new Error("Integer should have come back as 3");
            if (results[3] != 0.25) throw new Error("Float should have come back as 0.25");
            if (results[4] != 'happy') throw new Error("String should have come back as happy");
            if (results[5] !== undefined) throw new Error("Unset nullable value should have come back as undefined: " + results[5]);
            process.nextTick(callback);
        }
    );
}

function simpleInsertsWithQueryScalar(callback) {
    var tbl = generateRandomName();
    dbfn(
        dbconfig,
        [
            db.execute("CREATE TABLE " + tbl + "(id MEDIUMINT NOT NULL AUTO_INCREMENT, txt VARCHAR(256) NOT NULL, rate FLOAT, PRIMARY KEY(id))"),
            db.execute("insert into " + tbl + "(txt,rate) values(:txt,:rate)", { txt: "one", rate: 3.14 }),
            db.queryInt("select count(*) from " + tbl),
            db.execute("insert into " + tbl + "(txt,rate) values(:txt, :rate)", [{ txt: "two", rate: 2 }, { txt: "three", rate: 3 }, { txt: "four", rate: 4 }]),
            db.queryFloat("select max(rate) from " + tbl + " where id <> rate"),
            db.execute("DROP TABLE " + tbl)
        ], function (err, results) {
            //console.log(JSON.stringify(results));
            if (err) throw err;
            if (!results) throw new Error("No results");
            if (!results.length) throw new Error("Empty results");
            if (results.length != 6) throw new Error("Incorrect number of results returned: " + results.length);
            if (results[2] != 1) throw new Error("Select count(*) returned incorrect result");
            if (results[3] != 3) throw new Error("Failed to bulk-insert three rows into the database");
            if (Math.abs(results[4] - 3.14) > 0.01) throw new Error("Select max returned " + results[4] + " instead of expected value");
            process.nextTick(callback);
        }
    );
}

function insertWithLastInsertId(callback) {
    var tbl = generateRandomName();
    dbfn(dbconfig, [
        db.execute("CREATE TABLE " + tbl + "(id MEDIUMINT NOT NULL AUTO_INCREMENT, txt VARCHAR(256) NOT NULL, rate FLOAT, PRIMARY KEY(id))"),
        db.execute("insert into " + tbl + "(txt) values('one')"),
        db.execute("insert into " + tbl + "(txt,rate) values('two',LAST_INSERT_ID())"),
        db.queryInt("select max(rate) from " + tbl),
        db.execute("DROP TABLE " + tbl)
    ], function (err, results) {
        //console.log(JSON.stringify(results));
        if (err) throw err;
        if (!results) throw new Error("No results");
        if (!results.length) throw new Error("Empty results");
        if (results[3] != 1) throw new Error("LAST_INSERT_ID() didn't seem to return right value... " + results[3]);
        process.nextTick(callback);
    });
}

function manyInsertsWithQueryList(callback) {
    var tbl = generateRandomName();
    var N = 10;
    dbfn(dbconfig, [
        db.execute("CREATE TABLE " + tbl + "(id MEDIUMINT NOT NULL AUTO_INCREMENT, txt VARCHAR(256) NOT NULL, rate FLOAT, PRIMARY KEY(id))"),

        // insert N rows
        db.execute("insert into " + tbl + "(txt,rate) values(:txt, :rate)", Array.from(Array(N).keys()).map(function (i) {
            return { txt: "text " + i, rate: 10 * i };
        })),
        db.query("select * from " + tbl),
        db.execute("drop table " + tbl)
    ], function (err, results) {
        //console.log(JSON.stringify(results));
        if (err) throw err;
        if (!results) throw new Error("No results");
        if (!results.length) throw new Error("Empty results");
        if (results[1] != N) throw new Error("Didn't insert N rows");
        if (results[2].length != N) throw new Error("Didn't get back 10 rows");
        if (results[2][4].txt != "text " + 4) throw new Error("Got back wrong text");
        process.nextTick(callback);
    });
}

function invalidPoolConfig(callback) {
    var cfg = JSON.parse(JSON.stringify(dbconfig));
    cfg.user += "" + generateRandomName();
    dbfn({}, db.execute("select 1+1"), (err, result) => {
        if (!err) throw new Error("Invalid pool config should have generated an error.");
        process.nextTick(callback);
    });
}

function invalidSql(callback) {
    var tbl = generateRandomName();
    dbfn(dbconfig, db.execute("select * from " + tbl), (err, result) => {
        if (!err) throw new Error("Invalid SQL should have generated an error.");
        process.nextTick(callback);
    });
}

function emptyResultSet(callback) {
    var tbl = generateRandomName();
    dbfn(dbconfig, [
        db.execute("CREATE TABLE " + tbl + "(id MEDIUMINT NOT NULL AUTO_INCREMENT, txt VARCHAR(256) NOT NULL, rate FLOAT, PRIMARY KEY(id))"),
        db.query("select * from " + tbl),
        db.execute("DROP TABLE " + tbl)
    ], (err, results) => {
        if (err) throw err;
        if (!results) throw new Error("No results");
        if (results[1].length) throw new Error("Should have had empty results");
        process.nextTick(callback);
    });
}
function castFloatFails(callback) {
    dbfn(
        dbconfig,
        db.queryFloat("select 'stringlike'", null, 42.5),
        function (err, results) {
            if (err) throw err;
            if (!results) throw new Error("No results");
            if (!results.length) throw new Error("Empty results");
            if (results[0] != 42.5) throw new Error("Incorrect result; " + results[0]);
            process.nextTick(callback);
        }
    );
}
function castIntegerFails(callback) {
    dbfn(
        dbconfig,
        db.queryFloat("select 42.5", null, 3),
        function (err, results) {
            if (err) throw err;
            if (!results) throw new Error("No results");
            if (!results.length) throw new Error("Empty results");
            if (results[0] != 3) throw new Error("Incorrect result; " + results[0]);
            process.nextTick(callback);
        }
    );
}

const N = 3;
function repetitiousSuccess(callback) {
    var cnt = N;
    callit();
    function callit() {
        if (cnt <= 0) return process.nextTick(callback);
        cnt--;
        simpleInsertsWithQueryScalar(callit);
    }
}
function repetitionsFails(callback) {
    var cnt = N;
    callit();
    function callit() {
        if (cnt <= 0) return process.nextTick(callback);
        cnt--;
        invalidSql(callit);
    }
}

function failWithRollback(callback) {
    console.log("fail with rollback");
    var tbl = generateRandomName();
    db.act(
        dbconfig,
        db.execute("create table " + tbl + "(id INTEGER)"),
        function (err) {
            if (err) throw new Error("Error on creating temporary table");

            // now insert some rows in a transaction and fail
            db.transact(dbconfig, [
                db.execute("insert into " + tbl + " values(:id)", [{ id: 1 }, { id: 2 }, { id: 3 }]),
                db.execute("this is garbage"),
            ], function (err, results) {
                if (!err) throw new Error("We should have gotten an error from executing garbage sql.");
                // ok, now verify that the rollback succeeded

                db.act(dbconfig, [
                    db.queryInt("select count(*) from " + tbl),
                    db.execute("drop table " + tbl)
                ], (err, results) => {
                    if (err) throw new Error("Got an error back when counting rows inserted");
                    if (!results) throw new Error("no results");
                    if (!results.length) throw new Error("empty results");
                    if (results[0] != 0) throw new Error("Rollback seems to have failed");
                    process.nextTick(callback);
                });
            });
        }
    )
}

function alldone() {
    db.curtains(() => {
        console.log("Ok");
    });
}