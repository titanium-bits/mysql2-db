const async = require('async');
const dbconfig = require('../dbconfig.json');
const db = require('./db');

// many of our tests will need to create temporary tables, so here's a function to make sorta-random table names
var tblcnt = 0;
function generateRandomName() {
    return "TMP" + Math.floor(Math.random() * 10000) + "_" + tblcnt;
}

// we will execute most tests once with transactions and once without
var autocommit = false;

// here's our list of tests. each throws an Error on failure.
var simpleTests = [
    canonicalExample,
    tablelessQuery, differentParamTypes, simpleInsertsWithQueryScalar, insertWithLastInsertId, manyInsertsWithQueryList,
    oneQueryOneResult,
    invalidPoolConfig, invalidSql, emptyResultSet, castFloatFails, castIntegerFails,
    repetitionsFails, repetitiousSuccess
];

// We can reuse each simple test, running it first in an autocommit mode, then in a non-autocommit mode.
// wrap each of the tests with a function that echoes the function name, then calls the function in autocommit and transactional mode
var compositeTests = simpleTests.map((fn) => {
    return (cb) => {
        autocommit = false;
        console.log(fn.name + " with transaction");
        fn(() => {
            autocommit = true;
            console.log(fn.name + " with autocommit");
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
    var stage = db.stage(dbconfig);
    stage.execute("create table " + tbl + "(col1 mediumint, col2 varchar(50), col3 varchar(50))");
    stage.execute("insert into " + tbl + "(col1, col2, col3) values (?,?,?)", [0, 'hello', 'world']); // insert row, old-fashioned prepare
    stage.execute("insert into " + tbl + "(col1, col2, col3) values (:id, :x, :y)", { id: 1, x: 'Also', y: 'ok' }); // insert row, using named parameters
    stage.queryInt("select count(*) from " + tbl + ""); // queryInt retrieves just a single integer; you can also pass a default value, see queryInt docs
    stage.execute("insert into " + tbl + "(col1, col2, col3) values ($3, :t, :y)", { t: 'Inter-statement', y: 'reference!' }); // $3 refers to result of statement 3, i.e., the queryInt
    stage.queryString("select col2 from " + tbl + " where col1 = 2"); // so this should return the value that we inserted, just above
    stage.execute("insert into " + tbl + "(col1, col2, col3) values (?,?,?)", [[3, 'three', 'yeah'], [4, 'four', 'no'], [5, 'five', 'maybe']]); // can insert several items (binding params as above)
    stage.execute("update " + tbl + " set col3 = col2 where col1 > :minval", { minval: 2 }); // should affect rows with col1=3, 4, and 5
    stage.query("select * from " + tbl + " where col1 < :maxval order by col1 desc", { maxval: 2 }); // dump an array of objects for col1=0 and col1=1
    stage.execute("drop table " + tbl + "")
    stage.finale((error, results) => {
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
    }, autocommit);
}

function tablelessQuery(callback) {
    db.stage(dbconfig).queryInt("select 1+1").finale(
        function (err, results) {
            if (err) throw err;
            if (!results) throw new Error("No results");
            if (results != 2) throw new Error("Incorrect result; 1+1=" + results[0]);
            process.nextTick(callback);
        }, autocommit
    );
}

function differentParamTypes(callback) {
    var tbl = generateRandomName();
    var stage = db.stage(dbconfig);
    stage.execute("create table " + tbl + "(ival MEDIUMINT, fval FLOAT, sval VARCHAR(256), nval VARCHAR(25))");
    stage.execute("insert into " + tbl + "(ival, fval, sval) values (?, ?, ?)", [3, 0.25, 'happy']);
    stage.queryInt("select ival from " + tbl);
    stage.queryFloat("select fval from " + tbl);
    stage.queryString("select sval from " + tbl);
    stage.queryString("select nval from " + tbl);
    stage.execute("DROP TABLE " + tbl);
    stage.finale((err, results) => {
        if (err) throw err;
        if (!results) throw new Error("No results");
        if (!results.length) throw new Error("Empty results");
        if (results[1] != 1) throw new Error("One row should have been inserted");
        if (results[2] != 3) throw new Error("Integer should have come back as 3");
        if (results[3] != 0.25) throw new Error("Float should have come back as 0.25");
        if (results[4] != 'happy') throw new Error("String should have come back as happy");
        if (results[5] !== undefined) throw new Error("Unset nullable value should have come back as undefined: " + results[5]);
        process.nextTick(callback);
    }, autocommit);
}

function simpleInsertsWithQueryScalar(callback) {
    var tbl = generateRandomName();
    var stage = db.stage(dbconfig)
        .execute("CREATE TABLE " + tbl + "(id MEDIUMINT NOT NULL AUTO_INCREMENT, txt VARCHAR(256) NOT NULL, rate FLOAT, PRIMARY KEY(id))")
        .execute("insert into " + tbl + "(txt,rate) values(:txt,:rate)", { txt: "one", rate: 3.14 })
        .queryInt("select count(*) from " + tbl)
        .execute("insert into " + tbl + "(txt,rate) values(:txt, :rate)", [{ txt: "two", rate: 2 }, { txt: "three", rate: 3 }, { txt: "four", rate: 4 }])
        .queryFloat("select max(rate) from " + tbl + " where id <> rate")
        .execute("DROP TABLE " + tbl)
        .finale(function (err, results) {
            //console.log(JSON.stringify(results));
            if (err) throw err;
            if (!results) throw new Error("No results");
            if (!results.length) throw new Error("Empty results");
            if (results.length != 6) throw new Error("Incorrect number of results returned: " + results.length);
            if (results[2] != 1) throw new Error("Select count(*) returned incorrect result");
            if (results[3] != 3) throw new Error("Failed to bulk-insert three rows into the database");
            if (Math.abs(results[4] - 3.14) > 0.01) throw new Error("Select max returned " + results[4] + " instead of expected value");
            process.nextTick(callback);
        }, autocommit);
}

function insertWithLastInsertId(callback) {
    var tbl = generateRandomName();
    var stage = db.stage(dbconfig)
        .execute("CREATE TABLE " + tbl + "(id MEDIUMINT NOT NULL AUTO_INCREMENT, txt VARCHAR(256) NOT NULL, rate FLOAT, PRIMARY KEY(id))")
        .execute("insert into " + tbl + "(txt) values('one')")
        .execute("insert into " + tbl + "(txt,rate) values('two',LAST_INSERT_ID())")
        .queryInt("select max(rate) from " + tbl)
        .execute("DROP TABLE " + tbl)
        .finale(function (err, results) {
            //console.log(JSON.stringify(results));
            if (err) throw err;
            if (!results) throw new Error("No results");
            if (!results.length) throw new Error("Empty results");
            if (results[3] != 1) throw new Error("LAST_INSERT_ID() didn't seem to return right value... " + results[3]);
            process.nextTick(callback);
        }, autocommit);
}

function manyInsertsWithQueryList(callback) {
    var tbl = generateRandomName();
    var N = 10;
    var stage = db.stage(dbconfig);

    stage.execute("CREATE TABLE " + tbl + "(id MEDIUMINT NOT NULL AUTO_INCREMENT, txt VARCHAR(256) NOT NULL, rate FLOAT, PRIMARY KEY(id))");

    // insert N rows
    stage.execute("insert into " + tbl + "(txt,rate) values(:txt, :rate)", Array.from(Array(N).keys()).map(function (i) {
        return { txt: "text " + i, rate: 10 * i };
    }));
    stage.query("select * from " + tbl);
    stage.execute("drop table " + tbl);
    stage.finale(function (err, results) {
        //console.log(JSON.stringify(results));
        if (err) throw err;
        if (!results) throw new Error("No results");
        if (!results.length) throw new Error("Empty results");
        if (results[1] != N) throw new Error("Didn't insert N rows");
        if (results[2].length != N) throw new Error("Didn't get back 10 rows");
        if (results[2][4].txt != "text " + 4) throw new Error("Got back wrong text");
        process.nextTick(callback);
    }, autocommit);
}

function oneQueryOneResult(callback) {
    db.stage(dbconfig).query("select 1+1 as ttl").finale((err, results) => {
        console.log(JSON.stringify(results));
        if (err) throw err;
        if (!results) throw new Error("NO results");
        if (results.length != 1) throw new Error("Should have gotten back one result");
        if (results[0].ttl != 2) throw new Error("Didn't get back 1+1=2");
        process.nextTick(callback);
    }, autocommit);
}

function invalidPoolConfig(callback) {
    var cfg = JSON.parse(JSON.stringify(dbconfig));
    cfg.user += "" + generateRandomName();
    db.stage(cfg).execute("select 1+1").finale((err, result) => {
        if (!err) throw new Error("Invalid pool config should have generated an error.");
        process.nextTick(callback);
    }, autocommit);
}

function invalidSql(callback) {
    var tbl = generateRandomName();
    db.stage(dbconfig).execute("select * from " + tbl).finale((err, result) => {
        if (!err) throw new Error("Invalid SQL should have generated an error.");
        process.nextTick(callback);
    }, autocommit);
}

function emptyResultSet(callback) {
    var tbl = generateRandomName();
    var stage = db.stage(dbconfig);

    stage.execute("CREATE TABLE " + tbl + "(id MEDIUMINT NOT NULL AUTO_INCREMENT, txt VARCHAR(256) NOT NULL, rate FLOAT, PRIMARY KEY(id))");
    stage.query("select * from " + tbl);
    stage.execute("DROP TABLE " + tbl);
    stage.finale((err, results) => {
        if (err) throw err;
        if (!results) throw new Error("No results");
        if (results[1].length) throw new Error("Should have had empty results");
        process.nextTick(callback);
    }, autocommit);
}
function castFloatFails(callback) {
    var stage = db.stage(dbconfig);
    stage.queryFloat("select 'stringlike'", null, 42.5);
    stage.finale((err, results) => {
        if (err) throw err;
        if (!results) throw new Error("No results");
        if (results != 42.5) throw new Error("Incorrect result; " + results[0]);
        process.nextTick(callback);
    }, autocommit);
}
function castIntegerFails(callback) {
    var stage = db.stage(dbconfig);
    stage.queryInt("select 42.5", null, 3);
    stage.finale((err, results) => {
        if (err) throw err;
        if (!results) throw new Error("No results");
        if (results != 3) throw new Error("Incorrect result; " + results);
        process.nextTick(callback);
    }, autocommit);
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
    db.stage(dbconfig).execute("create table " + tbl + "(id INTEGER)").finale(
        function (err) {
            if (err) throw new Error("Error on creating temporary table");

            // now insert some rows in a transaction and fail
            db.stage(dbconfig)
                .execute("insert into " + tbl + " values(:id)", [{ id: 1 }, { id: 2 }, { id: 3 }])
                .execute("this is garbage")
                .finale((err, results) => {
                    if (!err) throw new Error("We should have gotten an error from executing garbage sql.");
                    // ok, now verify that the rollback succeeded

                    db.stage(dbconfig).queryInt("select count(*) from " + tbl)
                        .execute("drop table " + tbl)
                        .finale((err, results) => {
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
