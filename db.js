const mysql2 = require('mysql2');


module.exports = {
    /**
     * Attaches to database with specified connection information, and immediately
     * returns a stage object that you can use to queue up SQL statements
     * with query() and execute().
     */
    stage: (connectionInfo) => { return new DbStage(connectionInfo); },

    /**
     * Gracefully closes all connections to all pools made through this
     * instance of the library. Pass an (optional) callback if you want to know
     * when it's all over.
     */
    curtains: (callback) => { return POOL_FUNCTIONS.doCurtains(callback ? callback : () => { }); }
};

function DbStage(cfg) {
    var ops = [];

    /**
     * Specifies a database action for which the result will indicate the number
     * of rows modified, rather than a resultset.
     * Pass in the SQL to execute and any parameters to bind when executing.
     */
    this.execute = (sql, params) => { ops.push(doAction('e', sql, params, null)); return this; };

    /**
     * Specifies a database query action, which returns an array of objects (one per row returned by your query).
     * Pass in the SQL to execute and any parameters to bind when executing.
     */
    this.query = (sql, params) => { ops.push(doAction('q', sql, params, null)); return this; };

    /**
     * Specifies a database query action that returns one integer.
     * Pass in the SQL to execute and any parameters to bind when executing.
     * You can also pass in a default value that will be returned 
     * if the result set is empty, or if the first value returned 
     * isn't an integer.
     */
    this.queryInt = (sql, params, dflt) => { ops.push(doAction('qi', sql, params, dflt)); return this; };

    /**
     * Specifies a database query action that returns one floating point number.
     * Pass in the SQL to execute and any parameters to bind when executing.
     * You can also pass in a default value that will be returned 
     * if the result set is empty, or if the first value returned 
     * isn't a number.
     */
    this.queryFloat = (sql, params, dflt) => { ops.push(doAction('qf', sql, params, dflt)); return this; };

    /**
     * Specifies a database query action that returns one string.
     * Pass in the SQL to execute and any parameters to bind when executing.
     * You can also pass in a default value that will be returned 
     * if the result set is empty, or if the first value returned 
     * is null.
     */
    this.queryString = (sql, params, dflt) => { ops.push(doAction('qs', sql, params, dflt)); return this; };

    /**
     * Acts out queued SQL statements.
     * Call this after you queue up statements with execute() and query() methods.
     * If you queue up multiple statements, you'll get back an array of results.
     * If you queue up a single statement, you'll get back a single result.
     * If you pass autocommit=true, then no transaction will be used.
     * If you pass autocommit=false, then a transaction will be started
     * and committed on success, or rolled back (as much as possible)
     * on failure.
     */
    this.finale = (callback, autocommit) => { doFinale(cfg, !autocommit, ops, callback); };
}



function doAction(opcode, sql, params, dflt) {
    params = JSON.parse(JSON.stringify(params ? params : null));
    if (!opcode) throw new Error("Internal error: missing opcode");
    if (!sql) throw new Error("The SQL provided is blank or missing.");
    if (typeof (sql) != "string") throw new Error("The SQL provided is not a string.");

    var op = parseSql();
    op.opcode = opcode;
    op.dflt = dflt;
    op.paramVals = params;
    op.paramShape = computeParamShape();
    op.isMulti = (op.paramShape == "array.array" || op.paramShape == "array.object");

    if (op.bindStyles[':'] && op.bindStyles['?'])
        throw new Error("The SQL statement \"" + sql + "\" uses ? placeholders and : named placeholders. Pick one. It won't work to use both in the same SQL statement.");
    if (op.bindStyles['?'] && op.paramShape != "array" && op.paramShape != "array.array")
        throw new Error("The SQL statement \"" + sql + "\" uses ? placeholders, but params is " + op.paramShape + " instead of a single array, or an array of arrays. " + (op.paramShape == "scalar" ? "You probably mean to wrap your param with [] to form an array?" : ""));
    if (op.bindStyles[':'] && op.paramShape != "object" && op.paramShape != "array.object")
        throw new Error("The SQL statement \"" + sql + "\" uses : placeholders, but params is " + op.paramShape + " instead of a single object, or an array of objects.");

    if (params !== null && params !== undefined) {
        if (Array.isArray(params))
            params.forEach((param) => {
                if (param === null || param === undefined)
                    throw new Error("You have at least one null value in your parameters. That's not going to go well for you.");
                if (Array.isArray(param))
                    param.forEach((p) => {
                        if (p === null || p === undefined)
                            throw new Error("You have at least one null value in your parameters. That's not going to go well for you.");
                    });
                else if (typeof param == "object")
                    for (var nm in param)
                        if (param.hasOwnProperty(nm)) {
                            var p = param[nm];
                            if (p === null || p === undefined)
                                throw new Error("You have at least one null value in your parameters. That's not going to go well for you.");
                        }
            });
        else if (typeof params == "object")
            for (var nm in params)
                if (params.hasOwnProperty(nm)) {
                    var p = params[nm];
                    if (p === null || p === undefined)
                        throw new Error("You have at least one null value in your parameters. That's not going to go well for you.");
                }
    }
    return op;

    function parseSql() {
        const re = /(:[a-zA-Z0-9_]+)|(\?)|(\$[0-9]+)/g;

        var matches = sql.match(re);

        var matchRefs = [];
        var matchTypes = [];
        var bindStyles = {};

        if (!matches) matches = [];
        else for (var i = 0; i < matches.length; i++) {
            var match = matches[i];
            var mtype = match.charAt(0);
            var mref;

            bindStyles[mtype] = true;
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
            sql: sql.replace(re, "?"),
            paramRefs: matchRefs,
            paramTypes: matchTypes,
            bindStyles: bindStyles
        };
    }
    function computeParamShape() {
        var rv = "";
        if (params === null || params === undefined) return false;
        rv += Array.isArray(params) ? "array" : (typeof params == "object" ? "object" : "scalar");
        if (rv != "array") return rv;
        if (params.length == 0) return rv;
        if (params[0] == null) return rv;
        rv += Array.isArray(params[0]) ? ".array" : (typeof params[0] == "object" ? ".object" : "");
        return rv;
    }
}

var POOL_FUNCTIONS = {
    _pools: {},
    _closing: false,
    getPool: function (dbcfg, callback) {
        try {
            if (!dbcfg) throw new Error("Null database configuration info; be sure to provide username, password, etc.");

            var key = ((typeof dbcfg) == "string") ? dbcfg : JSON.stringify(dbcfg);
            var pool = POOL_FUNCTIONS._pools[key];
            if (!pool) {
                pool = mysql2.createPool(dbcfg);
                POOL_FUNCTIONS._pools[key] = pool;
            }
            process.nextTick(callback, null, pool);
        } catch (err) {
            process.nextTick(callback, err, null);
        }
    },
    isClosing: function () { return POOL_FUNCTIONS._closing; },
    doCurtains: function (callback) {
        POOL_FUNCTIONS._closing = true;
        var poolsToClose = [];
        for (var p in POOL_FUNCTIONS._pools)
            if (POOL_FUNCTIONS._pools.hasOwnProperty(p))
                poolsToClose.push(POOL_FUNCTIONS._pools[p]);

        closeNextPool();
        function closeNextPool() {
            if (!poolsToClose.length) return callback();

            var pool = poolsToClose.pop();
            pool.end(closeNextPool);
        }
    },
    getConnection: function (pool, callback) {
        try {
            if (!pool) throw new Error("Null database connection pool returned by driver");
            pool.getConnection((err, conn) => {
                process.nextTick(callback, err, conn);
            });
        } catch (err) {
            process.nextTick(callback, err, null);
        }
    },
    releaseConnection: function (conn, callback) {
        try {
            conn.release();
            process.nextTick(callback, null);
        } catch (err) {
            process.nextTick(callback, err);
        }
    }
};


function doFinale(dbcfg, bTransact, ops, cb) {
    if (POOL_FUNCTIONS.isClosing()) return cb(new Error("Databases are closing down."));
    if (!dbcfg) return cb(new Error("Internal error: config not passed through"));
    if (!ops) return cb(new Error("Internal error: ops not passed through"));
    if (!cb || typeof cb != "function")  return cb(new Error("Oops, you forgot to provide a function to call back after the finale."));
    if (ops.finaleComplete)  return cb(new Error("You already had your finale on this stage. Go get a new stage."));
    ops.finaleComplete = true;

    var singularOperation = (ops.length == 1);

    var results = [];
    var transactionHasStarted = false;

    // 'twould be nice to use async library, but don't want to add another dependency
    // gonna generally use process.nextTick(callback) to avoid polluting the call stack of client
    POOL_FUNCTIONS.getPool(dbcfg, (err, pool) => {
        if (err) return finalize(null, err);
        POOL_FUNCTIONS.getConnection(pool, (err, conn) => {
            if (err) return finalize(conn, err);

            var setCommitOp = doAction('e', "SET autocommit=" + (bTransact ? 0 : 1));
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

    function finalize(conn, err) {
        var rv = singularOperation ? results[0] : results;
        if (conn) {
            if (transactionHasStarted) {
                conn.rollback(() => {
                    POOL_FUNCTIONS.releaseConnection(conn, () => {
                        return process.nextTick(cb, err, rv);
                    });
                });
            } else {
                POOL_FUNCTIONS.releaseConnection(conn, () => {
                    return process.nextTick(cb, err, rv);
                });
            }
        } else
            return process.nextTick(cb, err, rv);
    }

    function makeArgs(paramRefs, paramTypes, explicitParams, paramsFromPriorResults) {
        var rv = [];
        if (paramRefs == null) paramRefs = [];
        if (paramTypes == null) paramTypes = [];
        if (paramRefs.length != paramTypes.length) throw new Error("paramRefs.length != paramTypes.length: " + paramRefs.length + " vs " + paramTypes.length);
        if (explicitParams == null) explicitParams = [];

        //console.log(JSON.stringify(paramRefs) + ";" + JSON.stringify(paramTypes) + ";" + JSON.stringify(explicitParams) + ";" + JSON.stringify(paramsFromPriorResults));
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

    function doExecute(conn, dbcfg, op, resultsSoFar, callback) {
        try {
            var paramVals = op.paramVals;
            if (!op.isMulti)
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
            var singularExecution = !op.isMulti;
            if (singularExecution) paramVals = [paramVals];
            var resultsFromThisOp = [];
            var i = 0;

            doNextExec();
            function doNextExec() {
                if (i >= paramVals.length) {
                    // all done, return result; unbundle from array if user passed in singular params
                    //console.log("out:" + JSON.stringify(resultsFromThisOp) + ";" + singularExecution + "..." + JSON.stringify(singularExecution ? resultsFromThisOp[0] : resultsFromThisOp))
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
                        if ((typeof vl) != "number" || !Number.isInteger(vl)) {
                            vl = parseFloat("" + vl);
                            if (Number.isNaN(vl) || !Number.isInteger(vl))
                                return dflt;
                        }
                        break;
                    case 'qf':
                        if ((typeof vl) != "number" || Number.isNaN(vl)) {
                            vl = parseFloat("" + vl);
                            if (Number.isNaN(vl))
                                return dflt;
                        }
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
}
