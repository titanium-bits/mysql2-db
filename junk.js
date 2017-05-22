var db = require('./db');
var cfg = require('../dbconfig.json');

var stage = db.stage(cfg);
stage.queryInt("select ?", [12])
    .finale((err, results) => {
        console.log(err + ";" + JSON.stringify(results));
        db.curtains();
});