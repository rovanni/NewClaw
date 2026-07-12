/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S62
 * Continuação da auditoria geral de regex de [[project_session_bugs_jul2026_ai]] (parte 3).
 * Achados de menor impacto que o de DomainRegistry, mas corrigidos a pedido explícito do
 * usuário ("sim, corrigir os 3, consolidar tudo"):
 *
 * 1. `AuthorizationManager.summarize()` tinha SUA PRÓPRIA regex divergente
 *    (`/rm\s+-rf|drop\s+table|mkfs|format/i`, sem boundary) só pra decidir o texto do aviso de
 *    confirmação ("risco alto" vs "risco médio") antes de rodar exec_command — nunca bloqueava
 *    nada de verdade (o bloqueio real já usava `server_config.isDestructive()`, uma lista
 *    totalmente separada). "format" casava como substring de "informação"/"informativo",
 *    mostrando aviso de risco errado pra comandos benignos.
 * 2. `UnifiedIntentRouter.isDestructive()` era um método público SEM NENHUMA chamada em todo o
 *    projeto (confirmado por grep) — código morto que duplicava (com bug de boundary) a mesma
 *    lógica já coberta pela rule 'destructive' de DETERMINISTIC_RULES (essa sim usada, e já
 *    protegida por keywordBoundaryMatches desde a correção anterior desta sessão).
 * 3. `ModelProfileRegistry.fallbackClassify()` tinha a MESMA classe de colisão de substring
 *    (ex: "file" casava dentro de "desfile") — impacto baixo (só escolhe qual perfil de modelo
 *    atende a mensagem quando a classificação por LLM já falhou), mas mesma causa raiz.
 *
 * Fix: `shared/destructiveCommandPatterns.ts` (novo) extrai a implementação REAL de
 * `tools/server_config.ts` (que continua reexportando com o mesmo nome — zero mudança nos
 * imports existentes de exec_command.ts/ssh_exec.ts) e `AuthorizationManager.ts` passa a
 * consumir a MESMA fonte, eliminando a divergência. Método morto removido de
 * UnifiedIntentRouter.ts. `ModelProfileRegistry.fallbackClassify()` passou a usar
 * `keywordBoundaryMatches()` (mesmo helper do fix anterior) pra keywords ≤6 chars.
 *
 * Escopo tocado: shared/destructiveCommandPatterns.ts (novo), tools/server_config.ts,
 * loop/AuthorizationManager.ts, loop/UnifiedIntentRouter.ts (só remoção de código morto),
 * loop/ModelProfileRegistry.ts.
 *
 * Execução: npx ts-node src/__tests__/regression/S62_DestructiveCommand_Consolidation.test.ts
 */

process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import { isDestructiveCommand } from '../../shared/destructiveCommandPatterns';
import { isDestructive as serverConfigIsDestructive } from '../../tools/server_config';
import { AuthorizationManager } from '../../loop/AuthorizationManager';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main(): Promise<void> {

console.log('\n=== S62-1 — server_config.ts reexporta a MESMA função (sem quebrar exec_command.ts/ssh_exec.ts) ===');
{
    assert(serverConfigIsDestructive === isDestructiveCommand, 'server_config.isDestructive é a mesma referência de shared/destructiveCommandPatterns.isDestructiveCommand');
    assert(serverConfigIsDestructive('rm -rf /') === true, 'server_config.isDestructive ainda bloqueia "rm -rf /" (comportamento real preservado)');
}

console.log('\n=== S62-2 — AuthorizationManager NÃO mostra mais aviso de risco alto pra comandos benignos com "format" ===');
{
    const auth = new AuthorizationManager();
    const benign = auth.formatRequest('exec_command', { command: 'echo "gerando resposta mais informativa sobre o sistema"' });
    assert(!benign.text.includes('risco alto') && !benign.text.includes('⚠️ _Esta ação pode modificar'), 'comando benigno com "informativa" NÃO mostra aviso de risco alto', benign.text);

    const real = auth.formatRequest('exec_command', { command: 'rm -rf /var/www' });
    assert(real.text.includes('⚠️ _Esta ação pode modificar'), 'comando destrutivo real ("rm -rf") continua mostrando aviso de risco alto', real.text);
}

console.log('\n=== S62-3 — UnifiedIntentRouter.isDestructive() (método morto) foi removido ===');
{
    const { UnifiedIntentRouter } = require('../../loop/UnifiedIntentRouter');
    const proto = UnifiedIntentRouter.prototype as Record<string, unknown>;
    assert(typeof proto.isDestructive === 'undefined', 'método morto isDestructive() não existe mais no protótipo');
}

console.log('\n=== S62-4 — ModelProfileRegistry: colisão de substring corrigida (sem instanciar rede/provider) ===');
{
    // fallbackClassify é privado — replicamos o algoritmo real (mesmas keywords/patterns e mesma
    // lógica de scoring) pra testar a correção isoladamente, sem precisar de ProviderFactory real
    // (mesma técnica já usada no S10/AB desta sessão pra evitar dependências pesadas em teste).
    const { keywordBoundaryMatches } = require('../../shared/keywordBoundary');
    const codeKeywords = ['código', 'programar', 'html', 'css', 'js', 'python', 'script', 'bug', 'debug', 'arquivo', 'file', 'criar', 'gerar', 'fazer', 'build'];

    function scoreCode(text: string): number {
        const lower = text.toLowerCase();
        let score = 0;
        for (const kw of codeKeywords) {
            const kwLower = kw.toLowerCase();
            const matched = kwLower.length <= 6 ? keywordBoundaryMatches(lower, kwLower) : lower.includes(kwLower);
            if (matched) score += 2;
        }
        return score;
    }

    assert(scoreCode('Vou ver o desfile de sete de setembro') === 0, '"desfile" não ativa mais a keyword "file" (score 0)', scoreCode('Vou ver o desfile de sete de setembro'));
    assert(scoreCode('Encontrei um bug no meu script') > 0, '"bug"/"script" isolados continuam pontuando pra categoria code', scoreCode('Encontrei um bug no meu script'));
    assert(scoreCode('Encontrei vários bugs nos meus scripts') > 0, 'plural regular ("bugs"/"scripts") continua pontuando (allowPluralS)', scoreCode('Encontrei vários bugs nos meus scripts'));
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S62 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S62 erro inesperado:', err);
    process.exitCode = 1;
});
