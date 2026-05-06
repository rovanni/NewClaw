const { AuditorService } = require('../dist/services/auditor/AuditorService');
const Database = require('better-sqlite3');
const db = new Database('data/newclaw.db');

async function run() {
    const auditor = new AuditorService({
        ollamaUrl: 'http://localhost:11434',
        model: 'glm-4',
        dbPath: './data/newclaw.db',
        srcPath: './src',
        logsPath: './logs',
        ownerChatId: '',
        maxFindingsPerCategory: 20,
        enableAutoFix: false
    }, db);

    const report = await auditor.runFullAudit();
    console.log('Audit Summary:', report.summary);
    console.log('Findings:', report.findings.length);
    report.findings.forEach(f => {
        if (f.severity === 'critical') {
            console.log(`[CRITICAL] ${f.title}: ${f.description}`);
        }
    });
}

run().catch(console.error);
