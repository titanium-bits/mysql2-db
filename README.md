# mysql2-db

[mysql2](https://www.npmjs.com/package/mysql2) is a great library for doing prepared statements. But sometimes I find myself writing a lot of error-handling code, especially when trying to do a series of queries, and/or when I have to worry about transactions and rollbacks.

So this little utility library (still in *alpha*) helps simplify the code required as a client of mysql2 for running a series of SQL statements. It supports the old-fashioned syntax for prepared statements, with single question marks serving as placeholders. It also supports named parameters, with colons. And, because it supports executing a *series* of queries, it also allows you to make references *between* statements.

The notion is that you stage one or more SQL statements, then execute the batch. On success, the whole lot get committed. On failure, a rollback is attempted. (Or you can use auto-commit if you're so inclined.)

Note that the API changed since alpha version 0.0.2 because I found I was making errors when calling the library. (Tell me what you think--see my email info at the bottom of this document.)

Let's take a look at a few examples. 

## Connecting and inserting one row at a time

Let's suppose that you've got a mysql database called `mydb` that you can access via username `myusernm` and password `mypasswd` (real secure, nice /s). Inside the database is a table that you already created with...

	create table test(col1 mediumint, col2 varchar(50))

Let's insert a couple of rows.

	var db = require('mysql2-db');
	var cfg = {user:"myusernm", password:"mypasswd", host:"localhost", database:"mydb"};

	// create a staging area
	var stage = db.stage(cfg);

	// stage up some SQL statements
	stage.execute("insert into test(col1, col2) values (?,?)", [0, 'Hello, World!']);
	stage.execute("insert into test(col1, col2) values (:id, :txt)", { id: 1, txt: "This works fine" });
	
	// then run them and wait for the call back
	stage.finale(function (error, results) {
			// error should be null; there will be one result per statement above (i.e., 2)
		}
	);

Each call to the `db.execute()` method specifies a database action that will execute SQL. The first call, above, binds using ? placeholders. The second binds using named parameters. These actions are then executed by the `db.finale()` method call, which returns an error (which should be null) and a list of results. Even `execute` actions generate results (equal to the number of rows affected by each action).

##  Inserting a bunch of rows at a time

Let's now execute a single action that inserts a whole bunch of rows...

	// don't reuse stage objects. make 'em fresh...
	db.stage(cfg).execute("insert into test(col1, col2) values (?,?)", [ [2,'a'],[3,'b'],[4,'c'],[5,'d'] ])
	  .finale(
		(error, results) => {
			console.log("Error should be == null: "+error);
			console.log("And the results should be [4] because we inserted 4 rows: "+JSON.stringify(results));
		}
	  );

The first example, above, specified two actions that each inserted one row. This second example used one action to insert four rows. Either is fine. This second example could have used the : version of the parameter binding, but the ? version is a little more concise. Notice that `stage()` and `execute()`--as well as the `query()` methods, below--return a reference to the stage, so you can chain calls if you like. 

## Doing some queries

You can also use a few other methods that return results. Some of these are convenience methods for when you just want to get an single integer, float, or string from a query (i.e., `queryInt`, `queryFloat`, and `queryString`, respectively). Then there's the `query` method for when you want to retrieve a list of rows; this is returned as an array of objects, with one object per row.

Here are some examples...

	var stage = db.stage(cfg);
	stage.queryInt("select count(*) from test"); // the entry in results[] will contain a single int
	stage.queryFloat("select avg(col1) from test"); // which will put a single float into results[]
	stage.queryString("select col2 from test where col1=:vl", {vl:1}); // feel free to bind params as usual
	stage.queryString("select col2 from test where col1=?", [42], 'dfltval'); // default, in case of null
	stage.query("select * from test where col1 <> ?", [43]); // this entry in results[] will, itself, be an array (of objects)

	stage.finale((error, results) => {
			// results[0] should be an integer equalling the result of the first query
			// results[1] "      "  a  float   "         "   "      "  "   second query
			// results[2] "      "  a  string  "         "
			// etc.
		}
	);


## Inter-statement references

Sometimes it's handy to use the result of one scalar query in subsequent SQL statements. Use a $ symbol, instead of a :, when you want to reference the result of a prior query in the batch. For example, you can use `$0` to reference the result of the first statement, `$1` to reference the second, etc. 

	db.stage(cfg)
			.queryInt("select max(col1) from test")
			.execute("insert into test(col1, col2) values(1+$0, 'another string')")
			.execute("insert into test(col1, col2) values(2+$0, :vl)", {vl:"yet another"})
		.finale((error, results) => {
			// results[0] will contain the result from the first query
			// results[1] should equal 1 (because we inserted one row)
			// results[2] should equal 1 (because we inserted one row)
		}
	);


## Transactions

Sometimes you need to lock a table so that nobody else can mess with it in between your performance of several actions. (Homework: Do you see an example of that in the previous example?) In such a situation, you need a transaction. 

* The `db.finale()` method, by default, wraps operations in a transaction that rolls back on failure and commits on success. If any of the actions cause an error, the database will rollback as much as possible. 
* It also takes a final parameter (after the callback) where you can pass true if you want auto-commit mode: it will perform (and commit) as many actions as possible, and if it runs into an error, the preceding operations (that did succeed) will get saved to the database.

Usual caveat: [Some Mysql statements force an implicit commit](https://dev.mysql.com/doc/refman/5.5/en/implicit-commit.html). An example is `CREATE TABLE`. If an error occurs, any rollback won't go back any further than the latest implicit commit.

## A very long example

Ok, so now you should be able to understand the following example. If you don't, then please refer back to the examples above. If you still don't understand, please feel free to email me (though I have to say, I don't check that email very often).

	var cfg = {user:"myusernm", password:"mypasswd", host:"localhost", database:"mydb"};
	var stage = db.stage(cfg);
	stage.execute("create table if not exists test(col1 mediumint, col2 varchar(50), col3 varchar(50))");
	stage.execute("insert into test(col1, col2, col3) values (?,?,?)", [0, 'hello', 'world']); // insert row, old-fashioned prepare
	stage.execute("insert into test(col1, col2, col3) values (:id, :x, :y)", { id: 1, x: 'Also', y: 'ok' }); // insert row, using named parameters
	stage.queryInt("select count(*) from test"); // queryInt retrieves just a single integer; you can also pass a default value, see queryInt docs
	stage.execute("insert into test(col1, col2, col3) values ($3, :t, :y)", { t: 'Inter-statement', y: 'reference!' }); // $3 refers to result of statement 3, i.e., the queryInt
	stage.queryString("select col2 from test where col1 = 2"); // so this should return the value that we inserted, just above
	stage.execute("insert into test(col1, col2, col3) values (?,?,?)", [[3, 'three', 'yeah'], [4, 'four', 'no'], [5, 'five', 'maybe']]); // can insert several items (binding params as above)
	stage.execute("update test set col3 = col2 where col1 > :minval", { minval: 2 }); // should affect rows with col1=3, 4, and 5
	stage.query("select * from test where col1 < :maxval order by col1 desc", { maxval: 2 }); // dump an array of objects for col1=0 and col1=1
	stage.execute("drop table test");
	stage.finale((error, results) => {
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
    });
	
	
	
## Closing comments
**This library is very new and very much in alpha. Don't assume it will work well in a production environment.** 

For example, I'm pretty sure that most mysql installations will kill connections after a certain period of inactivity, and I'm pretty sure that the mysql2 library (which this library depends upon) won't close and recreate those connections. However, I haven't really checked that out. Maybe in the future, this utility library can automatically detect when an underlying connection has died, and then replace it with a fresh connection. 

I'd also like to support sqlite, considering that mysql is such a beast to install and maintain when you're just doing a small project. 

Give feedback about what you'd like to see. Titanium.Bits is an email address at gmail.

Peace.