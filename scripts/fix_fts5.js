const Database = require("better-sqlite3");
const db = new Database("./data/newclaw.db");

// Drop triggers that corrupt FTS5
try { db.exec("DROP TRIGGER IF EXISTS memory_nodes_ai"); } catch(e) {}
try { db.exec("DROP TRIGGER IF EXISTS memory_nodes_ad"); } catch(e) {}
try { db.exec("DROP TRIGGER IF EXISTS memory_nodes_au"); } catch(e) {}

// Drop and recreate FTS5
db.exec("DROP TABLE IF EXISTS memory_nodes_fts");
db.exec("CREATE VIRTUAL TABLE memory_nodes_fts USING fts5(name, content, type, content='memory_nodes', content_rowid='fts_rowid')");

// Ensure fts_rowid is populated
db.exec("UPDATE memory_nodes SET fts_rowid = (SELECT COUNT(*) FROM memory_nodes m2 WHERE m2.id <= memory_nodes.id) WHERE fts_rowid IS NULL OR fts_rowid = 0");

// Rebuild FTS5 from scratch (this uses content= sync)
db.exec("INSERT INTO memory_nodes_fts(memory_nodes_fts) VALUES('rebuild')");
console.log("FTS5 rebuilt from content sync");

// Recreate triggers with correct fts_rowid
db.exec(`
    CREATE TRIGGER IF NOT EXISTS memory_nodes_ai AFTER INSERT ON memory_nodes BEGIN
      INSERT INTO memory_nodes_fts(rowid, name, content, type) VALUES (new.fts_rowid, new.name, new.content, new.type);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_nodes_ad AFTER DELETE ON memory_nodes BEGIN
      INSERT INTO memory_nodes_fts(memory_nodes_fts, rowid, name, content, type) VALUES('delete', old.fts_rowid, old.name, old.content, old.type);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_nodes_au AFTER UPDATE ON memory_nodes BEGIN
      INSERT INTO memory_nodes_fts(memory_nodes_fts, rowid, name, content, type) VALUES('delete', old.fts_rowid, old.name, old.content, old.type);
      INSERT INTO memory_nodes_fts(rowid, name, content, type) VALUES (new.fts_rowid, new.name, new.content, new.type);
    END;
`);
console.log("Triggers recreated");

// Test FTS5 search
var r = db.prepare("SELECT n.id, n.type FROM memory_nodes_fts f JOIN memory_nodes n ON f.rowid = n.fts_rowid WHERE memory_nodes_fts MATCH 'Vênus'").all();
console.log("Search 'Venus':", r.length, "results");
r.forEach(function(n) { console.log("  -", n.id, n.type); });

var infra = db.prepare("SELECT id, type, name FROM memory_nodes WHERE type = 'infrastructure'").all();
console.log("Infrastructure nodes:", infra.map(function(n) { return n.id + " (" + n.type + ")"; }).join(", "));

// Start NewClaw back up
db.close();
console.log("DONE");