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
import { MemoryManager } from '../memory/MemoryManager';
import { MemoryCurator } from '../memory/MemoryCurator';
import { EmbeddingService } from '../memory/EmbeddingService';
import { ClassificationMemory } from '../memory/ClassificationMemory';
import { DecisionMemory } from '../memory/DecisionMemory';
import { SkillInstaller } from '../skills/SkillInstaller';
import { createLogger } from '../shared/AppLogger';
import { authMiddleware, createAuthRouter, dashboardAuth } from './routes/auth';
import { createConfigRouter } from './routes/config';
import { createProvidersRouter } from './routes/providers';
import { createSkillsRouter } from './routes/skills';
import { createToolsRouter } from './routes/tools';
import { createStatusRouter, healthHandler } from './routes/status';
import { createChatRouter } from './routes/chat';
import { createTracesRouter, sseStreamHandler } from './routes/traces';
import { createMemoryRouter } from './routes/memory';
import { createConversationsRouter } from './routes/conversations';
import { DashboardContext } from './routes/types';

const log = createLogger('Dashboardserver');

export class DashboardServer {
    private app: express.Express;
    private server?: Server;
    private ctx: DashboardContext;

    constructor(config: NewClawConfig) {
        this.ctx = { config };
        this.app = express();
        this.app.use(cors());
        this.app.use(express.json());
        this.app.use(cookieParser());

        this.app.use(authMiddleware);
        this.app.use(express.static(path.join(__dirname, 'public')));

        // Static pages
        this.app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
        this.app.get('/config', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'config.html')));
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
        this.app.use('/api/skills', createSkillsRouter(ctx));
        this.app.use('/api/tools', createToolsRouter());
        this.app.use('/api', createStatusRouter(ctx));       // handles /api/status, /api/restart
        this.app.use('/api/chat', createChatRouter(ctx));
        this.app.use('/api/traces', createTracesRouter());
        this.app.use('/api/memory', createMemoryRouter(ctx));
        this.app.use('/api/conversations', createConversationsRouter(ctx));
    }

    public setController(controller: AgentController) {
        this.ctx.controller = controller;
    }

    public setProviderFactory(pf: ProviderFactory) {
        this.ctx.providerFactory = pf;
    }

    public setMemoryManager(mm: MemoryManager, curator?: MemoryCurator) {
        this.ctx.memoryManager = mm;
        this.ctx.memoryCurator = curator || new MemoryCurator(mm);
        const db = mm.getDatabase();
        this.ctx.embeddingService = new EmbeddingService(db);
        this.ctx.classificationMemory = new ClassificationMemory(db);
        this.ctx.decisionMemory = new DecisionMemory(db);
        this.ctx.skillInstaller = new SkillInstaller();

        // Only start auto-curate if curator was not provided (AgentController manages its own lifecycle)
        if (!curator) {
            this.ctx.memoryCurator.startAutoCurate(30 * 60 * 1000);
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
