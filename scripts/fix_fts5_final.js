const Database = require("better-sqlite3");
const db = new Database("./data/newclaw.db");
db.pragma("foreign_keys = OFF");

// 1. Clean all leftovers from previous migration attempts
try { db.exec("DROP TABLE IF EXISTS memory_nodes_v3"); } catch {}
try { db.exec("DROP TABLE IF EXISTS memory_nodes_v2"); } catch {}
try { db.exec("DROP TABLE IF EXISTS memory_nodes_fts"); } catch {}
try { db.exec("DROP TRIGGER IF EXISTS memory_nodes_ai"); } catch {}
try { db.exec("DROP TRIGGER IF EXISTS memory_nodes_ad"); } catch {}
try { db.exec("DROP TRIGGER IF EXISTS memory_nodes_au"); } catch {}
console.log("1. Cleaned leftovers");

// 2. Check current columns
var cols = db.prepare("PRAGMA table_info(memory_nodes)").all().map(c => c.name);
console.log("2. Current columns:", cols.join(", "));

if (cols.includes("fts_rowid")) {
    // 3. Recreate table without fts_rowid
    db.exec("CREATE TABLE memory_nodes_v3 (id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL, metadata TEXT DEFAULT '{}', pagerank REAL DEFAULT 0.0, degree INTEGER DEFAULT 0, betweenness REAL DEFAULT 0.0, closeness REAL DEFAULT 0.0, community_id INTEGER DEFAULT 0, context_type TEXT, classification_score REAL DEFAULT 0, last_accessed TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)");
    
    // Only select columns that exist in both tables
    var srcCols = ["id","type","name","content","metadata","pagerank","degree","betweenness","closeness","community_id","context_type","classification_score","last_accessed","created_at","updated_at"].filter(c => cols.includes(c));
    db.exec("INSERT INTO memory_nodes_v3 (" + srcCols.join(",") + ") SELECT " + srcCols.join(",") + " FROM memory_nodes");
    var count = db.prepare("SELECT COUNT(*) as c FROM memory_nodes_v3").get();
    console.log("3. Migrated", count.c, "nodes (without fts_rowid)");
    db.exec("DROP TABLE memory_nodes");
    db.exec("ALTER TABLE memory_nodes_v3 RENAME TO memory_nodes");
} else {
    console.log("3. fts_rowid not present, skip migration");
}

// 4. Verify
var finalCols = db.prepare("PRAGMA table_info(memory_nodes)").all().map(c => c.name);
console.log("4. Final columns:", finalCols.join(", "));
var finalCount = db.prepare("SELECT COUNT(*) as c FROM memory_nodes").get();
console.log("   Total nodes:", finalCount.c);

// 5. Create FTS5 with native rowid
db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memory_nodes_fts USING fts5(name, content, type, content='memory_nodes')");
db.exec("INSERT INTO memory_nodes_fts(memory_nodes_fts) VALUES('rebuild')");
console.log("5. FTS5 created and rebuilt");

// 6. Create triggers with native rowid
db.exec("CREATE TRIGGER IF NOT EXISTS memory_nodes_ai AFTER INSERT ON memory_nodes BEGIN INSERT INTO memory_nodes_fts(rowid, name, content, type) VALUES (new.rowid, new.name, new.content, new.type); END");
db.exec("CREATE TRIGGER IF NOT EXISTS memory_nodes_ad AFTER DELETE ON memory_nodes BEGIN INSERT INTO memory_nodes_fts(memory_nodes_fts, rowid, name, content, type) VALUES('delete', old.rowid, old.name, old.content, old.type); END");
db.exec("CREATE TRIGGER IF NOT EXISTS memory_nodes_au AFTER UPDATE ON memory_nodes BEGIN INSERT INTO memory_nodes_fts(memory_nodes_fts, rowid, name, content, type) VALUES('delete', old.rowid, old.name, old.content, old.type); INSERT INTO memory_nodes_fts(rowid, name, content, type) VALUES (new.rowid, new.name, new.content, new.type); END");
console.log("6. Triggers created");

// 7. Test FTS5
var tests = ["infrastructure", "Usuario", "trading", "Vênus", "memory"];
tests.forEach(function(term) {
    try {
        var r = db.prepare("SELECT n.id, n.type, n.name FROM memory_nodes_fts f JOIN memory_nodes n ON f.rowid = n.rowid WHERE memory_nodes_fts MATCH ?").all(term + "*");
        console.log("7. FTS5 '" + term + "*': " + r.length + " results");
        r.slice(0, 2).forEach(function(n) { console.log("   - " + n.id + " (" + n.type + ")"); });
    } catch(e) { console.log("7. FTS5 '" + term + "*': ERROR - " + e.message); }
});

// 8. Integrity
var integrity = db.pragma("integrity_check");
console.log("8. Integrity:", integrity[0].integrity_check);

db.pragma("foreign_keys = ON");
db.close();
console.log("DONE");