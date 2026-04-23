/**
 * OnboardingService — Apresentação e questionário inicial do NewClaw
 * 
 * Adaptado do IalClaw. Quando o DB está vazio (sem perfil do usuário),
 * o agente se apresenta e faz perguntas adaptativas para conhecer o usuário.
 * 
 * Fluxo: DB vazio → apresentação → questionário → perfil salvo → pronto
 */
import { Database } from 'better-sqlite3';

export interface UserProfile {
    user_id: string;
    name: string | null;
    assistant_name: string | null;
    expertise: string | null;
    goals: string | null;
    familiarity: 'beginner' | 'intermediate' | 'advanced' | null;
    response_style: 'concise' | 'detailed' | 'adaptive';
    learning_mode: 'enabled' | 'disabled' | 'feedback-only';
    autonomy_level: 'conservative' | 'balanced' | 'confident';
    workspace_path: string | null;
    language_preference: 'system' | 'english-tech' | 'dynamic';
    onboarding_completed: number;
    created_at: string;
    updated_at: string;
}

export interface OnboardingState {
    step: number;
    userId: string;
    data: Partial<UserProfile>;
}

type UserProfileWithSkip = Partial<UserProfile> & { [key: string]: any };

function classificarEntrada(input: string): UserProfileWithSkip {
    const resposta = input.trim().toLowerCase();
    const result: UserProfileWithSkip = {};

    // Estilo de resposta
    if (/(conciso|curto|resumido|1|short|concise)/i.test(resposta)) result.response_style = 'concise';
    else if (/(detalhado|longo|explicativo|2|detailed|long)/i.test(resposta)) result.response_style = 'detailed';
    else if (/(adaptativo|auto|3|adaptive)/i.test(resposta)) result.response_style = 'adaptive';

    // Familiaridade
    if (/(iniciante|1|beginner|basic)/i.test(resposta)) result.familiarity = 'beginner';
    else if (/(intermediário|intermediario|2|intermediate|medium)/i.test(resposta)) result.familiarity = 'intermediate';
    else if (/(avançado|avancado|3|advanced|pro|expert)/i.test(resposta)) result.familiarity = 'advanced';

    // Autonomia
    if (/(conservador|baixo risco|1|conservative)/i.test(resposta)) result.autonomy_level = 'conservative';
    else if (/(balanceado|equilibrado|2|balanced)/i.test(resposta)) result.autonomy_level = 'balanced';
    else if (/(confiante|ousado|3|confident)/i.test(resposta)) result.autonomy_level = 'confident';

    // Nome do usuário
    if (/meu nome é|me chamo|sou o|sou a|name is|i am |i'm /i.test(input)) {
        const nome = input.replace(/.*(meu nome é|me chamo|sou o|sou a|name is|i am|i'm)\s*/i, '').split(/[,.!\n]/)[0].trim();
        if (nome.length > 1) result.name = nome;
    }

    // Nome do assistente
    if (/seu nome é|te chamo de|call you|assistant name/i.test(input)) {
        const nome = input.replace(/.*(seu nome é|te chamo de|call you|assistant name)\s*/i, '').split(/[,.!\n]/)[0].trim();
        if (nome.length > 1) result.assistant_name = nome;
    }

    // Expertise
    if (/(professor|engenheiro|dev|designer|médico|advogado|teacher|engineer|developer|doctor|lawyer)/i.test(resposta)) {
        result.expertise = input;
    }

    // Objetivos
    if (/(meu objetivo|quero|preciso|busco|goal|i want|i need|my goal)/i.test(input)) {
        result.goals = input;
    }

    // Pular
    if (/pular|skip|depois|não quero|nao quero|next|próxima|proxima/i.test(resposta)) {
        result['__skip__'] = true;
    }

    // Se nenhum campo preenchido e não é skip, trata como nome
    if (Object.keys(result).length === 0 && resposta.length >= 2 && resposta.length <= 50) {
        result.name = input.trim();
    }

    return result;
}

const ONBOARDING_STEPS = [
    {
        id: 'name',
        question: () => `👋 Olá! Eu sou o *NewClaw*, seu assistente cognitivo local!\n\nAcabei de acordar e ainda não nos conhecemos. Qual é o seu nome?`,
        saveField: 'name'
    },
    {
        id: 'familiarity',
        question: (data: any) => `Prazer em conhecer você, *${data.name || 'amigo'}*! 🤝\n\nQual seu nível de familiaridade com IA e programação?\n\n1️⃣ Iniciante\n2️⃣ Intermediário\n3️⃣ Avançado\n\n_(Responda com o número ou a palavra)_`,
        saveField: 'familiarity'
    },
    {
        id: 'expertise',
        question: (data: any) => `E qual é sua área de atuação?\n\nEx: Engenheiro de Software, Professor, Designer, Médico...`,
        saveField: 'expertise'
    },
    {
        id: 'goals',
        question: () => `Qual seu objetivo principal comigo?\n\n1️⃣ Desenvolvimento de código\n2️⃣ Pesquisa e conhecimento\n3️⃣ Criação de conteúdo\n4️⃣ Gestão de tarefas\n5️⃣ Análise de dados\n6️⃣ Aprendizado e tutoria\n7️⃣ Outro`,
        saveField: 'goals'
    },
    {
        id: 'response_style',
        question: () => `Como prefere minhas respostas?\n\n1️⃣ Conciso — direto ao ponto\n2️⃣ Detalhado — explicações completas\n3️⃣ Adaptativo — ajusta conforme o contexto\n\n_(Pode mudar depois)_`,
        saveField: 'response_style'
    },
    {
        id: 'autonomy_level',
        question: () => `Quanto de autonomia você me dá?\n\n1️⃣ Conservador — sempre pergunte antes de agir\n2️⃣ Balanceado — aja em tarefas simples, pergunte nas complexas\n3️⃣ Confiante — execute e me avise depois`,
        saveField: 'autonomy_level'
    },
    {
        id: 'language_preference',
        question: () => `Idioma preferido?\n\n1️⃣ Sistema (pt-BR padrão)\n2️⃣ Inglês para termos técnicos\n3️⃣ Dinâmico — adapta conforme o contexto`,
        saveField: 'language_preference'
    }
];

export class OnboardingService {
    private db: Database;
    private states: Map<string, OnboardingState> = new Map();

    constructor(db: Database) {
        this.db = db;
        this.ensureTable();
    }

    private ensureTable(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS user_profile (
                user_id TEXT PRIMARY KEY,
                name TEXT,
                assistant_name TEXT,
                expertise TEXT,
                goals TEXT,
                familiarity TEXT,
                response_style TEXT DEFAULT 'adaptive',
                learning_mode TEXT DEFAULT 'enabled',
                autonomy_level TEXT DEFAULT 'balanced',
                workspace_path TEXT,
                language_preference TEXT DEFAULT 'system',
                onboarding_completed INTEGER DEFAULT 0,
                created_at TEXT,
                updated_at TEXT
            )
        `);
    }

    /**
     * Check if user has completed onboarding
     */
    isOnboardingCompleted(userId: string): boolean {
        const row = this.db.prepare('SELECT onboarding_completed FROM user_profile WHERE user_id = ?').get(userId) as any;
        return row?.onboarding_completed === 1;
    }

    /**
     * Check if DB is empty (no user profile at all)
     */
    isDbEmpty(): boolean {
        const row = this.db.prepare('SELECT COUNT(*) as c FROM user_profile').get() as any;
        return row.c === 0;
    }

    /**
     * Get user profile
     */
    getUserProfile(userId: string): UserProfile | null {
        return this.db.prepare('SELECT * FROM user_profile WHERE user_id = ?').get(userId) as UserProfile | null;
    }

    /**
     * Start onboarding for a new user
     */
    startOnboarding(userId: string): { question: string } | null {
        if (this.isOnboardingCompleted(userId)) return null;

        const state: OnboardingState = { step: 0, userId, data: {} };
        this.states.set(userId, state);
        return this.getNextQuestion(state.data);
    }

    /**
     * Process an answer during onboarding
     */
    processAnswer(userId: string, answer: string): { question?: string; completed?: boolean; welcomeMessage?: string } | null {
        const state = this.states.get(userId);
        if (!state) {
            if (!this.isOnboardingCompleted(userId)) return this.startOnboarding(userId);
            return null;
        }

        const campos = classificarEntrada(answer);
        if (campos?.['__skip__']) {
            return this.getNextQuestion(state.data);
        }
        Object.assign(state.data, campos);

        // Check if we have enough data to complete
        const preenchidos = Object.keys(state.data).filter(k => state.data[k as keyof UserProfile] && k !== '__skip__');
        if (preenchidos.length >= 6 || (state.data.name && preenchidos.length >= 3)) {
            this.completeOnboarding(state);
            const welcomeMsg = this.generateWelcomeMessage(state.data);
            this.states.delete(userId);

            // Also create memory nodes for the user profile
            this.createMemoryNodes(state);

            return { completed: true, welcomeMessage: welcomeMsg };
        }

        return this.getNextQuestion(state.data);
    }

    private getNextQuestion(data: Partial<UserProfile>): { question: string } {
        for (const step of ONBOARDING_STEPS) {
            if (!data[step.saveField as keyof UserProfile]) {
                return { question: step.question(data) };
            }
        }
        return { question: this.generateWelcomeMessage(data) };
    }

    private completeOnboarding(state: OnboardingState): void {
        const now = new Date().toISOString();
        this.db.prepare(`
            INSERT OR REPLACE INTO user_profile
            (user_id, name, assistant_name, expertise, goals, familiarity, response_style, learning_mode, autonomy_level, workspace_path, language_preference, onboarding_completed, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `).run(
            state.userId,
            state.data.name || null,
            state.data.assistant_name || null,
            state.data.expertise || null,
            state.data.goals || null,
            state.data.familiarity || null,
            state.data.response_style || 'adaptive',
            'enabled',
            state.data.autonomy_level || 'balanced',
            state.data.workspace_path || null,
            state.data.language_preference || 'system',
            now,
            now
        );
        console.log(`[Onboarding] Completed for user ${state.userId}`);
    }

    /**
     * Create memory nodes from onboarding data
     */
    private createMemoryNodes(state: OnboardingState): void {
        try {
            const insertNode = this.db.prepare(
                'INSERT OR IGNORE INTO memory_nodes (id, type, name, content, metadata, fts_rowid, created_at, updated_at) VALUES (?, ?, ?, ?, \'{}\', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)'
            );
            const insertEdge = this.db.prepare(
                'INSERT OR IGNORE INTO memory_edges (from_node, to_node, relation, weight, confidence, created_at) VALUES (?, ?, ?, 1.0, 1.0, CURRENT_TIMESTAMP)'
            );

            // Get max fts_rowid
            const maxRow = this.db.prepare('SELECT COALESCE(MAX(fts_rowid), 0) as max FROM memory_nodes').get() as any;
            let ftsId = maxRow.max + 1;

            // Update core_user with name
            if (state.data.name) {
                this.db.prepare('UPDATE memory_nodes SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = \'core_user\'').run(
                    `${state.data.name} — ${state.data.expertise || 'Usuário'}. Familiaridade: ${state.data.familiarity || 'N/A'}. Objetivos: ${state.data.goals || 'Geral'}. Estilo: ${state.data.response_style || 'adaptive'}. Autonomia: ${state.data.autonomy_level || 'balanced'}.`
                );
            }

            // Create preference nodes from onboarding
            if (state.data.response_style && state.data.response_style !== 'adaptive') {
                insertNode.run(`pref_style`, 'preference', 'Estilo de Resposta', `Estilo preferido: ${state.data.response_style}`, ftsId++);
                insertEdge.run('core_user', 'pref_style', 'prefers');
            }

            if (state.data.autonomy_level && state.data.autonomy_level !== 'balanced') {
                insertNode.run(`pref_autonomy`, 'preference', 'Nível de Autonomia', `Autonomia: ${state.data.autonomy_level}`, ftsId++);
                insertEdge.run('core_user', 'pref_autonomy', 'prefers');
            }

            // Rebuild FTS5
            try { this.db.exec('INSERT INTO memory_nodes_fts(memory_nodes_fts) VALUES("rebuild")'); } catch { /* optional */ }

            console.log('[Onboarding] Memory nodes created from profile');
        } catch (e: any) {
            console.error('[Onboarding] Error creating memory nodes:', e.message);
        }
    }

    private generateWelcomeMessage(data: Partial<UserProfile>): string {
        const name = data.name || 'amigo';
        const style = data.response_style === 'concise' ? 'conciso e direto' : data.response_style === 'detailed' ? 'detalhado e explicativo' : 'adaptativo';
        const autonomy = data.autonomy_level === 'conservative' ? 'sempre pergunto antes' : data.autonomy_level === 'confident' ? 'executo e aviso' : 'balanceado';

        return `✅ *Tudo pronto, ${name}!*\n\nAqui está o resumo:\n• 🎨 Estilo: ${style}\n• ⚡ Autonomia: ${autonomy}\n• 🧠 Memória: ativada (aprendo com nossas conversas)\n• 🌐 Idioma: ${data.language_preference === 'english-tech' ? 'Inglês técnico' : 'Português'}\n\nEstou pronto para ajudar! Pode me perguntar qualquer coisa. 🚀`;
    }

    /**
     * Reset onboarding (for testing or re-setup)
     */
    resetOnboarding(userId: string): void {
        this.db.prepare('UPDATE user_profile SET onboarding_completed = 0 WHERE user_id = ?').run(userId);
        this.states.delete(userId);
    }

    getOnboardingState(userId: string): OnboardingState | undefined {
        return this.states.get(userId);
    }
}