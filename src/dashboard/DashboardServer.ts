/**
 * NewClaw DashboardServer — Web Dashboard para o NewClaw
 * Adaptado do IALClaw Dashboard
 *
 * Features:
 * - Chat web
 * - Config editor (model, voice, system prompt)
 * - Real-time logs (SSE)
 * - Skill management
 */

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import { Server } from 'http';
import { AgentController, NewClawConfig } from '../core/AgentController';
import { ProviderFactory } from '../core/ProviderFactory';
import { ModelRegistryService } from '../core/ModelRegistryService';
import { MemoryManager } from '../memory/MemoryManager';
import { MemoryCurator } from '../memory/MemoryCurator';
import { SkillInstaller } from '../skills/SkillInstaller';
import type { SkillLearner } from '../loop/SkillLearner';
import { createLogger } from '../shared/AppLogger';
import { authMiddleware, createAuthRouter, dashboardAuth, initAuthPersistence } from './routes/auth';
import { rateLimitMiddleware, loginRateLimit, csrfOriginCheck } from './security';
import { createConfigRouter } from './routes/config';
import { createProvidersRouter } from './routes/providers';
import { createModelsRouter } from './routes/models';
import { createSkillsRouter } from './routes/skills';
import { createToolsRouter } from './routes/tools';
import { createStatusRouter, healthHandler } from './routes/status';
import { createChatRouter } from './routes/chat';
import { createTracesRouter, sseStreamHandler } from './routes/traces';
import { createMemoryRouter } from './routes/memory';
import { createConversationsRouter } from './routes/conversations';
import { createSystemRouter } from './routes/system';
import { createMaintenanceRouter } from './routes/maintenance';
import { createIntegrationsRouter } from './routes/integrations';
import { DashboardContext } from './routes/types';

const log = createLogger('Dashboardserver');

export class DashboardServer {
    private app: express.Express;
    private server?: Server;
    private ctx: DashboardContext;
    private ownsCurator = false;

    constructor(config: NewClawConfig) {
        this.ctx = { config };
        this.app = express();
        this.app.use(cors());
        this.app.use(express.json());
        this.app.use(cookieParser());

        this.app.use(authMiddleware);
        // Rate-limit + CSRF (CodeQL js/missing-rate-limiting, js/missing-token-validation — ver
        // src/dashboard/security.ts para o racional completo). Depois de authMiddleware (não
        // precisa proteger rotas 401 de qualquer forma) e antes de qualquer router — cobre tudo,
        // inclusive as páginas estáticas/health. loginRateLimit é mais estrito que o geral e
        // precisa ser registrado ANTES do router de /api/auth pra rodar primeiro nessa rota.
        this.app.use(rateLimitMiddleware);
        this.app.use(csrfOriginCheck);
        this.app.use('/api/auth/login', loginRateLimit);
        // redirect:false prevents 301 /config → /config/ (Express detects public/config/ directory)
        this.app.use(express.static(path.join(__dirname, 'public'), { redirect: false }));

        // Static pages
        this.app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
        this.app.get(['/config', '/config/'], (_req, res) => res.sendFile(path.join(__dirname, 'public', 'config.html')));
        this.app.get('/help', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'help.html')));
        this.app.get('/traces', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'traces.html')));
        this.app.get('/memory', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'memory.html')));
        this.app.get('/memory-graph', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'memory-graph.html')));
        this.app.get('/memory-review', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'memory-review.html')));

        // Health check at root level (not under /api — load balancer / watchdog friendly)
        const ctx = this.ctx;
        this.app.get('/health', healthHandler(ctx));

        // SSE stream at /api/stream
        this.app.get('/api/stream', sseStreamHandler);

        // API routers — all share `this.ctx` by reference so setter updates are visible at request time
        this.app.use('/api/auth', createAuthRouter());
        this.app.use('/api/config', createConfigRouter(ctx));
        this.app.use('/api', createProvidersRouter(ctx));   // handles /api/providers, /api/models/add, /api/ollama/*
        this.app.use('/api/models', createModelsRouter(ctx)); // handles /api/models/catalog
        this.app.use('/api/skills', createSkillsRouter(ctx));
        this.app.use('/api/tools', createToolsRouter());
        this.app.use('/api', createStatusRouter(ctx));       // handles /api/status, /api/restart
        this.app.use('/api/chat', createChatRouter(ctx));
        this.app.use('/api/traces', createTracesRouter());
        this.app.use('/api/memory', createMemoryRouter(ctx));
        this.app.use('/api/conversations', createConversationsRouter(ctx));
        this.app.use('/api/system', createSystemRouter(ctx));
        this.app.use('/api/maintenance', createMaintenanceRouter());
        this.app.use('/api/integrations', createIntegrationsRouter(ctx));
    }

    public setController(controller: AgentController) {
        this.ctx.controller = controller;
        this.ctx.ownerProfileService = controller.getOwnerProfileService();
    }

    public setProviderFactory(pf: ProviderFactory) {
        this.ctx.providerFactory = pf;
    }

    public setModelRegistryService(mrs: ModelRegistryService) {
        this.ctx.modelRegistryService = mrs;
    }

    public setSkillLearner(sl: SkillLearner): void {
        this.ctx.skillLearner = sl;
    }

    public setMemoryManager(mm: MemoryManager, curator?: MemoryCurator) {
        this.ctx.memoryManager = mm;
        this.ctx.memoryCurator = curator || new MemoryCurator(mm);
        initAuthPersistence(mm.getDatabase());
        this.ctx.embeddingService = mm.getEmbeddingService();
        this.ctx.classificationMemory = mm.getClassificationMemory();
        this.ctx.decisionMemory = mm.getDecisionMemory();
        this.ctx.skillInstaller = new SkillInstaller();

        // Only start auto-curate if curator was not provided (AgentController manages its own lifecycle)
        if (!curator) {
            this.ctx.memoryCurator.startAutoCurate(30 * 60 * 1000);
            this.ownsCurator = true;
        }
    }

    public start(port: number = 3090) {
        if (this.server) return;

        // Bind em 127.0.0.1 por padrão para evitar exposição em interfaces públicas.
        // Para expor em LAN/proxy reverso defina DASHBOARD_HOST=0.0.0.0 (e DASHBOARD_PASSWORD).
        const host = process.env.DASHBOARD_HOST || '127.0.0.1';

        if (host !== '127.0.0.1' && !dashboardAuth.enabled) {
            log.warn(`⚠️  Dashboard em ${host}:${port} SEM senha. Defina DASHBOARD_PASSWORD ou volte para DASHBOARD_HOST=127.0.0.1.`);
        }

        this.server = this.app.listen(port, host, () => {
            log.info(`NewClaw Dashboard rodando em http://${host}:${port}${dashboardAuth.enabled ? ' (auth ON)' : ' (auth OFF — somente localhost)'}`);
        });
    }

    public async stop(): Promise<void> {
        if (this.ownsCurator) {
            this.ctx.memoryCurator?.stopAutoCurate();
            this.ownsCurator = false;
        }

        if (!this.server) return;

        await new Promise<void>((resolve, reject) => {
            this.server?.close((error) => {
                if (error) reject(error);
                else resolve();
            });
        });

        this.server = undefined;
    }
}
