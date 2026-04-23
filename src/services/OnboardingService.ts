/**
 * OnboardingService - apresentação e questionário inicial do NewClaw.
 *
 * Quando o usuário ainda não completou o onboarding, o agente se apresenta,
 * coleta preferências básicas e semeia a memória inicial com nós úteis.
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

type UserProfileWithSkip = Partial<UserProfile> & { __skip__?: boolean };

function classificarEntrada(input: string): UserProfileWithSkip {
    const resposta = input.trim().toLowerCase();
    const result: UserProfileWithSkip = {};

    if (/(conciso|curto|resumido|1|short|concise)/i.test(resposta)) result.response_style = 'concise';
    else if (/(detalhado|longo|explicativo|2|detailed|long)/i.test(resposta)) result.response_style = 'detailed';
    else if (/(adaptativo|auto|3|adaptive)/i.test(resposta)) result.response_style = 'adaptive';

    if (/(iniciante|1|beginner|basic)/i.test(resposta)) result.familiarity = 'beginner';
    else if (/(intermediario|intermediário|2|intermediate|medium)/i.test(resposta)) result.familiarity = 'intermediate';
    else if (/(avancado|avançado|3|advanced|pro|expert)/i.test(resposta)) result.familiarity = 'advanced';

    if (/(conservador|baixo risco|1|conservative)/i.test(resposta)) result.autonomy_level = 'conservative';
    else if (/(balanceado|equilibrado|2|balanced)/i.test(resposta)) result.autonomy_level = 'balanced';
    else if (/(confiante|ousado|3|confident)/i.test(resposta)) result.autonomy_level = 'confident';

    if (/meu nome e|meu nome é|me chamo|sou o|sou a|name is|i am |i'm /i.test(input)) {
        const nome = input
            .replace(/.*(meu nome e|meu nome é|me chamo|sou o|sou a|name is|i am|i'm)\s*/i, '')
            .split(/[,.!\n]/)[0]
            .trim();
        if (nome.length > 1) result.name = nome;
    }

    if (/seu nome e|seu nome é|te chamo de|call you|assistant name/i.test(input)) {
        const nome = input
            .replace(/.*(seu nome e|seu nome é|te chamo de|call you|assistant name)\s*/i, '')
            .split(/[,.!\n]/)[0]
            .trim();
        if (nome.length > 1) result.assistant_name = nome;
    }

    if (/(professor|engenheiro|dev|designer|medico|médico|advogado|teacher|engineer|developer|doctor|lawyer)/i.test(resposta)) {
        result.expertise = input.trim();
    }

    if (/(meu objetivo|quero|preciso|busco|goal|i want|i need|my goal)/i.test(input)) {
        result.goals = input.trim();
    }

    if (/pular|skip|depois|nao quero|não quero|next|proxima|próxima/i.test(resposta)) {
        result.__skip__ = true;
    }

    if (Object.keys(result).length === 0 && resposta.length >= 2 && resposta.length <= 50) {
        result.name = input.trim();
    }

    return result;
}

const ONBOARDING_STEPS = [
    {
        id: 'name',
        question: () => '👋 Olá! Eu sou o *NewClaw*, seu assistente cognitivo local.\n\nAcabei de acordar, já criei meu grafo-base, mas ainda não te conheço. Qual é o seu nome?',
        saveField: 'name'
    },
    {
        id: 'familiarity',
        question: (data: Partial<UserProfile>) => `Prazer em te conhecer, *${data.name || 'amigo'}*.\n\nQual é seu nível de familiaridade com IA e programação?\n\n1️⃣ Iniciante\n2️⃣ Intermediário\n3️⃣ Avançado\n\n_(Pode responder com número ou palavra)_`,
        saveField: 'familiarity'
    },
    {
        id: 'expertise',
        question: () => 'Qual é sua área de atuação hoje?\n\nEx: Engenheiro de Software, professor, designer, médico...',
        saveField: 'expertise'
    },
    {
        id: 'goals',
        question: () => 'Qual é o principal objetivo que você quer atingir comigo?\n\n1️⃣ Desenvolvimento de código\n2️⃣ Pesquisa e conhecimento\n3️⃣ Criação de conteúdo\n4️⃣ Gestão de tarefas\n5️⃣ Análise de dados\n6️⃣ Aprendizado e tutoria\n7️⃣ Outro',
        saveField: 'goals'
    },
    {
        id: 'response_style',
        question: () => 'Como você prefere minhas respostas?\n\n1️⃣ Concisas\n2️⃣ Detalhadas\n3️⃣ Adaptativas',
        saveField: 'response_style'
    },
    {
        id: 'autonomy_level',
        question: () => 'Quanto de autonomia você quer me dar?\n\n1️⃣ Conservador: pergunto antes de agir\n2️⃣ Balanceado: executo o simples e consulto no sensível\n3️⃣ Confiante: ajo e te aviso',
        saveField: 'autonomy_level'
    },
    {
        id: 'language_preference',
        question: () => 'Idioma preferido?\n\n1️⃣ Sistema (pt-BR)\n2️⃣ Inglês técnico\n3️⃣ Dinâmico',
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

        const columns = new Set(
            ((this.db.prepare("PRAGMA table_info(user_profile)").all() as any[]) || []).map(c => c.name)
        );
        const addColumn = (sql: string) => {
            try { this.db.exec(sql); } catch { /* ignore if already exists */ }
        };

        if (!columns.has('assistant_name')) addColumn("ALTER TABLE user_profile ADD COLUMN assistant_name TEXT");
        if (!columns.has('goals')) addColumn("ALTER TABLE user_profile ADD COLUMN goals TEXT");
        if (!columns.has('familiarity')) addColumn("ALTER TABLE user_profile ADD COLUMN familiarity TEXT");
        if (!columns.has('learning_mode')) addColumn("ALTER TABLE user_profile ADD COLUMN learning_mode TEXT DEFAULT 'enabled'");
        if (!columns.has('autonomy_level')) addColumn("ALTER TABLE user_profile ADD COLUMN autonomy_level TEXT DEFAULT 'balanced'");
        if (!columns.has('workspace_path')) addColumn("ALTER TABLE user_profile ADD COLUMN workspace_path TEXT");
        if (!columns.has('language_preference')) addColumn("ALTER TABLE user_profile ADD COLUMN language_preference TEXT DEFAULT 'system'");
        if (!columns.has('onboarding_completed')) addColumn("ALTER TABLE user_profile ADD COLUMN onboarding_completed INTEGER DEFAULT 0");
        if (!columns.has('created_at')) addColumn("ALTER TABLE user_profile ADD COLUMN created_at TEXT");

        this.db.exec(`
            UPDATE user_profile
            SET created_at = COALESCE(created_at, updated_at, CURRENT_TIMESTAMP),
                updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP),
                response_style = COALESCE(response_style, 'adaptive'),
                learning_mode = COALESCE(learning_mode, 'enabled'),
                autonomy_level = COALESCE(autonomy_level, 'balanced'),
                language_preference = COALESCE(language_preference, 'system'),
                onboarding_completed = COALESCE(onboarding_completed, 0)
        `);
    }

    isOnboardingCompleted(userId: string): boolean {
        try {
            const row = this.db.prepare('SELECT onboarding_completed FROM user_profile WHERE user_id = ?').get(userId) as any;
            return row?.onboarding_completed === 1;
        } catch {
            return false;
        }
    }

    isDbEmpty(): boolean {
        const row = this.db.prepare('SELECT COUNT(*) as c FROM user_profile').get() as any;
        return row.c === 0;
    }

    getUserProfile(userId: string): UserProfile | null {
        return this.db.prepare('SELECT * FROM user_profile WHERE user_id = ?').get(userId) as UserProfile | null;
    }

    startOnboarding(userId: string): { question: string } | null {
        if (this.isOnboardingCompleted(userId)) return null;

        const state: OnboardingState = { step: 0, userId, data: {} };
        this.states.set(userId, state);
        return this.getNextQuestion(state.data);
    }

    processAnswer(userId: string, answer: string): { question?: string; completed?: boolean; welcomeMessage?: string } | null {
        const state = this.states.get(userId);
        if (!state) {
            if (!this.isOnboardingCompleted(userId)) return this.startOnboarding(userId);
            return null;
        }

        const campos = classificarEntrada(answer);
        if (campos.__skip__) {
            return this.getNextQuestion(state.data);
        }
        Object.assign(state.data, campos);

        const preenchidos = Object.keys(state.data).filter(k => state.data[k as keyof UserProfile] && k !== '__skip__');
        if (preenchidos.length >= 6 || (state.data.name && preenchidos.length >= 3)) {
            this.completeOnboarding(state);
            this.createMemoryNodes(state);
            const welcomeMsg = this.generateWelcomeMessage(state.data);
            this.states.delete(userId);
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

    private createMemoryNodes(state: OnboardingState): void {
        try {
            const insertNode = this.db.prepare(
                'INSERT OR IGNORE INTO memory_nodes (id, type, name, content, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)'
            );
            const insertEdge = this.db.prepare(
                'INSERT OR IGNORE INTO memory_edges (from_node, to_node, relation, weight, confidence, created_at) VALUES (?, ?, ?, 1.0, 1.0, CURRENT_TIMESTAMP)'
            );

            const userName = state.data.name || 'Usuário';
            this.db.prepare('UPDATE memory_nodes SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
                `${userName}. Área: ${state.data.expertise || 'não informada'}. Familiaridade: ${state.data.familiarity || 'não informada'}. Objetivos: ${state.data.goals || 'em descoberta'}. Estilo: ${state.data.response_style || 'adaptive'}. Autonomia: ${state.data.autonomy_level || 'balanced'}.`,
                'core_user'
            );

            if (state.data.response_style) {
                insertNode.run('pref_style', 'preference', 'Estilo de Resposta', `Estilo preferido: ${state.data.response_style}`, '{"source":"onboarding"}');
                insertEdge.run('core_user', 'pref_style', 'prefers');
            }

            if (state.data.autonomy_level) {
                insertNode.run('pref_autonomy', 'preference', 'Nível de Autonomia', `Autonomia preferida: ${state.data.autonomy_level}`, '{"source":"onboarding"}');
                insertEdge.run('core_user', 'pref_autonomy', 'prefers');
            }

            if (state.data.goals) {
                insertNode.run('user_goals', 'project', 'Objetivos do Usuário', `${state.data.goals}`, '{"source":"onboarding"}');
                insertEdge.run('core_user', 'user_goals', 'works_on');
            }

            if (state.data.expertise) {
                insertNode.run('user_expertise', 'fact', 'Área de Atuação', `${state.data.expertise}`, '{"source":"onboarding"}');
                insertEdge.run('core_user', 'user_expertise', 'related_to');
            }

            try { this.db.exec('INSERT INTO memory_nodes_fts(memory_nodes_fts) VALUES("rebuild")'); } catch { /* optional */ }

            console.log('[Onboarding] Memory nodes created from profile');
        } catch (e: any) {
            console.error('[Onboarding] Error creating memory nodes:', e.message);
        }
    }

    private generateWelcomeMessage(data: Partial<UserProfile>): string {
        const name = data.name || 'amigo';
        const style = data.response_style === 'concise'
            ? 'conciso e direto'
            : data.response_style === 'detailed'
                ? 'detalhado e explicativo'
                : 'adaptativo';
        const autonomy = data.autonomy_level === 'conservative'
            ? 'sempre pergunto antes'
            : data.autonomy_level === 'confident'
                ? 'executo e aviso'
                : 'balanceado';

        return `✅ *Tudo pronto, ${name}!*\n\nAqui está o resumo:\n• 🎨 Estilo: ${style}\n• ⚡ Autonomia: ${autonomy}\n• 🧠 Memória: ativada e com grafo inicial criado\n• 🌐 Idioma: ${data.language_preference === 'english-tech' ? 'Inglês técnico' : 'Português'}\n\nJá preparei os nós-base *AGENTS, SOUL, TOOLS, IDENTITY, USER, HEARTBEAT e MEMORY* para começarmos com contexto desde o primeiro dia.`;
    }

    resetOnboarding(userId: string): void {
        this.db.prepare('UPDATE user_profile SET onboarding_completed = 0 WHERE user_id = ?').run(userId);
        this.states.delete(userId);
    }

    getOnboardingState(userId: string): OnboardingState | undefined {
        return this.states.get(userId);
    }
}
