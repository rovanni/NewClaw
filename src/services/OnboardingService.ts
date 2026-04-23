/**
 * OnboardingService - apresentação e questionário inicial do NewClaw.
 * 
 * Transformado em fluxo dinâmico com classificação de intenção via LLM.
 */
import { Database } from 'better-sqlite3';
import { ProviderFactory } from '../core/ProviderFactory';
import { SkillLearner } from '../loop/SkillLearner';
import { AgentStateManager } from '../core/AgentStateManager';

export interface UserProfile {
    user_id: string;
    name: string | null;
    intent: 'automation' | 'study' | 'projects' | 'curiosity' | 'general' | null;
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

function classificarEntradaHeuristica(input: string): UserProfileWithSkip {
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

    if (Object.keys(result).length === 0 && resposta.length >= 2 && resposta.length <= 50) {
        result.name = input.trim();
    }

    return result;
}

const ONBOARDING_STEPS = [
    {
        id: 'name',
        question: (_data: Partial<UserProfile>) => '👋 Olá! Eu sou o *NewClaw*, seu assistente cognitivo local.\n\nJá inicializei minha memória e estrutura cognitiva. Quero entender como posso ser mais útil pra você.\n\nPara começar, qual é o seu nome?',
        saveField: 'name'
    },
    {
        id: 'intent',
        question: (data: Partial<UserProfile>) => `Prazer em te conhecer, *${data.name || 'amigo'}*!\n\nO que te traz ao NewClaw hoje? O que você busca realizar?\n\n_(Ex: automatizar tarefas, estudar algo novo, gerenciar projetos, curiosidade...)_`,
        saveField: 'intent'
    }
];

export class OnboardingService {
    private db: Database;
    private skillLearner: SkillLearner;
    private providerFactory: ProviderFactory;
    private stateManager: AgentStateManager;
    private states: Map<string, OnboardingState> = new Map();

    constructor(db: Database, skillLearner: SkillLearner, providerFactory: ProviderFactory, stateManager: AgentStateManager) {
        this.db = db;
        this.skillLearner = skillLearner;
        this.providerFactory = providerFactory;
        this.stateManager = stateManager;
        this.ensureTable();
    }

    private ensureTable(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS user_profile (
                user_id TEXT PRIMARY KEY,
                name TEXT,
                intent TEXT,
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
        const addColumn = (sql: string) => { try { this.db.exec(sql); } catch { } };

        if (!columns.has('intent')) addColumn("ALTER TABLE user_profile ADD COLUMN intent TEXT");
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

    isOnboardingRequired(userId: string): boolean {
        try {
            const profile = this.getUserProfile(userId);
            
            if (!profile) {
                console.log(`[DEBUG-ONBOARDING] No profile found for ${userId}. Onboarding required.`);
                return true;
            }

            if (profile.onboarding_completed !== 1) {
                console.log(`[DEBUG-ONBOARDING] Profile exists but onboarding not completed for ${userId}.`);
                return true;
            }

            // Strict check for essential fields
            const missingFields = [];
            if (!profile.name) missingFields.push('name');
            if (!profile.intent) missingFields.push('intent');
            if (!profile.response_style) missingFields.push('response_style');
            if (!profile.autonomy_level) missingFields.push('autonomy_level');
            
            if (missingFields.length > 0) {
                console.log(`[DEBUG-ONBOARDING] Missing essential fields for ${userId}: ${missingFields.join(', ')}. Onboarding required.`);
                return true;
            }

            return false;
        } catch (e: any) {
            console.error(`[DEBUG-ONBOARDING] Error checking onboarding status: ${e.message}`);
            return true; // Safe fallback
        }
    }

    isOnboardingCompleted(userId: string): boolean {
        return !this.isOnboardingRequired(userId);
    }

    getUserProfile(userId: string): UserProfile | null {
        return this.db.prepare('SELECT * FROM user_profile WHERE user_id = ?').get(userId) as UserProfile | null;
    }

    startOnboarding(userId: string): { question: string } | null {
        if (this.isOnboardingCompleted(userId)) return null;
        const state: OnboardingState = { step: 0, userId, data: {} };
        this.states.set(userId, state);
        return { question: ONBOARDING_STEPS[0].question(state.data) };
    }

    async processAnswer(userId: string, answer: string): Promise<{ question?: string; completed?: boolean; welcomeMessage?: string } | null> {
        const state = this.states.get(userId);
        if (!state) return this.startOnboarding(userId);

        if (!state.data.name) {
            const fields = classificarEntradaHeuristica(answer);
            state.data.name = fields.name || answer.trim();
            return { question: ONBOARDING_STEPS[1].question(state.data) };
        }

        if (!state.data.intent) {
            state.data.intent = await this.classifyUserIntent(answer);
            state.data.goals = answer.trim();
            // Ir para a próxima pergunta adaptativa
            const next = this.getNextAdaptiveQuestion(state.data);
            if (next === true) {
                this.completeOnboarding(state);
                this.createMemoryNodes(state);
                this.stateManager.initializeAfterOnboarding(state.data.intent || 'general');
                this.skillLearner.observe('user_onboarding_completed', { userId, intent: state.data.intent });
                this.states.delete(userId);
                return { completed: true, welcomeMessage: this.generateWelcomeMessage(state.data) };
            }
            return { question: next };
        }

        // Processar respostas adaptativas ou finais
        const fields = classificarEntradaHeuristica(answer);
        Object.assign(state.data, fields);
        
        // Se a heurística não pegou expertise mas era o que esperávamos
        if (!state.data.expertise && !state.data.response_style) {
            state.data.expertise = answer.trim();
        }

        const next = this.getNextAdaptiveQuestion(state.data);
        if (typeof next === 'string') {
            return { question: next };
        } else {
            this.completeOnboarding(state);
            this.createMemoryNodes(state);
            this.stateManager.initializeAfterOnboarding(state.data.intent || 'general');
            this.skillLearner.observe('user_onboarding_completed', { userId, intent: state.data.intent });
            this.states.delete(userId);
            return { completed: true, welcomeMessage: this.generateWelcomeMessage(state.data) };
        }
    }

    private async classifyUserIntent(text: string): Promise<UserProfile['intent']> {
        const prompt = `Analise a intenção do usuário e retorne APENAS uma das palavras: automation, study, projects, curiosity ou general.
Mensagem: "${text}"`;
        try {
            const response = await this.providerFactory.chatWithFallback([
                { role: 'system', content: 'Você é um classificador de intenções rápido e preciso.' },
                { role: 'user', content: prompt }
            ], []);
            const content = (response.content || '').toLowerCase();
            if (content.includes('automation')) return 'automation';
            if (content.includes('study')) return 'study';
            if (content.includes('projects')) return 'projects';
            if (content.includes('curiosity')) return 'curiosity';
            return 'general';
        } catch {
            return 'general';
        }
    }

    private getNextAdaptiveQuestion(data: Partial<UserProfile>): string | true {
        if (!data.expertise) {
            if (data.intent === 'automation') return 'Legal, automação! Quais ferramentas ou linguagens você costuma usar? E qual seu nível técnico?';
            if (data.intent === 'study') return 'Foco em estudo! Qual área você quer explorar comigo e qual seu nível atual nela?';
            if (data.intent === 'projects') return 'Projetos! Em qual projeto você está trabalhando agora e qual o seu papel nele?';
            return 'Qual é sua área de atuação ou especialidade principal hoje?';
        }

        if (!data.response_style) {
            return 'Como você prefere minhas respostas?\n\n1️⃣ Concisas\n2️⃣ Detalhadas\n3️⃣ Adaptativas';
        }

        if (!data.autonomy_level) {
            return 'Quanta autonomia posso ter?\n\n1️⃣ Conservador: pergunto antes de agir\n2️⃣ Balanceado: executo o simples e consulto no sensível\n3️⃣ Confiante: ajo e te aviso';
        }

        return true;
    }

    private completeOnboarding(state: OnboardingState): void {
        const now = new Date().toISOString();
        this.db.prepare(`
            INSERT OR REPLACE INTO user_profile
            (user_id, name, intent, expertise, goals, response_style, autonomy_level, onboarding_completed, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `).run(
            state.userId,
            state.data.name || 'Usuário',
            state.data.intent || 'general',
            state.data.expertise || null,
            state.data.goals || null,
            state.data.response_style || 'adaptive',
            state.data.autonomy_level || 'balanced',
            now,
            now
        );
    }

    private createMemoryNodes(state: OnboardingState): void {
        try {
            const insertNode = this.db.prepare(`
                INSERT OR REPLACE INTO memory_nodes 
                (id, type, name, content, metadata, weight, confidence, last_updated, updated_at) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `);
            const insertEdge = this.db.prepare('INSERT OR REPLACE INTO memory_edges (from_node, to_node, relation, weight, confidence) VALUES (?, ?, ?, 1.0, 1.0)');

            const data = state.data;
            const userName = data.name || 'Usuário';
            const now = new Date().toISOString();
            
            // Use the new explicit method for name persistence
            this.stateManager.memory.setUserName(state.userId, userName);

            if (data.response_style) {
                insertNode.run('pref_style', 'preference', 'Estilo de Resposta', `Preferência: ${data.response_style}`, '{}', 1.0, 0.9, now);
                insertEdge.run('core_user', 'pref_style', 'has_preference');
            }
            if (data.autonomy_level) {
                insertNode.run('pref_autonomy', 'preference', 'Autonomia', `Preferência: ${data.autonomy_level}`, '{}', 1.0, 0.9, now);
                insertEdge.run('core_user', 'pref_autonomy', 'has_preference');
            }
            if (data.goals) {
                insertNode.run('user_goals', 'project', 'Metas do Usuário', data.goals, '{}', 1.0, 0.8, now);
                insertEdge.run('core_user', 'user_goals', 'has_goal');
            }
            if (data.expertise) {
                insertNode.run('user_expertise', 'fact', 'Perfil Técnico', data.expertise, '{}', 1.0, 0.8, now);
                insertEdge.run('core_user', 'user_expertise', 'has_trait');
            }

            console.log('[Onboarding] Memory nodes created with semantic connections');
        } catch (e: any) {
            console.error('[Onboarding] Error creating memory nodes:', e.message);
        }
    }

    private generateWelcomeMessage(data: Partial<UserProfile>): string {
        const name = data.name || 'amigo';
        const intentMap: any = {
            automation: 'impulsionar sua automação',
            study: 'acelerar seu aprendizado',
            projects: 'gerenciar seus projetos',
            curiosity: 'explorar novas fronteiras',
            general: 'te ajudar no dia a dia'
        };
        const intentText = intentMap[data.intent || 'general'];

        return `✅ *Tudo pronto, ${name}!* \n\nJá configurei minha memória e estrutura cognitiva com base no seu perfil. Estou pronto para *${intentText}*.\n\nComo podemos começar hoje?`;
    }

    getOnboardingState(userId: string): OnboardingState | undefined {
        return this.states.get(userId);
    }

    async handle(userId: string, text: string): Promise<{ response: string; completed: boolean }> {
        console.log(`[DEBUG-ONBOARDING] Handling message for ${userId}: "${text.slice(0, 20)}..."`);
        const state = this.getOnboardingState(userId);
        
        if (!state) {
            console.log(`[DEBUG-ONBOARDING] No active state for ${userId}, starting...`);
            const first = this.startOnboarding(userId);
            return { response: first?.question || 'Erro ao iniciar onboarding.', completed: false };
        }

        const result = await this.processAnswer(userId, text);
        if (result?.completed) {
            console.log(`[DEBUG-ONBOARDING] Onboarding completed for ${userId}.`);
            return { response: result.welcomeMessage || 'Onboarding concluído!', completed: true };
        }
        
        console.log(`[DEBUG-ONBOARDING] Next question for ${userId} generated.`);
        return { response: result?.question || 'Erro ao processar resposta.', completed: false };
    }
}
