/// <reference types="node" />
/**
 * S202 — Turno que envia só texto nunca usa o perfil de visão.
 *
 * BUG REAL (produção, 05/08/2026): três imagens enviadas com "Poderia explicar cada projeto?".
 * A ingestão funcionou perfeitamente — três descrições geradas (2016, 1818 e 2496 caracteres),
 * `attachments_processed total=3 ok=3 falhou=0`. E a resposta final ignorou tudo:
 *
 *     "Com base no seu contexto e na minha memória de projetos registrados, existem atualmente
 *      dois itens definidos como 'projetos' em nosso sistema..."
 *
 * O log explica: o roteador classificou o turno como `vision` e trocou o modelo do turno inteiro
 * para o perfil de visão — um modelo local de 4B parâmetros, escolhido por saber OLHAR imagem —
 * que então teve de raciocinar sobre ~6 KB de texto e se perdeu, agarrando a palavra "projetos"
 * da memória do sistema.
 *
 *     [UNIFIED-ROUTER] intent=vision → Overriding model: vision → <modelo-de-visão>
 *     [STREAM] START model=<modelo-de-visão> inputTokens≈1825
 *
 * O erro é conceitual, não de configuração: **depois da ingestão não existe imagem no turno**.
 * O único ponto do projeto que envia `images:[base64]` ao modelo é `processVision`, na ingestão.
 * Quando o AgentLoop roda, a imagem já virou descrição textual — o modelo de visão já cumpriu seu
 * papel. Escolher o perfil de visão ali é escolher a ferramenta pela etiqueta, não pela tarefa.
 *
 * Dois caminhos levavam a isso, e o teste cobre os dois:
 *   1. override por `IntentDecision.modelCategory === 'vision'`;
 *   2. `resolveProfile()`, cuja heurística pontua "imagem"/"foto" — e o texto do turno contém
 *      `[IMAGEM RECEBIDA: ...]`, escrito pela PRÓPRIA ingestão. O sistema classificava como visão
 *      o texto que ele mesmo tinha produzido.
 *
 * O que NÃO muda: quem envia bytes de imagem (media handlers, read_document) continua usando o
 * perfil de visão — é para isso que ele existe.
 *
 * Execução: npx ts-node src/__tests__/regression/S202_TextTurnNeverUsesVisionProfile.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { ModelProfileRegistry } from '../../loop/ModelProfileRegistry';

let failures = 0;
function check(ok: boolean, label: string, detail = '') {
    if (ok) {
        console.log(`  OK   ${label}`);
    } else {
        failures++;
        console.error(`  FALHOU: ${label}${detail ? ' → ' + detail : ''}`);
    }
}

/** Texto como ele chega ao AgentLoop depois da ingestão: pergunta + descrições. */
const TEXTO_POS_INGESTAO = [
    'Poderia explicar cada projeto?',
    '[IMAGEM RECEBIDA: slide-1.jpeg]',
    '[DESCRIÇÃO DA VISÃO]: A imagem mostra um slide sobre o projeto Supabase, alternativa ao Firebase...',
    '[IMAGEM RECEBIDA: slide-2.jpeg]',
    '[DESCRIÇÃO DA VISÃO]: Slide sobre Coolify, plataforma de auto-hospedagem...',
].join('\n');

async function main() {
    console.log('S202 — Turno de texto nunca usa o perfil de visão\n');

    const registry = new ModelProfileRegistry();
    const visionModel = registry.getProfileByCategory('vision')?.model;
    const chatModel = registry.getProfileByCategory('chat')?.model;

    check(!!visionModel && !!chatModel, 'perfis de visão e chat existem no registry', `vision=${visionModel} chat=${chatModel}`);
    check(visionModel !== chatModel, 'os dois perfis apontam para modelos diferentes (senão o teste não prova nada)');

    // ── 1. Caminho do override por categoria ──────────────────────────────────
    {
        const escolhido = registry.getTextProfileByCategory('vision');
        check(
            escolhido?.category !== 'vision',
            'pedir categoria "vision" para um turno de texto NÃO devolve o perfil de visão',
            `devolveu category=${escolhido?.category} model=${escolhido?.model}`,
        );
        check(
            escolhido?.model === chatModel,
            'devolve o perfil de raciocínio equivalente (chat)',
            `devolveu ${escolhido?.model}, esperado ${chatModel}`,
        );
    }

    // ── 2. Caminho da resolução por heurística de texto ───────────────────────
    {
        // Sem a correção, as palavras "IMAGEM"/"VISÃO" no texto que a própria ingestão escreveu
        // fazem a heurística classificar o turno como vision.
        const heuristico = registry.resolveProfileSync(TEXTO_POS_INGESTAO);
        const textual = await registry.resolveTextProfile(TEXTO_POS_INGESTAO);

        check(
            textual.category !== 'vision',
            'resolveTextProfile não devolve o perfil de visão para o texto pós-ingestão',
            `category=${textual.category} model=${textual.model}`,
        );

        if (heuristico.category === 'vision') {
            console.log('       (a heurística genérica classificaria este texto como "vision" — é exatamente o caso do bug)');
        }
    }

    // ── 3. Categorias legítimas continuam intactas ────────────────────────────
    {
        for (const cat of ['chat', 'code', 'light', 'analysis', 'execution'] as const) {
            const p = registry.getTextProfileByCategory(cat);
            check(p?.category === cat, `categoria "${cat}" é preservada sem alteração`, `devolveu ${p?.category}`);
        }
    }

    // ── 4. Quem realmente envia imagem continua usando o perfil de visão ──────
    {
        const controller = fs.readFileSync(
            path.join(__dirname, '..', '..', 'core', 'AgentController.ts'), 'utf-8',
        );
        check(
            /getProfileByCategory\('vision'\)/.test(controller),
            'os media handlers continuam pedindo o perfil de visão (eles enviam bytes de imagem)',
        );

        const agentLoop = fs.readFileSync(
            path.join(__dirname, '..', '..', 'loop', 'AgentLoop.ts'), 'utf-8',
        );
        check(
            !/resolveProfile\(userText\)/.test(agentLoop),
            'AgentLoop não usa mais a resolução genérica para escolher o modelo do turno',
        );
        check(
            /resolveTextProfile\(/.test(agentLoop) && /getTextProfileByCategory\(/.test(agentLoop),
            'AgentLoop usa a resolução específica de turno de texto nos dois caminhos',
        );
    }

    console.log(failures === 0 ? '\n✅ S202 passou' : `\n❌ S202: ${failures} falha(s)`);
    process.exitCode = failures === 0 ? 0 : 1;
}

main();
