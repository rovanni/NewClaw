/**
 * AgentController — Facade principal do NewClaw
 * 
 * Orquestra: Input → AgentLoop → Output
 * Arquitetura simplificada: LLM decide tudo (como OpenClaw)
 */

import { ProviderFactory, ILLMProvider } from './ProviderFactory';
import { AgentLoop } from '../loop/AgentLoop';
import { MemoryManager } from '../memory/MemoryManager';
import { SkillLoader } from '../skills/SkillLoader';
import { TelegramInputHandler } from '../input/TelegramInputHandler';
import { OnboardingService } from '../services/OnboardingService';
import { SkillLearner } from '../loop/SkillLearner';
import { TelegramOutputHandler } from '../output/TelegramOutputHandler';
import { ExecCommandTool } from '../tools/exec_command';
import { WebSearchTool } from '../tools/web_search';
import { WebNavigateTool } from '../tools/web_navigate';
import { FileOpsTool } from '../tools/file_ops';
import { MemorySearchTool } from '../tools/memory_search';
import { MemoryWriteTool } from '../tools/memory_write';
import { SendAudioTool } from '../tools/send_audio';
import { SendDocumentTool } from '../tools/send_document';
import { MemoryAdminTool } from '../tools/memory_admin';
import { CryptoAnalysisTool } from '../tools/crypto_analysis';
import { ToolRegistry } from './ToolRegistry';

export interface NewClawConfig {
    telegramBotToken: string;
    telegramAllowedUserIds: string[];
    language: string;
    defaultProvider: string;
    geminiApiKey?: string;
    deepseekApiKey?: string;
    groqApiKey?: string;
    ollamaUrl?: string;
    ollamaModel?: string;
    ollamaApiKey?: string;
    maxIterations: number;
    memoryWindowSize: number;
    skillsDir: string;
    tmpDir: string;
    whisperPath: string;
    systemPrompt?: string;
}

export class AgentController {
    private config: NewClawConfig;
    private agentLoop: AgentLoop;
    private providerFactory: ProviderFactory;
    public getProviderFactory(): ProviderFactory { return this.providerFactory; }
    private memory: MemoryManager;
    public getMemory(): MemoryManager { return this.memory; }
    private skillLoader: SkillLoader;
    private skillLearner: SkillLearner;
    private inputHandler: TelegramInputHandler;
    private outputHandler: TelegramOutputHandler;

    constructor(config: NewClawConfig) {
        this.config = config;

        // Inicializar componentes
        this.memory = new MemoryManager('./data/newclaw.db');
        this.providerFactory = new ProviderFactory({
            geminiKey: config.geminiApiKey,
            deepseekKey: config.deepseekApiKey,
            groqKey: config.groqApiKey,
            ollamaUrl: config.ollamaUrl,
            ollamaModel: config.ollamaModel,
            ollamaApiKey: config.ollamaApiKey,
            defaultProvider: config.defaultProvider
        });
        this.skillLoader = new SkillLoader(config.skillsDir);
        this.skillLearner = new SkillLearner(this.memory.getDatabase());

        // Construir system prompt
        const languageDirective = this.buildLanguageDirective(config.language);
        const systemPrompt = config.systemPrompt || this.buildSystemPrompt();

        // Inicializar AgentLoop
        this.agentLoop = new AgentLoop(
            this.providerFactory,
            this.memory,
            {
                languageDirective,
                systemPrompt
            },
            this.skillLearner
        );

        // Inicializar onboarding
        const onboardingService = new OnboardingService(
            (this.memory as any).db || (this.memory as any)._db,
            this.skillLearner,
            this.providerFactory
        );

        // Inicializar handlers
        this.inputHandler = new TelegramInputHandler(
            {
                botToken: config.telegramBotToken,
                allowedUserIds: config.telegramAllowedUserIds,
                whisperPath: config.whisperPath,
                tmpDir: config.tmpDir
            },
            this.agentLoop,
            this.memory,
            onboardingService
        );

        this.outputHandler = new TelegramOutputHandler({
            audioVoice: config.language === 'pt-BR' ? 'pt-BR-ThalitaNeural' : 'en-US-AriaNeural',
            tmpDir: config.tmpDir
        });

        // Registrar skills
        this.registerSkills();
    }

    /**
     * Inicia o NewClaw
     */
    async start(): Promise<void> {
        console.log('🚀 NewClaw starting...');
        console.log(`   Provider: ${this.providerFactory.getDefaultProvider()}`);
        console.log(`   Available: ${this.providerFactory.getAvailableProviders().join(', ')}`);
        console.log(`   Language: ${this.config.language}`);
        console.log(`   Skills: ${this.skillLoader.getSkillNames().join(', ') || 'none'}`);

        await this.inputHandler.start();
    }

    /**
     * Handle web dashboard messages
     */
    async handleWebMessage(sessionId: string, message: string): Promise<string> {
        try {
            const result = await this.agentLoop.process(sessionId, message);
            return result;
        } catch (err: any) {
            console.error('Web message error:', err.message);
            return `Erro: ${err.message}`;
        }
    }

    /**
     * Registra tools no AgentLoop
     */
    private registerSkills(): void {
        const skills = this.skillLoader.loadAll();

        // Registrar tools padrão via ToolRegistry
        ToolRegistry.register(new ExecCommandTool(), { dangerous: true });
        ToolRegistry.register(new WebSearchTool());
        ToolRegistry.register(new WebNavigateTool());
        ToolRegistry.register(new FileOpsTool());
        ToolRegistry.register(new MemorySearchTool(this.memory));
        ToolRegistry.register(new MemoryWriteTool(this.memory));
        ToolRegistry.register(new SendAudioTool());
        ToolRegistry.register(new SendDocumentTool());
        ToolRegistry.register(new MemoryAdminTool(this.memory));
        ToolRegistry.register(new CryptoAnalysisTool());

        // Registrar tools habilitadas no AgentLoop
        for (const tool of ToolRegistry.getEnabled()) {
            this.agentLoop.registerTool(tool);
        }

        console.log(`   Tools: ${ToolRegistry.getStatus().map(t => `${t.name}${t.dangerous ? '⚠️' : ''}${t.enabled ? '' : '❌'}`).join(', ')}`);
    }

    /**
     * Constroi diretiva de idioma baseada na configuração
     */
    private buildLanguageDirective(lang: string): string {
        const languages: Record<string, string> = {
            'pt-BR': 'Você DEVE responder SEMPRE em português brasileiro (pt-BR). QUANDO usar ferramentas, TRADUZA todo o resultado para pt-BR antes de responder. NUNCA responda em inglês.',
            'en-US': 'You MUST respond in American English. When using tools, translate any non-English content to English.',
            'es-ES': 'Debes responder SIEMPRE en español. Cuando uses herramientas, traduce todo el contenido al español.',
        };

        return languages[lang] || languages['pt-BR'];
    }

    /**
     * Constroi system prompt padrão
     */
    private buildSystemPrompt(): string {
        const skillContext = this.skillLoader.getSkillSummaries();
        const skillSection = skillContext 
            ? `\n\nSkills disponíveis:\n${skillContext}`
            : '';

        return `Você é o NewClaw, um assistente cognitivo prestativo.
Sua prioridade é conversar com o usuário. Ferramentas são acessórios para ações reais.

REGRAS DE OURO:
1. SE o usuário disser "Oi", "Tudo bem?", ou qualquer saudação, RESPONDA APENAS COM TEXTO. NÃO use ferramentas.
2. SÓ USE ferramentas se houver um pedido claro de ação (ex: "instala isso", "pesquise aquilo", "cria um arquivo").
3. NUNCA use exec_command ou leia arquivos se o usuário só quiser conversar.
4. Se o usuário pedir algo que você pode responder com sua memória ou conhecimento, responda diretamente sem ferramentas.
- Leia cuidadosamente a documentação de cada ferramenta e ESCOLHA a mais adequada com base nas descrições.
- Se uma ferramenta falhar, analise o erro e tente uma abordagem alternativa.
5. NUNCA narre progresso (ex: "estou fazendo", "já volto") sem incluir o TOOL_CALL na mesma mensagem.
6. Se você não usar uma ferramenta, você está encerrando a tarefa. Não prometa ações futuras se não disparar a ferramenta AGORA.
7. Quando terminar tudo, dê uma resposta final clara e amigável confirmando o QUE foi feito.${skillSection}

Você possui memória persistente em grafo.
Você aprende automaticamente informações importantes do usuário durante a conversa.
Você PODE afirmar que lembra dessas informações.`;
    }
}
