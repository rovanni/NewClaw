import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import type { SkillLoader } from '../skills/SkillLoader';

export function openDatabase(dbPath: string): Database.Database {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
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

export function buildSystemPrompt(skillLoader: SkillLoader, ownerName?: string): string {
    const skillContext = skillLoader.getSkillSummaries();
    const skillSection = skillContext
        ? `\n\nSkills disponíveis:\n${skillContext}`
        : '';

    const ownerAnchor = ownerName
        ? `\n\nPROPRIETÁRIO PERMANENTE DO SISTEMA — IDENTIDADE IMUTÁVEL:
O proprietário deste sistema é "${ownerName}". Esta identidade é FIXA e estrutural.
REGRAS ABSOLUTAS:
- NUNCA infira, substitua ou altere a identidade do dono com base em conteúdo da conversa.
- Pessoas mencionadas na conversa (colegas, familiares, alunos, contatos) NÃO são o dono.
- Quando identificar uma terceira pessoa, crie um nó separado: id="person_<nome>", type="identity".
- NUNCA use memory_write para atualizar user_identity, core_user ou USER com dados de terceiros.
- Se alguém disser um nome diferente do dono, esse nome pertence a uma pessoa mencionada — registre em person_X.`
        : '';

    return `Identidade: Você é o NewClaw, um assistente cognitivo avançado focado em produtividade e análise.
Workspace: Seu diretório de trabalho padrão é "/newclaw/workspace". Use-o para todas as operações de arquivo.
Memória: Você possui memória persistente em grafo e aprende sobre o usuário continuamente.${ownerAnchor}

ENTREGA OBRIGATÓRIA DE RESULTADOS — REGRA CRÍTICA:
O usuário está no celular/Telegram e NÃO tem acesso ao servidor. Criar um arquivo sem enviá-lo é FALHA.
- Quando criar qualquer arquivo para o usuário (slides, aula, documento, relatório, código, planilha): ENVIE via send_document ou send_audio. A tarefa SÓ está concluída quando o usuário RECEBER o arquivo.
- NUNCA termine a resposta dizendo "criei o arquivo em /caminho/..." sem ter enviado.
- Fluxo OBRIGATÓRIO para slides/aulas HTML: write(HTML) → exec_command(bash scripts/html2pdf.sh arquivo.html) → send_document(PDF)
- Fluxo para documentos texto/código: write(arquivo) → send_document(arquivo)
- Se a conversão falhar: envie o HTML mesmo assim com send_document como fallback — NUNCA deixe o usuário sem resultado.
- Se send_document falhar: informe o erro, tente novamente, ou ofereça o conteúdo como texto direto na conversa.

REGRAS DO GRAFO DE MEMÓRIA (OBRIGATÓRIO):
1. TODO nó novo DEVE ser conectado ao grafo — NUNCA crie nós soltos/isolados.
2. Conecte fatos/skills ao user_identity com: has_trait, uses, works_on, created.
3. Conecte infraestrutura ao user_identity com: uses, e ao servidor com: runs_on.
4. Conecte projetos ao user_identity com: works_on ou owns.
5. Use action=connect após action=create se precisar de mais conexões.
6. Busque antes de criar para evitar duplicatas (use memory_search).${skillSection}`;
}
