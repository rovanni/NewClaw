const Database = require('better-sqlite3');
try {
    const db = new Database('./data/newclaw.db', { fileMustExist: true });
    // Pegar o último conversation_id
    const trace = db.prepare('SELECT * FROM agent_traces ORDER BY created_at DESC LIMIT 10').all();
    console.log(JSON.stringify(trace, null, 2));
} catch (e) {
    console.error(e);
}
