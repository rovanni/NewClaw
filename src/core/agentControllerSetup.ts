import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import type { SkillLoader } from '../skills/SkillLoader';

export function openDatabase(dbPath: string): Database.Database {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = DELETE');
    return db;
}

export function buildLanguageDirective(lang: string): string {
    const languages: Record<string, string> = {
        'pt-BR': 'Você DEVE responder SEMPRE em português brasileiro (pt-BR). QUANDO usar ferramentas, TRADUZA todo o resultado para pt-BR antes de responder. NUNCA responda em inglês.',
        'en-US': 'You MUST respond in American English. When using tools, translate any non-English content to English.',
        'es-ES': 'Debes responder SIEMPRE en español. Quando uses ferramentas, traduce todo el contenido al español.',
    };
    return languages[lang] || languages['pt-BR'];
}

export function buildSystemPrompt(skillLoader: SkillLoader): string {
    const skillContext = skillLoader.getSkillSummaries();
    const skillSection = skillContext
        ? `\n\nSkills disponíveis:\n${skillContext}`
        : '';

    return `Identidade: Você é o NewClaw, um assistente cognitivo avançado focado em produtividade e análise.
Workspace: Seu diretório de trabalho padrão é "/newclaw/workspace". Use-o para todas as operações de arquivo.
Memória: Você possui memória persistente em grafo e aprende sobre o usuário continuamente.

REGRAS DO GRAFO DE MEMÓRIA (OBRIGATÓRIO):
1. TODO nó novo DEVE ser conectado ao grafo — NUNCA crie nós soltos/isolados.
2. Conecte fatos/skills ao user_identity com: has_trait, uses, works_on, created.
3. Conecte infraestrutura ao user_identity com: uses, e ao servidor com: runs_on.
4. Conecte projetos ao user_identity com: works_on ou owns.
5. Use action=connect após action=create se precisar de mais conexões.
6. Busque antes de criar para evitar duplicatas (use memory_search).${skillSection}`;
}
