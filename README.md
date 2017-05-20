# mysql2-db





	var cfg = {user:"myusernm", password:"mypasswd", host:"localhost", database:"mydb"};
	var db = require('db');
	db.act(
	    cfg,
	    [
	        db.execute("create table if not exists test(col1 mediumint, col2 varchar(50), col3 varchar(50))"),
	        db.execute("insert into test(col1, col2, col3) values (?,?,?)", [0, 'hello', 'world']), // insert row, old-fashioned prepare
	        db.execute("insert into test(col1, col2, col3) values (:id, :x, :y)", { id: 1, x: 'Also', y: 'ok' }), // insert row, using named parameters
	        db.queryInt("select count(*) from test"), // queryInt retrieves just a single integer; you can also pass a default value, see queryInt docs
	        db.execute("insert into test(col1, col2, col3) values ($3, :t, :y)", { t: 'Inter-statement', y: 'reference!' }), // $3 refers to result of statement 3, i.e., the queryInt
	        db.queryString("select col2 from test where col1 = 2"), // so this should return the value that we inserted, just above
	        db.execute("insert into test(col1, col2, col3) values (?,?,?)", [[3, 'three', 'yeah'], [4, 'four', 'no'], [5, 'five', 'maybe']]), // can insert several items (binding params as above)
	        db.execute("update test set col3 = col2 where col1 > :minval", { minval: 2 }), // should affect rows with col1=3, 4, and 5
	        db.query("select * from test where col1 < :maxval order by col1 desc", { maxval: 2 }), // dump an array of objects for col1=0 and col1=1
	        db.execute("drop table test")
	    ], (error, results) => {
	        console.log("Statements have all hopefully now been executed, without any error.");
	
	        if (error != null) throw new Error("An error was thrown: " + error.message);
	        if (results == null) throw new Error("No results were returned");
	
	        console.log("Here are the results that we got back... " + JSON.stringify(results));
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
	
	        console.log("Everything went fine");
	        // finally, tell the database to take a bow and shut down for the night
	        db.curtains(() => { process.exit(0); });
	    }
	);
	
	
	
