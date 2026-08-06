/// <reference types="node" />
/**
 * S196 — O registro de perfis não entrega sua referência interna a quem lê.
 *
 * BUG REAL (incidente de 04/08/2026, RFC-004 Princípio 1): um usuário enviou 12 imagens e o
 * sistema analisou 4. A partir da quinta, o log registrava, para toda imagem:
 *
 *     [VisionHandler] vision_not_configured  Perfil de visão não encontrado no ModelProfileRegistry.
 *
 * Nada havia sido reconfigurado. O que aconteceu está a dois logs de distância:
 *
 *     10:29:19  Deterministic profile resolution: vision → <modelo-de-visao>
 *     10:29:19  [UNIFIED-ROUTER] Overriding model: execution → <modelo-de-texto>
 *
 * `getProfileByCategory()` era `this.config.profiles.find(...)` — devolvia o próprio objeto
 * guardado. `AgentLoop` escrevia nele (`chatProfile.model = ...; chatProfile.category = ...`) para
 * aplicar o override do roteador de intenção. Quando o perfil resolvido era o de VISÃO e a intenção
 * classificada era `execution`, o perfil de visão passava a ter `category: 'execution'` — e
 * `getProfileByCategory('vision')` passava a devolver `undefined`. O sistema ficava permanentemente
 * cego para imagens, sem exceção, sem erro, até o processo reiniciar.
 *
 * Segundo aliasing na mesma classe, encontrado na correção: o construtor fazia
 * `this.config = { ...DEFAULT_CONFIG }` — cópia RASA, que compartilha o array `profiles` com a
 * constante do módulo. O laço de override do construtor então escrevia em `DEFAULT_CONFIG`,
 * fazendo um registry contaminar os padrões de qualquer outro criado depois no mesmo processo.
 *
 * Este teste trava três invariantes:
 *   1. mutar o que um getter devolveu não altera o registry;
 *   2. um registry com override não contamina outro criado em seguida;
 *   3. `AgentLoop` não volta a escrever no perfil resolvido (guarda estática).
 *
 * Execução: npx ts-node src/__tests__/regression/S196_ModelProfileRegistry_ReadOnlyProfiles.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { ModelProfileRegistry, type ModelProfile } from '../../loop/ModelProfileRegistry';

let failures = 0;
function check(ok: boolean, label: string, detail = '') {
    if (ok) {
        console.log(`  OK   ${label}`);
    } else {
        failures++;
        console.error(`  FALHOU: ${label}${detail ? ' → ' + detail : ''}`);
    }
}

console.log('S196 — Perfis do registry são imutáveis para quem lê\n');

// ── 1. Reprodução literal do incidente ───────────────────────────────────────
{
    const registry = new ModelProfileRegistry();

    const visionBefore = registry.getProfileByCategory('vision');
    check(visionBefore !== undefined, 'perfil de visão existe antes do override');

    // Exatamente o que AgentLoop fazia: pegar o perfil resolvido e reatribuir model+category.
    const resolved = registry.getProfileByCategory('vision') as ModelProfile;
    const executionProfile = registry.getProfileByCategory('execution') as ModelProfile;
    resolved.model = executionProfile.model;
    resolved.category = executionProfile.category;

    const visionAfter = registry.getProfileByCategory('vision');
    check(
        visionAfter !== undefined,
        'perfil de visão continua existindo após mutação da cópia (o incidente não se repete)',
        visionAfter === undefined ? 'getProfileByCategory("vision") devolveu undefined' : '',
    );
    check(
        visionAfter?.model === visionBefore?.model,
        'o modelo do perfil de visão permanece intacto',
        `antes=${visionBefore?.model} depois=${visionAfter?.model}`,
    );
}

// ── 2. getProfiles() e getProfile() também entregam cópia ────────────────────
{
    const registry = new ModelProfileRegistry();

    const all = registry.getProfiles() as ModelProfile[];
    const firstId = all[0].id;
    all[0].model = 'modelo-invasor';
    all.push({
        id: 'perfil-invasor', model: 'x', server: 'x', category: 'chat', description: 'injetado pelo teste',
    });

    check(
        registry.getProfile(firstId)?.model !== 'modelo-invasor',
        'mutar o array devolvido por getProfiles() não altera o registry',
    );
    check(
        registry.getProfile('perfil-invasor') === undefined,
        'inserir no array devolvido por getProfiles() não insere no registry',
    );

    const byId = registry.getProfile(firstId) as ModelProfile;
    byId.server = 'http://invasor.invalido';
    check(
        registry.getProfile(firstId)?.server !== 'http://invasor.invalido',
        'mutar o que getProfile() devolveu não altera o registry',
    );
}

// ── 3. setProfile() guarda cópia, não alça para o objeto do chamador ─────────
{
    const registry = new ModelProfileRegistry();
    const novo: ModelProfile = {
        id: 'perfil-teste', model: 'modelo-a', server: 'http://localhost:11434',
        category: 'analysis', description: 'perfil de teste',
    };
    registry.setProfile(novo);
    novo.model = 'modelo-b'; // o chamador continua mexendo no objeto que passou

    check(
        registry.getProfile('perfil-teste')?.model === 'modelo-a',
        'setProfile() guarda cópia — mutação posterior do chamador não vaza para dentro',
    );
}

// ── 4. Um registry não contamina o próximo (aliasing de DEFAULT_CONFIG) ──────
{
    const comOverride = new ModelProfileRegistry({ vision: 'modelo-especifico-do-teste' } as never);
    check(
        comOverride.getProfileByCategory('vision')?.model === 'modelo-especifico-do-teste',
        'override de modelo por categoria é aplicado na instância que o recebeu',
    );

    const semOverride = new ModelProfileRegistry();
    check(
        semOverride.getProfileByCategory('vision')?.model !== 'modelo-especifico-do-teste',
        'registry criado depois NÃO herda o override do anterior (DEFAULT_CONFIG intacto)',
        `recebeu: ${semOverride.getProfileByCategory('vision')?.model}`,
    );
}

// ── 5. Guarda estática: AgentLoop não volta a escrever no perfil resolvido ───
{
    const agentLoop = fs.readFileSync(
        path.join(__dirname, '..', '..', 'loop', 'AgentLoop.ts'), 'utf-8',
    );
    // Atribuição direta a campo de um perfil obtido do registry — a forma exata do bug original.
    const mutation = /\b(chatProfile|resolvedProfile|intentProfile|synthesisProfile|profile)\.(model|category|provider|server)\s*=[^=]/;
    const offending = agentLoop.split('\n')
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        .filter(({ line }) => mutation.test(line) && !line.startsWith('//') && !line.startsWith('*'));

    check(
        offending.length === 0,
        'AgentLoop não atribui campos de perfil obtido do registry',
        offending.slice(0, 5).map(o => `linha ${o.n}: ${o.line.slice(0, 60)}`).join(' | '),
    );
}

console.log(failures === 0 ? '\n✅ S196 passou' : `\n❌ S196: ${failures} falha(s)`);
process.exit(failures === 0 ? 0 : 1);
