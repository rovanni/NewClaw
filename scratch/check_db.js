const Database = require('better-sqlite3');
const db = new Database('data/newclaw.db');

try {
    const traces = db.prepare('SELECT COUNT(*) as count FROM agent_traces').get();
    const classifications = db.prepare('SELECT COUNT(*) as count FROM memory_classifications').get();
    const decisions = db.prepare('SELECT COUNT(*) as count FROM tool_decisions').get();

    console.log('--- Database Status ---');
    console.log('agent_traces:', traces.count);
    console.log('memory_classifications:', classifications.count);
    console.log('tool_decisions:', decisions.count);
} catch (e) {
    console.error('Error reading database:', e.message);
} finally {
    db.close();
}
