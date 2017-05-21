const mysql2 = require('mysql2');

var _pools = {};
var _closing = false;

module.exports = {
    /**
     * Acts out one or more database actions (non-transactional, auto-commit mode).
     * Pass in your connection configuration, one action or an an array of actions
     * (each generated with execute() or a query() method below),
     * and a callback like fn(error, results) { check error, do something with results }.
     * If you pass an array of actions, you'll get back an array of results.
     * If you pass a single action, you'll get back a single result.
     */
    act: (connectionInfo, operations, callback) => { return doAct(connectionInfo, false, operations, callback ? callback : (e, r) => { }) },

    /**
     * Performs one or more database actions in a transaction, with commit on success and rollback on error.
     * Pass in your connection configuration, an array of operations
     * (each generated with execute() or a query() method below),
     * and a callback like fn(error, results) { check error, do something with results }.
     */
    transact: (connectionInfo, operations, callback) => { return doAct(connectionInfo, true, operations, callback) },

    /**
     * Specifies a database action that will not return any result.
     * Pass in the SQL to execute and any parameters to bind when executing.
     */
    execute: (sql, params) => { return createOp('e', sql, params, null); },

    /**
     * Specifies a database query action, which returns an array of objects (one per row returned by your query).
     * Pass in the SQL to execute and any parameters to bind when executing.
     */
    query: (sql, params) => { return createOp('q', sql, params, null); },

    /**
     * Specifies a database query action that returns one integer.
     * Pass in the SQL to execute and any parameters to bind when executing.
     * You can also pass in a default value that will be returned 
     * if the result set is empty, or if the first value returned 
     * isn't an integer.
     */
    queryInt: (sql, params, dflt) => { return createOp('qi', sql, params, dflt); },

    /**
     * Specifies a database query action that returns one floating point number.
     * Pass in the SQL to execute and any parameters to bind when executing.
     * You can also pass in a default value that will be returned 
     * if the result set is empty, or if the first value returned 
     * isn't a number.
     */
    queryFloat: (sql, params, dflt) => { return createOp('qf', sql, params, dflt); },

    /**
     * Specifies a database query action that returns one string.
     * Pass in the SQL to execute and any parameters to bind when executing.
     * You can also pass in a default value that will be returned 
     * if the result set is empty, or if the first value returned 
     * is null.
     */
    queryString: (sql, params, dflt) => { return createOp('qs', sql, params, dflt); },

    /**
     * Gracefully closes all connections to all pools made through this
     * instance of the library. Pass a callback if you want to know
     * when it's all over.
     */
    curtains: (callback) => { return doCurtains(callback ? callback : () => { }); }
};

function createOp(opcode, sql, params, dflt) {
    var parse = parseSql(sql);
    return {
        opcode: opcode,
        dflt: dflt,
        sql: parse.cleanSql,
        paramTypes: parse.paramTypes,
        paramRefs: parse.paramRefs,
        paramVals: params
    };
}

function doAct(dbcfg, bTransact, ops, cb) {
    if (_closing) return cb(new Error("Databases are closing down."));
    if (!dbcfg || !ops || !cb)
        throw new Error("Usage: you need to supply a db configuration, a list of actions, and a callback(err,results).");

    var singularOperation = !Array.isArray(ops);
    if (singularOperation) ops = [ops];

    var results = [];
    var transactionHasStarted = false;

    // 'twould be nice to use async library, but don't want to add another dependency
    // gonna generally use process.nextTick(callback) to avoid polluting the call stack of client
    getPool(dbcfg, (err, pool) => {
        if (err) return finalize(null, err);
        getConnection(pool, (err, conn) => {
            if (err) return finalize(conn, err);

            var setCommitOp = createOp('e', "SET autocommit=" + (bTransact ? 0 : 1));
            doExecute(conn, dbcfg, setCommitOp, [], (err) => {
                if (err) return finalize(conn, err);

                if (bTransact) {
                    conn.beginTransaction((err) => {
                        if (err) return finalize(conn, err);
                        transactionHasStarted = true;
                        fillInResults(conn, dbcfg, ops, results, (err) => {
                            if (err) return finalize(conn, err);
                            conn.commit((err) => {
                                return finalize(conn, err);
                            });
                        });
                    });
                } else {
                    fillInResults(conn, dbcfg, ops, results, (err) => {
                        return finalize(conn, err);
                    });
                }

            });
        });
    });

    function finalize(conn, err) {
        var rv = singularOperation ? results[0] : results;
        if (conn) {
            if (transactionHasStarted) {
                conn.rollback(() => {
                    releaseConnection(conn, () => {
                        return process.nextTick(cb, err, rv);
                    });
                });
            } else {
                releaseConnection(conn, () => {
                    return process.nextTick(cb, err, rv);
                });
            }
        } else
            return process.nextTick(cb, err, rv);
    }
}

function getPool(dbcfg, callback) {
    try {
        if (!dbcfg) throw new Error("Null database configuration info; be sure to provide username, password, etc.");

        var key = ((typeof dbcfg) == "string") ? dbcfg : JSON.stringify(dbcfg);
        var pool = _pools[key];
        if (!pool) {
            pool = mysql2.createPool(dbcfg);
            _pools[key] = pool;
        }
        process.nextTick(callback, null, pool);
    } catch (err) {
        process.nextTick(callback, err, null);
    }
}

function doCurtains(callback) {
    _closing = true;
    var poolsToClose = [];
    for (var p in _pools)
        if (_pools.hasOwnProperty(p))
            poolsToClose.push(_pools[p]);

    closeNextPool();
    function closeNextPool() {
        if (!poolsToClose.length) return callback();

        var pool = poolsToClose.pop();
        pool.end(closeNextPool);
    }
}

function getConnection(pool, callback) {
    try {
        if (!pool) throw new Error("Null database connection pool returned by driver");
        pool.getConnection((err, conn) => {
            process.nextTick(callback, err, conn);
        });
    } catch (err) {
        process.nextTick(callback, err, null);
    }
}

function fillInResults(conn, dbcfg, ops, results, callback) {
    if (ops.length == results.length) // done!
        return process.nextTick(callback, null);

    try { // else, do next
        var nextOp = ops[results.length];
        var fn = (nextOp.opcode == 'e' ? doExecute : doQuery);
        fn(conn, dbcfg, nextOp, results, (err, result) => {
            if (err)
                return process.nextTick(callback, err);
            else {
                results.push(result);
                process.nextTick(fillInResults, conn, dbcfg, ops, results, callback);
            }
        });
    } catch (e) {
        return process.nextTick(callback, e);
    }
}

function releaseConnection(conn, callback) {
    try {
        conn.release();
        process.nextTick(callback, null);
    } catch (err) {
        process.nextTick(callback, err);
    }
}

function parseSql(sql) {
    const re = /(:[a-zA-Z0-9_]+)|(\?)|(\$[0-9]+)/g;

    var matches = sql.match(re);

    var matchRefs = [];
    var matchTypes = [];

    if (!matches) matches = [];
    else for (var i = 0; i < matches.length; i++) {
        var match = matches[i];
        var mtype = match.charAt(0);
        var mref;

        switch (mtype) {
            case ':': mref = match.substring(1); break;
            case '$': mref = parseInt(match.substring(1), 10); break;
            case '?': mref = i; break;
            default: throw new Error("parse error");
        }

        matchRefs.push(mref);
        matchTypes.push(mtype);
    }
    return {
        rawSql: sql,
        cleanSql: sql.replace(re, "?"),
        paramRefs: matchRefs,
        paramTypes: matchTypes
    };
}

function makeArgs(paramRefs, paramTypes, explicitParams, paramsFromPriorResults) {
    var rv = [];
    if (paramRefs == null) paramRefs = [];
    if (paramTypes == null) paramTypes = [];
    if (paramRefs.length != paramTypes.length) throw new Error("paramRefs.length != paramTypes.length: " + paramRefs.length + " vs " + paramTypes.length);

    for (var i = 0; i < paramRefs.length; i++) {
        var paramRef = paramRefs[i];
        var paramType = paramTypes[i];
        var paramVal;

        switch (paramType) {
            case ':': paramVal = explicitParams[paramRef]; break;
            case '$': paramVal = paramsFromPriorResults[paramRef]; break;
            case '?': paramVal = explicitParams[paramRef]; break;
            default: throw new Error("Internal error: unrecognized param type");
        }

        rv.push(paramVal);
    }
    return rv;
}
function isArrayOfObjectsOrArrayOfArrays(params) {
    if (params == null) return false;
    if (!Array.isArray(params)) return false;
    if (params.length == 0) return false;
    if (params[0] == null) return false;
    if (Array.isArray(params[0])) return true;
    if ((typeof params[0]) == "object") return true;
    return false;
}
function doExecute(conn, dbcfg, op, resultsSoFar, callback) {
    try {
        var paramVals = op.paramVals;
        if (!isArrayOfObjectsOrArrayOfArrays(paramVals))
            paramVals = [paramVals];

        var totalNumberOfRowsAffected = 0;
        var i = 0;

        doNextExec();
        function doNextExec() {
            if (i >= paramVals.length) {
                // all done, return result
                return process.nextTick(callback, null, totalNumberOfRowsAffected);
            } else {
                var sql = op.sql;
                var args = makeArgs(op.paramRefs, op.paramTypes, paramVals[i], resultsSoFar);
                if (dbcfg.echo)
                    console.log("executing \"" + sql + "\" with " + JSON.stringify(args));
                conn.execute(sql, args, (err, resultsFromThisExec) => {
                    if (err) return process.nextTick(callback, err, null);
                    var nrowsAffected = (resultsFromThisExec && resultsFromThisExec.affectedRows ? resultsFromThisExec.affectedRows : 0);
                    totalNumberOfRowsAffected += nrowsAffected;
                    i++;
                    return process.nextTick(doNextExec);
                });
            }
        }
    } catch (e) {
        return process.nextTick(callback, e);
    }
}

function doQuery(conn, dbcfg, op, resultsSoFar, callback) {
    try {
        var paramVals = op.paramVals;
        var singularExecution = !isArrayOfObjectsOrArrayOfArrays(paramVals);
        if (singularExecution) paramVals = [paramVals];
        var resultsFromThisOp = [];
        var i = 0;

        doNextExec();
        function doNextExec() {
            if (i >= paramVals.length) {
                // all done, return result; unbundle from array if user passed in singular params
                return process.nextTick(callback, null,
                    singularExecution ? resultsFromThisOp[0] : resultsFromThisOp
                );
            } else {
                var sql = op.sql;
                var args = makeArgs(op.paramRefs, op.paramTypes, paramVals[i], resultsSoFar);
                if (dbcfg.echo)
                    console.log("querying \"" + sql + "\" with " + JSON.stringify(args));
                conn.execute(sql, args, (err, resultsFromThisExec) => {
                    if (err) return process.nextTick(callback, err, null);
                    resultsFromThisOp.push(formatResult(op, resultsFromThisExec));
                    i++;
                    return process.nextTick(doNextExec);
                });
            }
        }
    } catch (e) {
        process.nextTick(callback, e);
    }
}

function formatResult(op, resultSet) {
    if (op.opcode == 'q') { // dump all results
        var rv = [];
        resultSet.forEach(function (row) {
            var rvRow = {};
            for (var p in row) {
                if (row.hasOwnProperty(p))
                    rvRow[p] = row[p];
            }
            rv.push(rvRow);
        });
        return rv;
    } else {
        var dflt = op.dflt;
        if (!resultSet) return dflt;
        if (!resultSet.length) return dflt;
        var resultRow = resultSet[0];
        if (!resultRow) return dflt;
        for (var p in resultRow) {
            var vl = resultRow[p];
            if (vl === null || vl === undefined) return dflt;
            switch (op.opcode) {
                case 'qi':
                    if ((typeof vl) != "number" || !Number.isInteger(vl))
                        return dflt;
                    break;
                case 'qf':
                    if ((typeof vl) != "number" || Number.isNaN(vl))
                        return dflt;
                    break;
                case 'qs':
                    if ((typeof vl) != "string")
                        vl = vl + "";
                    break;
            }
            return vl;
        }
    }
    return dflt;
}
