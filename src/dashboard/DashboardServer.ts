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

import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import crypto from 'crypto';
import { Server } from 'http';
import { AgentController, NewClawConfig } from '../core/AgentController';
import { ProviderFactory } from '../core/ProviderFactory';
import { traceManager } from '../core/ExecutionTrace';
import { ToolRegistry } from '../core/ToolRegistry';
import { MemoryManager, MemoryNode } from '../memory/MemoryManager';
import { MemoryCurator } from '../memory/MemoryCurator';
import { GraphAnalytics } from '../memory/GraphAnalytics';
import { EmbeddingService } from '../memory/EmbeddingService';
import { ClassificationMemory } from '../memory/ClassificationMemory';
import { DecisionMemory } from '../memory/DecisionMemory';
import { SkillInstaller } from '../skills/SkillInstaller';

// Simple token auth
const API_TOKENS: Set<string> = new Set();
let dashboardAuth: { enabled: boolean; password: string } = { enabled: false, password: '' };

function authMiddleware(req: Request, res: Response, next: express.NextFunction): void {
    if (!dashboardAuth.enabled) { next(); return; }
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    if (token && API_TOKENS.has(String(token))) { next(); return; }
    // Allow page loads
    if (req.path.endsWith('.html') || req.path === '/' || req.path === '/config' || req.path === '/help') { next(); return; }
    res.status(401).json({ error: 'Unauthorized' });
}

export class DashboardServer {
    private app: express.Express;
    private server?: Server;
    private controller?: AgentController;
    private providerFactory?: ProviderFactory;
    private memoryManager?: MemoryManager;
    private memoryCurator?: MemoryCurator;
    private graphAnalytics?: GraphAnalytics;
    private embeddingService?: EmbeddingService;
    private classificationMemory?: ClassificationMemory;
    private decisionMemory?: DecisionMemory;
    private skillInstaller?: SkillInstaller;
    private config: NewClawConfig;

    constructor(config: NewClawConfig) {
        this.config = config;
        this.app = express();
        this.app.use(cors());
        this.app.use(express.json());

        this.app.use(authMiddleware);

        // Serve static files
        this.app.use(express.static(path.join(__dirname, 'public')));

        // Routes
        this.app.get('/', (_req: Request, res: Response) => {
            res.sendFile(path.join(__dirname, 'public', 'index.html'));
        });

        this.app.get('/config', (_req: Request, res: Response) => {
            res.sendFile(path.join(__dirname, 'public', 'config.html'));
        });

        this.app.get('/help', (_req: Request, res: Response) => {
            res.sendFile(path.join(__dirname, 'public', 'help.html'));
        });

                this.app.get('/traces', (_req: Request, res: Response) => {
            res.sendFile(path.join(__dirname, 'public', 'traces.html'));
        });

        this.app.get('/memory', (_req: Request, res: Response) => {
            res.sendFile(path.join(__dirname, 'public', 'memory.html'));
        });

        this.app.get('/memory-graph', (_req: Request, res: Response) => {
            res.sendFile(path.join(__dirname, 'public', 'memory-graph.html'));
        });

        this.app.get('/memory-review', (_req: Request, res: Response) => {
            res.sendFile(path.join(__dirname, 'public', 'memory-review.html'));
        });

        // === API Routes ===

        // Get current config
        this.app.get('/api/config', (_req: Request, res: Response) => {
            const ollama = this.config.ollamaUrl ? this.providerFactory?.getOllamaProvider() : undefined;
            res.json({
                success: true,
                config: {
                    language: this.config.language,
                    defaultProvider: this.config.defaultProvider,
                    currentModel: this.providerFactory?.getCurrentModel() || this.config.ollamaModel || 'unknown',
                    maxIterations: this.config.maxIterations,
                    memoryWindowSize: this.config.memoryWindowSize,
                    whisperPath: this.config.whisperPath,
                    ollamaUrl: this.config.ollamaUrl,
                    ollamaModel: this.config.ollamaModel || ollama?.getModel() || 'glm-5.1:cloud',
                    ollamaApiKey: this.config.ollamaApiKey ? '••••' : '',
                    systemPrompt: this.config.systemPrompt || '',
                    telegramAllowedUserIds: this.config.telegramAllowedUserIds.join(','),
                    hasGeminiKey: !!this.config.geminiApiKey,
                    hasDeepseekKey: !!this.config.deepseekApiKey,
                    hasGroqKey: !!this.config.groqApiKey,
                    hasOllamaApiKey: !!this.config.ollamaApiKey,
                    modelRouter: this.config.modelRouter || {}
                }
            });
        });

        // Update config (runtime)
        this.app.post('/api/config', (req: Request, res: Response) => {
            const { language, defaultProvider, maxIterations, memoryWindowSize, systemPrompt, ollamaModel, ollamaApiKey, ollamaUrl, telegramAllowedUserIds, modelRouter } = req.body;

            console.log(`[CONFIG] POST /api/config — ollamaModel="${ollamaModel}" provider="${defaultProvider}"`);

            if (language) this.config.language = language;
            if (systemPrompt !== undefined) this.config.systemPrompt = systemPrompt;
            if (maxIterations) this.config.maxIterations = parseInt(String(maxIterations));
            if (memoryWindowSize) this.config.memoryWindowSize = parseInt(String(memoryWindowSize));

            // Update Telegram Whitelist
            if (telegramAllowedUserIds !== undefined) {
                this.config.telegramAllowedUserIds = String(telegramAllowedUserIds).split(',').map(id => id.trim()).filter(id => id);
                console.log(`[CONFIG] Telegram whitelist updated: ${this.config.telegramAllowedUserIds.join(', ')}`);
                console.log(`💡 Para gerenciar usuários autorizados e outras configurações, acesse o Dashboard em: http://localhost:${this.config.dashboardPort || 3090}/config`);
            }

            // Provider switch
            if (defaultProvider) {
                try {
                    this.providerFactory?.setDefaultProvider(defaultProvider);
                    this.config.defaultProvider = defaultProvider;
                    console.log(`[CONFIG] Provider switched to: ${defaultProvider}`);
                } catch (err: any) {
                    console.error(`[CONFIG] Provider switch failed: ${err.message}`);
                    return res.status(400).json({ success: false, error: err.message });
                }
            }

            // Ollama model switch (runtime!)
            if (ollamaModel) {
                const previousModel = this.config.ollamaModel;
                this.config.ollamaModel = ollamaModel;
                const ollama = this.providerFactory?.getOllamaProvider();
                if (ollama) {
                    ollama.setModel(ollamaModel);
                    console.log(`[CONFIG] Ollama model switched: ${previousModel} → ${ollamaModel}`);
                } else {
                    console.warn(`[CONFIG] Ollama provider not available for model switch`);
                }
            }

            // Ollama API key update
            // Ollama URL update
            if (ollamaUrl) {
                this.config.ollamaUrl = ollamaUrl;
                console.log(`[CONFIG] Ollama URL changed: ${ollamaUrl}`);
                // Update provider factory URL
                const ollama = this.providerFactory?.getOllamaProvider();
                if (ollama) ollama.setBaseUrl(ollamaUrl);
            }

            if (ollamaApiKey) {
                this.config.ollamaApiKey = ollamaApiKey;
            }

            if (modelRouter) {
                this.config.modelRouter = { ...(this.config.modelRouter || {}), ...modelRouter };
                console.log(`[CONFIG] ModelRouter updated: ${JSON.stringify(this.config.modelRouter)}`);
            }

            // Persist relevant config to .env so restart keeps the values
            this.persistConfigToEnv();

            // Also update AgentLoop config so system prompt and iterations take effect
            if (this.controller) {
                const loop = (this.controller as any).agentLoop;
                if (loop && typeof loop.updateConfig === 'function') {
                    loop.updateConfig({
                        maxIterations: this.config.maxIterations,
                        systemPrompt: this.config.systemPrompt || '',
                        modelRouter: this.config.modelRouter
                    });
                }
            }

            // Persist to .env for restart survival
            this.persistConfigToEnv();

            // Return safe config (no secrets)
            const safeConfig = {
                language: this.config.language,
                defaultProvider: this.config.defaultProvider,
                currentModel: this.providerFactory?.getCurrentModel() || this.config.ollamaModel,
                maxIterations: this.config.maxIterations,
                memoryWindowSize: this.config.memoryWindowSize,
                ollamaUrl: this.config.ollamaUrl,
                ollamaModel: this.config.ollamaModel,
                telegramAllowedUserIds: this.config.telegramAllowedUserIds.join(','),
                systemPrompt: this.config.systemPrompt || '',
                hasGeminiKey: !!this.config.geminiApiKey,
                hasDeepseekKey: !!this.config.deepseekApiKey,
                hasGroqKey: !!this.config.groqApiKey,
                hasOllamaApiKey: !!this.config.ollamaApiKey,
                modelRouter: this.config.modelRouter || {}
            };
            res.json({ success: true, config: safeConfig });
        });

        // Restart route
        this.app.post('/api/restart', (_req: Request, res: Response) => {
            console.log('🔄 Restart requested via Dashboard...');
            res.json({ success: true, message: 'Restarting NewClaw...' });
            setTimeout(() => { process.exit(0); }, 1000);
        });

        // Get available providers and models
        this.app.get('/api/providers', async (_req: Request, res: Response) => {
            let ollamaModels: string[] = [];
            try {
                const ollamaUrl = this.config.ollamaUrl || 'http://localhost:11434';
                const resp = await fetch(`${ollamaUrl}/api/tags`);
                if (resp.ok) {
                    const data = await resp.json() as any;
                    ollamaModels = (data.models || []).map((m: any) => m.name);
                }
            } catch {}

            const knownCloudModels = [
                'glm-5:cloud', 'glm-5.1:cloud', 'glm-4:cloud',
                'kimi-k2:cloud', 'kimi-k2.6:cloud',
                'deepseek-r1:cloud', 'deepseek-v3:cloud',
                'qwen3:cloud', 'qwen3-235b:cloud',
                'gemma4:cloud', 'gemma4:e4b',
                'llama4:cloud', 'llama4-maverick:cloud',
                'phi-4:cloud',
            ];

            const userModels: string[] = [];
            if (this.config.modelRouter) {
                const mr = this.config.modelRouter;
                [mr.chat, mr.code, mr.vision, mr.light, mr.analysis, mr.execution].forEach(m => {
                    if (m && m.trim()) userModels.push(m.trim());
                });
            }

            const currentModel = this.providerFactory?.getCurrentModel() || this.config.ollamaModel;
            if (currentModel) userModels.push(currentModel);

            const customModels: string[] = (this.config as any).customModels || [];

            const allModels = [...new Set([
                ...ollamaModels,
                ...knownCloudModels,
                ...userModels,
                ...customModels
            ])].sort();

            res.json({
                success: true,
                providers: {
                    gemini: { available: !!this.config.geminiApiKey, name: 'Google Gemini' },
                    deepseek: { available: !!this.config.deepseekApiKey, name: 'DeepSeek' },
                    groq: { available: !!this.config.groqApiKey, name: 'Groq' },
                    ollama: { available: true, name: 'Ollama (Local/Cloud)', url: this.config.ollamaUrl, models: allModels },
                },
                currentProvider: this.config.defaultProvider,
                currentModel: currentModel || 'unknown'
            });
        });

        // Add a custom model to the list
        this.app.post('/api/models/add', (req: Request, res: Response) => {
            const { model } = req.body;
            if (!model || !model.trim()) return res.status(400).json({ error: 'Model name required' });
            const customModels: string[] = (this.config as any).customModels || [];
            const name = model.trim();
            if (!customModels.includes(name)) {
                customModels.push(name);
                (this.config as any).customModels = customModels;
            }
            res.json({ success: true, message: `Model "${name}" added to list` });
        });

        // Pull a model from Ollama
        this.app.post('/api/ollama/pull', async (req: Request, res: Response) => {
            const { model } = req.body;
            if (!model) return res.status(400).json({ error: 'Model name required' });

            const ollamaUrl = this.config.ollamaUrl || 'http://localhost:11434';
            try {
                const pullRes = await fetch(`${ollamaUrl}/api/pull`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: model, stream: false })
                });
                if (pullRes.ok) {
                    res.json({ success: true, message: `Model "${model}" pulled successfully` });
                } else {
                    const errText = await pullRes.text();
                    res.status(500).json({ success: false, error: `Pull failed: ${errText.slice(0, 200)}` });
                }
            } catch (err: any) {
                res.status(500).json({ success: false, error: err.message });
            }


            });

        this.app.get('/api/ollama/exists/:model', async (req: Request, res: Response) => {
            const model = String(req.params.model);
            const ollamaUrl = this.config.ollamaUrl || 'http://localhost:11434';
            try {
                const resp = await fetch(`${ollamaUrl}/api/tags`);
                if (resp.ok) {
                    const data = await resp.json() as any;
                    const models: string[] = (data.models || []).map((m: any) => m.name);
                    const exists = models.includes(model);
                    res.json({ success: true, model, exists, models });
                } else {
                    res.json({ success: true, model, exists: false });
                }
            } catch {
                res.json({ success: true, model, exists: false });
            }
        });

        // Get skills list
        this.app.get('/api/skills', async (_req: Request, res: Response) => {
            try {
                const fs = await import('fs');
                const skillsDir = this.config.skillsDir;
                const skillsPath = path.resolve(skillsDir);

                if (!fs.existsSync(skillsPath)) {
                    return res.json({ success: true, skills: [] });
                }

                const entries = fs.readdirSync(skillsPath, { withFileTypes: true })
                    .filter(d => d.isDirectory())
                    .map(d => {
                        const skillFile = path.join(skillsPath, d.name, 'SKILL.md');
                        const hasSkillFile = fs.existsSync(skillFile);
                        return { name: d.name, hasSkillFile };
                    });

                res.json({ success: true, skills: entries });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // Get auto skills learned from runtime patterns
        this.app.get('/api/skills/auto', (_req: Request, res: Response) => {
            if (!this.memoryManager) return res.status(500).json({ error: 'Memory not available' });
            try {
                const mm = this.memoryManager as any;
                const db = mm.db || mm._db;
                if (!db) return res.status(500).json({ error: 'DB not available' });

                const skills = db.prepare(
                    `SELECT id, name, trigger, description, tool_sequence, priority, hits, status, source_pattern, source_tool, reviewed_at, created_at, updated_at
                     FROM auto_skills
                     ORDER BY
                        CASE status WHEN 'active' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END,
                        priority DESC,
                        hits DESC,
                        updated_at DESC`
                ).all();

                res.json({ success: true, skills });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // Get observed skill learner patterns
        this.app.get('/api/skills/patterns', (_req: Request, res: Response) => {
            if (!this.memoryManager) return res.status(500).json({ error: 'Memory not available' });
            try {
                const mm = this.memoryManager as any;
                const db = mm.db || mm._db;
                if (!db) return res.status(500).json({ error: 'DB not available' });

                const patterns = db.prepare(
                    `SELECT pattern, tool_name, success_count, fail_count, avg_latency_ms, last_seen, created_at
                     FROM skill_patterns
                     ORDER BY success_count DESC, fail_count ASC, avg_latency_ms ASC, last_seen DESC`
                ).all();

                res.json({ success: true, patterns });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        this.app.post('/api/skills/auto/:id/approve', (_req: Request, res: Response) => {
            if (!this.memoryManager) return res.status(500).json({ error: 'Memory not available' });
            try {
                const mm = this.memoryManager as any;
                const db = mm.db || mm._db;
                if (!db) return res.status(500).json({ error: 'DB not available' });

                const result = db.prepare(
                    `UPDATE auto_skills
                     SET status = 'active', reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`
                ).run(String(_req.params.id));

                if (result.changes === 0) return res.status(404).json({ success: false, error: 'Skill not found' });
                res.json({ success: true });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        this.app.post('/api/skills/auto/:id/reject', (_req: Request, res: Response) => {
            if (!this.memoryManager) return res.status(500).json({ error: 'Memory not available' });
            try {
                const mm = this.memoryManager as any;
                const db = mm.db || mm._db;
                if (!db) return res.status(500).json({ error: 'DB not available' });

                const result = db.prepare(
                    `UPDATE auto_skills
                     SET status = 'rejected', reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`
                ).run(String(_req.params.id));

                if (result.changes === 0) return res.status(404).json({ success: false, error: 'Skill not found' });
                res.json({ success: true });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // Get tools list
        this.app.get('/api/tools', (_req: Request, res: Response) => {
            res.json({
                success: true,
                tools: [
                    { name: 'exec_command', description: 'Execute shell commands' },
                    { name: 'web_search', description: 'Search the web' },
                    { name: 'file_ops', description: 'File operations (read/write/list)' },
                    { name: 'crypto_report', description: 'Cryptocurrency price reports (quick lookup)' },
                    { name: 'crypto_analysis', description: 'Deep crypto analysis: bleeding coins, gainers, losers, opportunities' },
                    { name: 'send_audio', description: 'Generate and send TTS audio via Telegram' },
                ]
            });
        });

        // System status
        this.app.get('/api/status', (_req: Request, res: Response) => {
            const uptime = process.uptime();
            const mem = process.memoryUsage();

            res.json({
                success: true,
                status: {
                    uptime: Math.floor(uptime),
                    uptimeHuman: formatUptime(uptime),
                    memory: {
                        rss: formatBytes(mem.rss),
                        heapUsed: formatBytes(mem.heapUsed),
                        heapTotal: formatBytes(mem.heapTotal),
                    },
                    nodeVersion: process.version,
                    platform: process.platform,
                    pid: process.pid,
                }
            });
        });

        // Web chat endpoint
        this.app.post('/api/chat', async (req: Request, res: Response) => {
            if (!this.controller) {
                return res.status(500).json({ error: 'AgentController not initialized' });
            }

            try {
                const { message, sessionId = 'web-session' } = req.body;
                if (!message) return res.status(400).json({ error: 'Message required' });

                const response = await this.controller.handleWebMessage(sessionId, message);
                res.json({ success: true, response, sessionId });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // === Execution Trace APIs ===

        // Get recent traces
        this.app.get('/api/traces', (_req: Request, res: Response) => {
            const traces = traceManager.getRecentTraces(20);
            res.json({ success: true, traces });
        });

        // Get trace stats
        this.app.get('/api/traces/stats', (_req: Request, res: Response) => {
            const stats = traceManager.getStats();
            res.json({ success: true, stats });
        });

        // === Tool Control APIs ===

        // Get tool status (enabled/disabled/dangerous)
        this.app.get('/api/tools/status', (_req: Request, res: Response) => {
            res.json({ success: true, tools: ToolRegistry.getStatus() });
        });

        // Enable a tool
        this.app.post('/api/tools/:name/enable', (req: Request, res: Response) => {
            const name = String(req.params.name);
            if (ToolRegistry.enable(name)) {
                res.json({ success: true, message: `Tool "${name}" enabled` });
            } else {
                res.status(404).json({ success: false, error: `Tool "${name}" not found` });
            }
        });

        // Disable a tool
        this.app.post('/api/tools/:name/disable', (req: Request, res: Response) => {
            const name = String(req.params.name);
            if (ToolRegistry.disable(name)) {
                res.json({ success: true, message: `Tool "${name}" disabled` });
            } else {
                res.status(404).json({ success: false, error: `Tool "${name}" not found` });
            }
        });

        // === Auth APIs ===

        // Restart NewClaw (graceful)
        this.app.post('/api/restart', (_req: Request, res: Response) => {
            res.json({ success: true, message: 'Restarting...' });
            // Use the start.sh script which manages PID and restarts
            const { exec } = require('child_process');
            exec('bash ./start.sh restart', (err: any) => {
                if (err) console.error('Restart error:', err.message);
            });
        });

        // Login
        this.app.post('/api/auth/login', (req: Request, res: Response) => {
            const { password } = req.body;
            if (!dashboardAuth.enabled) {
                return res.json({ success: true, token: 'no-auth-required' });
            }
            if (password === dashboardAuth.password) {
                const token = crypto.randomBytes(32).toString('hex');
                API_TOKENS.add(token);
                res.json({ success: true, token });
            } else {
                res.status(401).json({ success: false, error: 'Invalid password' });
            }
        });

        // Set auth config
        this.app.post('/api/auth/config', (req: Request, res: Response) => {
            const { enabled, password } = req.body;
            if (typeof enabled === 'boolean') {
                dashboardAuth.enabled = enabled;
            }
            if (password) {
                dashboardAuth.password = password;
            }
            res.json({ success: true, auth: { enabled: dashboardAuth.enabled, hasPassword: !!dashboardAuth.password } });
        });

        // === Memory APIs ===

        // Memory graph (for visualization)
        this.app.get('/api/memory/graph', (_req: Request, res: Response) => {
            if (!this.memoryManager) return res.status(500).json({ error: 'Memory not available' });
            try {
                const mm = this.memoryManager as any;
                const db = mm.db || mm._db;
                if (!db) return res.status(500).json({ error: 'DB not available' });

                const type = _req.query.type as string;
                const limit = Math.min(parseInt(String(_req.query.limit)) || 200, 500);

                let nodes;
                if (type) {
                    nodes = db.prepare('SELECT id, type, name FROM memory_nodes WHERE type = ? ORDER BY updated_at DESC LIMIT ?').all(type, limit);
                } else {
                    nodes = db.prepare('SELECT id, type, name FROM memory_nodes ORDER BY updated_at DESC LIMIT ?').all(limit);
                }

                const nodeIds = nodes.map((n: any) => n.id);
                const placeholders = nodeIds.map(() => '?').join(',');
                const edges = db.prepare(`SELECT from_node, to_node, relation, weight FROM memory_edges WHERE from_node IN (${placeholders}) AND to_node IN (${placeholders})`).all(...nodeIds, ...nodeIds);

                res.json({ success: true, nodes, edges });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // Memory graph neighborhood (subgraph around a node)
        this.app.get('/api/memory/graph/:nodeId', (req: Request, res: Response) => {
            if (!this.memoryManager) return res.status(500).json({ error: 'Memory not available' });
            try {
                const mm = this.memoryManager as any;
                const db = mm.db || mm._db;
                if (!db) return res.status(500).json({ error: 'DB not available' });

                const nodeId = String(req.params.nodeId);
                const depth = parseInt(String(req.query.depth)) || 1;

                // Collect node IDs up to N hops
                const collected = new Set<string>([nodeId]);
                let frontier = new Set<string>([nodeId]);

                for (let i = 0; i < depth; i++) {
                    const frontierPlaceholders = Array.from(frontier).map(() => '?').join(',');
                    const connectedEdges = db.prepare(
                        `SELECT from_node, to_node FROM memory_edges WHERE from_node IN (${frontierPlaceholders}) OR to_node IN (${frontierPlaceholders})`
                    ).all(...Array.from(frontier), ...Array.from(frontier));

                    frontier = new Set();
                    for (const e of connectedEdges) {
                        if (!collected.has(e.from_node)) { collected.add(e.from_node); frontier.add(e.from_node); }
                        if (!collected.has(e.to_node)) { collected.add(e.to_node); frontier.add(e.to_node); }
                    }
                }

                const idsArray = Array.from(collected);
                const idsPlaceholders = idsArray.map(() => '?').join(',');
                const nodes = db.prepare(`SELECT id, type, name FROM memory_nodes WHERE id IN (${idsPlaceholders})`).all(...idsArray);
                const edges = db.prepare(`SELECT from_node, to_node, relation, weight FROM memory_edges WHERE from_node IN (${idsPlaceholders}) AND to_node IN (${idsPlaceholders})`).all(...idsArray, ...idsArray);

                res.json({ success: true, nodes, edges, center: nodeId, depth });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // ── Ontologia do grafo ──
        this.app.get('/api/memory/ontology', (_req: Request, res: Response) => {
            res.json({
                success: true,
                nodeTypes: MemoryManager.NODE_TYPES,
                relations: Object.entries(MemoryManager.RELATION_ONTOLOGY).map(([key, val]) => ({
                    id: key,
                    label: val.label,
                    description: val.description,
                    allowedFrom: val.allowedFrom,
                    allowedTo: val.allowedTo,
                    inverse: (this.memoryManager as any)?.inverseRelations?.[key] || null
                })),
                inverseRelations: (this.memoryManager as any)?.getInverseRelationMap?.() || {}
            });
        });

        // ── Graph snapshots ──
        this.app.get('/api/memory/snapshots', (_req: Request, res: Response) => {
            if (!this.memoryManager) return res.status(500).json({ error: 'Memory not available' });
            try {
                const snapshots = (this.memoryManager as any).listSnapshots();
                res.json({ success: true, snapshots });
            } catch (err: any) { res.status(500).json({ error: err.message }); }
        });

        this.app.post('/api/memory/snapshots', (req: Request, res: Response) => {
            if (!this.memoryManager) return res.status(500).json({ error: 'Memory not available' });
            try {
                const id = (this.memoryManager as any).createSnapshot(req.body.label);
                res.json({ success: true, id });
            } catch (err: any) { res.status(500).json({ error: err.message }); }
        });

        this.app.post('/api/memory/snapshots/:id/restore', (req: Request, res: Response) => {
            if (!this.memoryManager) return res.status(500).json({ error: 'Memory not available' });
            try {
                const ok = (this.memoryManager as any).restoreSnapshot(req.params.id);
                ok ? res.json({ success: true }) : res.status(404).json({ error: 'Snapshot not found' });
            } catch (err: any) { res.status(500).json({ error: err.message }); }
        });

        this.app.delete('/api/memory/snapshots/:id', (req: Request, res: Response) => {
            if (!this.memoryManager) return res.status(500).json({ error: 'Memory not available' });
            try {
                const ok = (this.memoryManager as any).deleteSnapshot(req.params.id);
                ok ? res.json({ success: true }) : res.status(404).json({ error: 'Snapshot not found' });
            } catch (err: any) { res.status(500).json({ error: err.message }); }
        });

        // Config history
        this.app.get('/api/config/history', (_req: Request, res: Response) => {
            try {
                const mm = this.controller ? (this.controller as any).memory : null;
                if (!mm || !mm.db) return res.status(500).json({ error: 'DB not available' });
                const history = mm.db.prepare('SELECT id, config_json, created_at, is_active FROM agent_config ORDER BY created_at DESC LIMIT 20').all();
                res.json({ success: true, history: history.map((h: any) => ({ ...h, config: JSON.parse(h.config_json) })) });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // Memory stats
        this.app.get('/api/memory/stats', (_req: Request, res: Response) => {
            if (!this.memoryManager) return res.status(500).json({ error: 'Memory not available' });
            try {
                const mm = this.memoryManager as any;
                const db = mm.db || mm._db;
                if (!db) return res.status(500).json({ error: 'DB not available' });

                const totalNodes = db.prepare('SELECT COUNT(*) as c FROM memory_nodes').get().c;
                const totalEdges = db.prepare('SELECT COUNT(*) as c FROM memory_edges').get().c;
                const totalMessages = db.prepare('SELECT COUNT(*) as c FROM messages').get().c;
                const totalConversations = db.prepare('SELECT COUNT(*) as c FROM conversations').get().c;
                const nodesByType = db.prepare('SELECT type, COUNT(*) as c FROM memory_nodes GROUP BY type').all();

                res.json({
                    success: true,
                    stats: { totalNodes, totalEdges, totalMessages, totalConversations, nodesByType: Object.fromEntries(nodesByType.map((r: any) => [r.type, r.c])) },
                    centrality: this.computeCentrality(db)
                });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // Memory quality review
        this.app.get('/api/memory/review', (_req: Request, res: Response) => {
            if (!this.memoryManager) return res.status(500).json({ error: 'Memory not available' });
            try {
                const mm = this.memoryManager as any;
                const db = mm.db || mm._db;
                if (!db) return res.status(500).json({ error: 'DB not available' });

                const nodes = db.prepare('SELECT id, type, name, content, updated_at FROM memory_nodes ORDER BY updated_at DESC').all();
                const edges = db.prepare('SELECT from_node, to_node, relation FROM memory_edges').all();
                const review = this.computeMemoryReview(nodes, edges);

                res.json({ success: true, review });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        this.app.post('/api/memory/merge', (req: Request, res: Response) => {
            if (!this.memoryManager) return res.status(500).json({ error: 'Memory not available' });
            try {
                const mm = this.memoryManager as any;
                const db = mm.db || mm._db;
                if (!db) return res.status(500).json({ error: 'DB not available' });

                const { keepId, mergeId } = req.body || {};
                if (!keepId || !mergeId) {
                    return res.status(400).json({ error: 'keepId and mergeId are required' });
                }
                if (keepId === mergeId) {
                    return res.status(400).json({ error: 'keepId and mergeId must be different' });
                }

                const keepNode = db.prepare('SELECT * FROM memory_nodes WHERE id = ?').get(keepId) as any;
                const mergeNode = db.prepare('SELECT * FROM memory_nodes WHERE id = ?').get(mergeId) as any;
                if (!keepNode || !mergeNode) {
                    return res.status(404).json({ error: 'Node not found' });
                }

                const snapshotId = mm.createSnapshot?.(`pre-merge:${keepId}<-${mergeId}`) || null;

                const content1 = String(keepNode.content || '');
                const content2 = String(mergeNode.content || '');
                const lines1 = content1.split('\n').map((l: string) => l.trim()).filter(Boolean);
                const lines2 = content2.split('\n').map((l: string) => l.trim()).filter(Boolean);
                const mergedContent = Array.from(new Set([...lines1, ...lines2])).join('\n');
                const mergedName = String(keepNode.name || '').trim() || String(mergeNode.name || '').trim();
                const mergedType = keepNode.type || mergeNode.type;

                db.prepare('UPDATE memory_nodes SET name = ?, type = ?, content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                    .run(mergedName, mergedType, mergedContent, keepId);

                const relatedEdges = db.prepare('SELECT from_node, to_node, relation, weight, confidence FROM memory_edges WHERE from_node = ? OR to_node = ?')
                    .all(mergeId, mergeId) as any[];

                for (const edge of relatedEdges) {
                    const nextFrom = edge.from_node === mergeId ? keepId : edge.from_node;
                    const nextTo = edge.to_node === mergeId ? keepId : edge.to_node;
                    if (nextFrom === nextTo) continue;
                    db.prepare(`
                        INSERT OR REPLACE INTO memory_edges (from_node, to_node, relation, weight, confidence)
                        VALUES (?, ?, ?, ?, ?)
                    `).run(nextFrom, nextTo, edge.relation, edge.weight || 1.0, edge.confidence || 1.0);
                }

                try { db.prepare('DELETE FROM memory_metrics_history WHERE node_id = ?').run(mergeId); } catch {}
                try { db.prepare('DELETE FROM memory_embeddings WHERE node_id = ?').run(mergeId); } catch {}
                db.prepare('DELETE FROM memory_edges WHERE from_node = ? OR to_node = ?').run(mergeId, mergeId);
                db.prepare('DELETE FROM memory_nodes WHERE id = ?').run(mergeId);

                console.log(`[MEMORY] Nodes merged: keep=${keepId}, removed=${mergeId}`);
                res.json({ success: true, snapshotId, keptNodeId: keepId, removedNodeId: mergeId });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // List nodes (with optional type filter)
        this.app.get('/api/memory/nodes', (req: Request, res: Response) => {
            if (!this.memoryManager) return res.status(500).json({ error: 'Memory not available' });
            try {
                const mm = this.memoryManager as any;
                const db = mm.db || mm._db;
                if (!db) return res.status(500).json({ error: 'DB not available' });

                const type = req.query.type as string;
                const limit = Math.min(parseInt(String(req.query.limit)) || 50, 200);
                let nodes;
                if (type) {
                    nodes = db.prepare('SELECT id, type, name, substr(content, 1, 200) as content, updated_at FROM memory_nodes WHERE type = ? ORDER BY updated_at DESC LIMIT ?').all(type, limit);
                } else {
                    nodes = db.prepare('SELECT id, type, name, substr(content, 1, 200) as content, updated_at FROM memory_nodes ORDER BY updated_at DESC LIMIT ?').all(limit);
                }
                res.json({ success: true, nodes });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // Search nodes (Embedding > FTS5 > LIKE fallback)
        this.app.get('/api/memory/search', async (req: Request, res: Response) => {
            if (!this.memoryManager) return res.status(500).json({ error: 'Memory not available' });
            try {
                const mm = this.memoryManager as any;
                const db = mm.db || mm._db;
                if (!db) return res.status(500).json({ error: 'DB not available' });

                const q = req.query.q as string;
                if (!q) return res.status(400).json({ error: 'Query parameter "q" required' });

                // 1. Try semantic search via embeddings
                if (this.embeddingService) {
                    try {
                        const available = await this.embeddingService.isAvailable();
                        if (available) {
                            const results = await this.embeddingService.search(q, 20);
                            if (results.length > 0) {
                                const ids = results.map(r => r.id);
                                const scores = new Map(results.map(r => [r.id, r.score]));
                                const placeholders = ids.map(() => '?').join(',');
                                const nodes = db.prepare(
                                    `SELECT id, type, name, substr(content, 1, 200) as content, updated_at FROM memory_nodes WHERE id IN (${placeholders})`
                                ).all(...ids);
                                // Add score to each node
                                const nodesWithScore = nodes.map((n: any) => ({ ...n, score: scores.get(n.id) || 0 }));
                                nodesWithScore.sort((a: any, b: any) => b.score - a.score);
                                return res.json({ success: true, nodes: nodesWithScore, method: 'embedding' });
                            }
                        }
                    } catch { /* fall through */ }
                }

                // 2. Try FTS5 ranked search
                try {
                    const nodes = db.prepare(`
                        SELECT n.id, n.type, n.name, substr(n.content, 1, 200) as content, n.updated_at
                        FROM memory_nodes_fts f
                        JOIN memory_nodes n ON f.rowid = n.rowid
                        WHERE memory_nodes_fts MATCH ?
                        ORDER BY rank LIMIT 50
                    `).all(`${q}*`);
                    return res.json({ success: true, nodes, method: 'fts5' });
                } catch {
                    // 3. Fallback to LIKE
                    const nodes = db.prepare(
                        'SELECT id, type, name, substr(content, 1, 200) as content, updated_at FROM memory_nodes WHERE name LIKE ? OR content LIKE ? ORDER BY updated_at DESC LIMIT 50'
                    ).all(`%${q}%`, `%${q}%`);
                    return res.json({ success: true, nodes, method: 'like' });
                }
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // Analytics endpoint — metrics and graph density (O(1) with backend persistence)
        this.app.get('/api/memory/analytics', (_req: Request, res: Response) => {
            if (!this.memoryManager) return res.status(500).json({ error: 'Memory not available' });
            try {
                const mm = this.memoryManager as any;
                const db = mm.db || mm._db;
                if (!db) return res.status(500).json({ error: 'DB not available' });

                // Try to get nodes with metrics safely
                let nodes: Array<any>;
                try {
                    nodes = db.prepare('SELECT id, type, name, pagerank, degree, betweenness, closeness FROM memory_nodes').all();
                } catch (e) {
                    // Fallback if migration hasn't run
                    nodes = db.prepare('SELECT id, type, name, 0 as pagerank, 0 as degree, 0 as betweenness, 0 as closeness FROM memory_nodes').all();
                }

                const edgesCountRow = db.prepare('SELECT COUNT(*) as c FROM memory_edges').get() as { c: number };
                const totalEdges = edgesCountRow.c;

                // Graph density
                const maxEdges = nodes.length * (nodes.length - 1);
                const density = maxEdges > 0 ? totalEdges / maxEdges : 0;

                // Sort top nodes by pre-calculated persisted values
                const topByDegree = [...nodes].sort((a, b) => (b.degree || 0) - (a.degree || 0)).slice(0, 10).map(n => ({ id: n.id, name: n.name, type: n.type, value: n.degree }));
                const topByBetweenness = [...nodes].sort((a, b) => (b.betweenness || 0) - (a.betweenness || 0)).slice(0, 10).map(n => ({ id: n.id, name: n.name, type: n.type, value: Math.round((n.betweenness || 0) * 100) / 100 }));
                const topByCloseness = [...nodes].sort((a, b) => (b.closeness || 0) - (a.closeness || 0)).slice(0, 10).map(n => ({ id: n.id, name: n.name, type: n.type, value: Math.round((n.closeness || 0) * 100) / 100 }));

                res.json({
                    success: true,
                    analytics: {
                        totalNodes: nodes.length,
                        totalEdges: totalEdges,
                        density: Math.round(density * 10000) / 10000,
                        avgDegree: nodes.length > 0 ? Math.round(totalEdges * 2 / nodes.length * 100) / 100 : 0,
                        topByDegree,
                        topByBetweenness,
                        topByCloseness
                    }
                });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        this.app.get('/api/memory/nodes/:id', (req: Request, res: Response) => {
            if (!this.memoryManager) return res.status(500).json({ error: 'Memory not available' });
            try {
                const mm = this.memoryManager as any;
                const db = mm.db || mm._db;
                if (!db) return res.status(500).json({ error: 'DB not available' });

                const id = String(req.params.id);
                const node = db.prepare('SELECT * FROM memory_nodes WHERE id = ?').get(id);
                if (!node) return res.status(404).json({ error: 'Node not found' });

                // Dynamic weight: increment edge weights when node is accessed
                db.prepare('UPDATE memory_edges SET weight = weight + 0.1 WHERE from_node = ? OR to_node = ?').run(id, id);
                db.prepare('UPDATE memory_nodes SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);

                const edges = db.prepare('SELECT from_node, to_node, relation, weight FROM memory_edges WHERE from_node = ? OR to_node = ?').all(id, id);
                try { (node as any).metadata = JSON.parse((node as any).metadata || '{}'); } catch {}

                res.json({ success: true, node, edges });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // Update node
        this.app.put('/api/memory/nodes/:id', (req: Request, res: Response) => {
            if (!this.memoryManager) return res.status(500).json({ error: 'Memory not available' });
            try {
                const mm = this.memoryManager as any;
                const db = mm.db || mm._db;
                if (!db) return res.status(500).json({ error: 'DB not available' });

                const id = String(req.params.id);
                const { type, name, content } = req.body;

                const existing = db.prepare('SELECT id FROM memory_nodes WHERE id = ?').get(id);
                if (!existing) return res.status(404).json({ error: 'Node not found' });

                if (type) db.prepare('UPDATE memory_nodes SET type = ? WHERE id = ?').run(type, id);
                if (name) db.prepare('UPDATE memory_nodes SET name = ? WHERE id = ?').run(name, id);
                if (content !== undefined) db.prepare('UPDATE memory_nodes SET content = ? WHERE id = ?').run(content, id);
                db.prepare('UPDATE memory_nodes SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);

                console.log(`[MEMORY] Node updated: ${id}`);
                res.json({ success: true });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // Create node
        this.app.post('/api/memory/nodes', (req: Request, res: Response) => {
            if (!this.memoryManager) return res.status(500).json({ error: 'Memory not available' });
            try {
                const mm = this.memoryManager as any;
                const db = mm.db || mm._db;
                if (!db) return res.status(500).json({ error: 'DB not available' });

                const { id, type, name, content } = req.body;
                if (!id || !type || !name || content === undefined) {
                    return res.status(400).json({ error: 'id, type, name, content required' });
                }

                db.prepare('INSERT OR REPLACE INTO memory_nodes (id, type, name, content, metadata, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)')
                    .run(id, type, name, content, '{}');

                console.log(`[MEMORY] Node created: ${id} (${type})`);
                res.json({ success: true });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // Delete node
        this.app.delete('/api/memory/nodes/:id', (req: Request, res: Response) => {
            if (!this.memoryManager) return res.status(500).json({ error: 'Memory not available' });
            try {
                const mm = this.memoryManager as any;
                const db = mm.db || mm._db;
                if (!db) return res.status(500).json({ error: 'DB not available' });

                const id = String(req.params.id);
                try { db.prepare('DELETE FROM memory_metrics_history WHERE node_id = ?').run(id); } catch {}
                try { db.prepare('DELETE FROM memory_embeddings WHERE node_id = ?').run(id); } catch {}
                db.prepare('DELETE FROM memory_edges WHERE from_node = ? OR to_node = ?').run(id, id);
                db.prepare('DELETE FROM memory_nodes WHERE id = ?').run(id);

                console.log(`[MEMORY] Node deleted: ${id}`);
                res.json({ success: true });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // Create edge
        this.app.post('/api/memory/edges', (req: Request, res: Response) => {
            if (!this.memoryManager) return res.status(500).json({ error: 'Memory not available' });
            try {
                const mm = this.memoryManager as any;
                const db = mm.db || mm._db;
                if (!db) return res.status(500).json({ error: 'DB not available' });

                const { from, to, relation, weight } = req.body;
                if (!from || !to || !relation) {
                    return res.status(400).json({ error: 'from, to, relation required' });
                }

                db.prepare('INSERT OR REPLACE INTO memory_edges (from_node, to_node, relation, weight) VALUES (?, ?, ?, ?)')
                    .run(from, to, relation, weight || 1.0);

                console.log(`[MEMORY] Edge created: ${from} -${relation}-> ${to}`);
                res.json({ success: true });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // Delete edge
        this.app.delete('/api/memory/edges', (req: Request, res: Response) => {
            if (!this.memoryManager) return res.status(500).json({ error: 'Memory not available' });
            try {
                const mm = this.memoryManager as any;
                const db = mm.db || mm._db;
                if (!db) return res.status(500).json({ error: 'DB not available' });

                const { from, to, relation } = req.body;
                db.prepare('DELETE FROM memory_edges WHERE from_node = ? AND to_node = ? AND relation = ?')
                    .run(from, to, relation);

                console.log(`[MEMORY] Edge deleted: ${from} -${relation}-> ${to}`);
                res.json({ success: true });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });


        // Update edge relation
        this.app.put('/api/memory/edges', (req: Request, res: Response) => {
            if (!this.memoryManager) return res.status(500).json({ error: 'Memory not available' });
            try {
                const mm = this.memoryManager as any;
                const db = mm.db || mm._db;
                if (!db) return res.status(500).json({ error: 'DB not available' });

                const { from, to, old_relation, new_relation } = req.body;
                if (!from || !to || !old_relation || !new_relation) {
                    return res.status(400).json({ error: 'from, to, old_relation, new_relation required' });
                }

                const result = db.prepare('UPDATE memory_edges SET relation = ? WHERE from_node = ? AND to_node = ? AND relation = ?')
                    .run(new_relation, from, to, old_relation);

                if (result.changes === 0) {
                    return res.status(404).json({ error: 'Edge not found' });
                }

                console.log(`[MEMORY] Edge updated: ${from} -${old_relation}-> ${to} => ${from} -${new_relation}-> ${to}`);
                res.json({ success: true, changes: result.changes });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // Manual curation endpoint
        this.app.post('/api/memory/curate', async (_req: Request, res: Response) => {
            if (!this.memoryCurator) return res.status(500).json({ error: 'Curator not available' });
            try {
                const result = await this.memoryCurator.curate();
                res.json({ success: true, ...result });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // Generate embeddings for nodes missing them
        this.app.post('/api/memory/embed', async (req: Request, res: Response) => {
            if (!this.embeddingService) return res.status(500).json({ error: 'EmbeddingService not available' });
            try {
                const limit = (req.body?.limit as number) || 50;
                const count = await this.embeddingService.embedMissing(limit);
                const available = await this.embeddingService.isAvailable();
                res.json({ success: true, embedded: count, model: this.embeddingService.getModel?.() || 'nomic-embed-text', available });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // ── Dashboard Analytics (Bloco 4) ──

        // Top nodes by metric
        this.app.get('/api/memory/dashboard/top-nodes', (req: Request, res: Response) => {
            if (!this.memoryManager) return res.status(500).json({ error: 'Memory not available' });
            try {
                const mm = this.memoryManager as any;
                const db = mm.db || mm._db;
                const metric = (req.query.metric as string) || 'pagerank';
                const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);

                const validMetrics = ['pagerank', 'degree', 'betweenness', 'closeness'];
                if (!validMetrics.includes(metric)) {
                    return res.status(400).json({ error: `Invalid metric. Use: ${validMetrics.join(', ')}` });
                }

                const nodes = db.prepare(
                    `SELECT id, type, name, ${metric} FROM memory_nodes ORDER BY ${metric} DESC LIMIT ?`
                ).all(limit);
                res.json({ success: true, metric, nodes });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // Metrics evolution over time
        this.app.get('/api/memory/dashboard/evolution', (req: Request, res: Response) => {
            if (!this.memoryManager) return res.status(500).json({ error: 'Memory not available' });
            try {
                const mm = this.memoryManager as any;
                const db = mm.db || mm._db;
                const node_id = req.query.node_id as string;
                const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);

                let rows;
                if (node_id) {
                    rows = db.prepare(
                        'SELECT node_id, pagerank, degree, betweenness, closeness, community_id, recorded_at FROM memory_metrics_history WHERE node_id = ? ORDER BY recorded_at DESC LIMIT ?'
                    ).all(node_id, limit);
                } else {
                    rows = db.prepare(
                        'SELECT recorded_at, COUNT(*) as node_count, AVG(pagerank) as avg_pagerank, AVG(degree) as avg_degree, AVG(betweenness) as avg_betweenness, AVG(closeness) as avg_closeness FROM memory_metrics_history GROUP BY recorded_at ORDER BY recorded_at DESC LIMIT ?'
                    ).all(limit);
                }
                res.json({ success: true, rows });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // Communities summary
        this.app.get('/api/memory/dashboard/communities', (_req: Request, res: Response) => {
            if (!this.memoryManager) return res.status(500).json({ error: 'Memory not available' });
            try {
                const mm = this.memoryManager as any;
                const db = mm.db || mm._db;

                const communities = db.prepare(
                    'SELECT community_id, COUNT(*) as node_count, GROUP_CONCAT(id) as node_ids FROM memory_nodes WHERE community_id IS NOT NULL GROUP BY community_id ORDER BY COUNT(*) DESC'
                ).all() as Array<{ community_id: number; node_count: number; node_ids: string }>;

                // Parse node_ids back to array
                const result = communities.map(c => ({
                    ...c,
                    node_ids: c.node_ids ? c.node_ids.split(',') : []
                }));

                res.json({ success: true, communities: result, total_communities: result.length });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // Graph density and stats
        this.app.get('/api/memory/dashboard/density', (_req: Request, res: Response) => {
            if (!this.memoryManager) return res.status(500).json({ error: 'Memory not available' });
            try {
                const mm = this.memoryManager as any;
                const db = mm.db || mm._db;

                const nodeCount = (db.prepare('SELECT COUNT(*) as c FROM memory_nodes').get() as any).c;
                const edgeCount = (db.prepare('SELECT COUNT(*) as c FROM memory_edges').get() as any).c;
                const maxEdges = nodeCount * (nodeCount - 1);
                const density = maxEdges > 0 ? (edgeCount / maxEdges).toFixed(4) : 0;
                const avgDegree = nodeCount > 0 ? (2 * edgeCount / nodeCount).toFixed(2) : 0;
                const avgWeight = (db.prepare('SELECT AVG(weight) as w FROM memory_edges').get() as any).w || 0;

                res.json({
                    success: true,
                    nodeCount,
                    edgeCount,
                    density: parseFloat(density as string),
                    avgDegree: parseFloat(avgDegree as string),
                    avgWeight: Math.round(avgWeight * 100) / 100,
                    maxEdges
                });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // Record metrics snapshot
        this.app.post('/api/memory/dashboard/record-snapshot', (_req: Request, res: Response) => {
            if (!this.memoryManager) return res.status(500).json({ error: 'Memory not available' });
            try {
                const count = this.memoryManager.recordMetricsSnapshot();
                res.json({ success: true, recorded: count });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // ── Classification Memory & Decision Memory endpoints ──

        // Get classification stats
        this.app.get('/api/memory/classifications', (_req: Request, res: Response) => {
            if (!this.classificationMemory) return res.status(500).json({ error: 'ClassificationMemory not available' });
            try {
                const stats = this.classificationMemory.stats();
                res.json({ success: true, ...stats });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // Get tool decision stats
        this.app.get('/api/memory/decisions', (req: Request, res: Response) => {
            if (!this.decisionMemory) return res.status(500).json({ error: 'DecisionMemory not available' });
            try {
                const tool = req.query.tool as string | undefined;
                const stats = this.decisionMemory.getToolStats(tool);
                res.json({ success: true, stats });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // Record a tool decision
        this.app.post('/api/memory/decisions', (req: Request, res: Response) => {
            if (!this.decisionMemory) return res.status(500).json({ error: 'DecisionMemory not available' });
            try {
                const { toolName, context, taskType, success, latencyMs, feedback } = req.body;
                const id = this.decisionMemory.record({ toolName, context, taskType, success, latencyMs, feedback });
                res.json({ success: true, id });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // ── Skill Installer endpoints ──

        // Install a skill
        this.app.post('/api/skills/install', async (req: Request, res: Response) => {
            if (!this.skillInstaller) return res.status(500).json({ error: 'SkillInstaller not available' });
            try {
                const result = await this.skillInstaller.install(req.body);
                res.json(result);
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // List installed skills
        this.app.get('/api/skills/installed', (_req: Request, res: Response) => {
            if (!this.skillInstaller) return res.status(500).json({ error: 'SkillInstaller not available' });
            try {
                const skills = this.skillInstaller.listInstalled();
                res.json({ success: true, skills });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // Remove a skill
        this.app.delete('/api/skills/:name', async (req: Request, res: Response) => {
            if (!this.skillInstaller) return res.status(500).json({ error: 'SkillInstaller not available' });
            try {
                const result = await this.skillInstaller.remove(String(req.params.name));
                res.json(result);
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // Conversations API — sync dashboard with DB
        this.app.get('/api/conversations', (req: Request, res: Response) => {
            if (!this.memoryManager) return res.status(500).json({ error: 'Memory not available' });
            try {
                const mm = this.memoryManager as any;
                const db = mm.db || mm._db;
                if (!db) return res.status(500).json({ error: 'DB not available' });
                const userId = (req.query.userId as string) || 'web-dashboard';
                const convs = db.prepare('SELECT id, user_id, provider, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
                res.json({ success: true, conversations: convs });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        this.app.get('/api/conversations/:id/messages', (req: Request, res: Response) => {
            if (!this.memoryManager) return res.status(500).json({ error: 'Memory not available' });
            try {
                const mm = this.memoryManager as any;
                const db = mm.db || mm._db;
                if (!db) return res.status(500).json({ error: 'DB not available' });
                const convId = req.params.id;
                const limit = parseInt(req.query.limit as string) || 50;
                const msgs = db.prepare('SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?').all(convId, limit);
                res.json({ success: true, messages: msgs.reverse() });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // Export/Import conversations
        this.app.get('/api/conversations/export', (req: Request, res: Response) => {
            if (!this.memoryManager) return res.status(500).json({ error: 'Memory not available' });
            try {
                const mm = this.memoryManager as any;
                const db = mm.db || mm._db;
                if (!db) return res.status(500).json({ error: 'DB not available' });
                const convs = db.prepare('SELECT * FROM conversations').all();
                const msgs = db.prepare('SELECT * FROM messages').all();
                res.json({ success: true, export: { conversations: convs, messages: msgs, exportedAt: new Date().toISOString() } });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // SSE stream for real-time trace events
        this.app.get('/api/stream', (req: Request, res: Response) => {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders?.();

            const sendEvent = (event: string, data: any) => {
                res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            };

            const onStep = (data: any) => sendEvent('trace_step', data);
            const onStart = (data: any) => sendEvent('trace_start', data);
            const onComplete = (data: any) => sendEvent('trace_complete', data);

            traceManager.on('trace_step', onStep);
            traceManager.on('trace_start', onStart);
            traceManager.on('trace_complete', onComplete);

            const heartbeat = setInterval(() => {
                res.write(': ping\n\n');
            }, 15000);

            req.on('close', () => {
                clearInterval(heartbeat);
                traceManager.off('trace_step', onStep);
                traceManager.off('trace_start', onStart);
                traceManager.off('trace_complete', onComplete);
                res.end();
            });
        });
    }

    public setController(controller: AgentController) {
        this.controller = controller;
    }

    public setProviderFactory(pf: ProviderFactory) {
        this.providerFactory = pf;
    }

    public setMemoryManager(mm: MemoryManager) {
        this.memoryManager = mm;
        this.memoryCurator = new MemoryCurator(mm);
        this.graphAnalytics = new GraphAnalytics(mm);
        this.embeddingService = new EmbeddingService((mm as any).db || (mm as any)._db);
        this.classificationMemory = new ClassificationMemory((mm as any).db || (mm as any)._db);
        this.decisionMemory = new DecisionMemory((mm as any).db || (mm as any)._db);
        this.skillInstaller = new SkillInstaller();
        this.memoryCurator.startAutoCurate(30 * 60 * 1000); // Every 30 min
    }

    /**
     * Persist runtime config changes to .env file
     * so they survive restarts
     */
    private persistConfigToEnv(): void {
        try {
            const fs = require('fs');
            const path = require('path');
            const envPath = path.join(process.cwd(), '.env');
            
            let envContent = '';
            if (fs.existsSync(envPath)) {
                envContent = fs.readFileSync(envPath, 'utf-8');
            }

            const updates: Record<string, string> = {
                'DEFAULT_PROVIDER': this.config.defaultProvider,
                'APP_LANG': this.config.language,
                'OLLAMA_MODEL': this.config.ollamaModel || '',
                'OLLAMA_URL': this.config.ollamaUrl || 'http://localhost:11434',
                'MAX_ITERATIONS': String(this.config.maxIterations),
                'MEMORY_WINDOW_SIZE': String(this.config.memoryWindowSize),
                'TELEGRAM_ALLOWED_USER_IDS': this.config.telegramAllowedUserIds.join(','),
                'MODEL_CHAT': this.config.modelRouter?.chat || '',
                'MODEL_CODE': this.config.modelRouter?.code || '',
                'MODEL_VISION': this.config.modelRouter?.vision || '',
                'MODEL_LIGHT': this.config.modelRouter?.light || '',
                'MODEL_ANALYSIS': this.config.modelRouter?.analysis || '',
                'MODEL_EXECUTION': this.config.modelRouter?.execution || '',
                'VISION_SERVER': this.config.modelRouter?.visionServer || '',
                'CLASSIFIER_MODEL': this.config.modelRouter?.classifierModel || '',
                'CLASSIFIER_SERVER': this.config.modelRouter?.classifierServer || '',
            };

            // Only write OLLAMA_API_KEY if provided (don't overwrite with empty)
            if (this.config.ollamaApiKey) updates['OLLAMA_API_KEY'] = this.config.ollamaApiKey;
            // Only write SYSTEM_PROMPT if provided
            if (this.config.systemPrompt) updates['SYSTEM_PROMPT'] = this.config.systemPrompt;

            // Save config version to DB for audit trail
            try {
                const mm = this.controller ? (this.controller as any).memory : null;
                if (mm && mm.db) {
                    // Deactivate previous
                    mm.db.prepare('UPDATE agent_config SET is_active = 0').run();
                    // Insert new
                    mm.db.prepare('INSERT INTO agent_config (config_json, is_active) VALUES (?, 1)').run(JSON.stringify(this.config));
                }
            } catch (e: any) { /* DB not available, skip */ }

            for (const [key, value] of Object.entries(updates)) {
                const regex = new RegExp(`^${key}=.*$`, 'm');
                if (regex.test(envContent)) {
                    envContent = envContent.replace(regex, `${key}=${value}`);
                } else {
                    envContent += `\n${key}=${value}`;
                }
            }

            fs.writeFileSync(envPath, envContent.trim() + '\n');
            console.log(`[CONFIG] Persisted to .env: ${Object.keys(updates).join(', ')}`);
        } catch (error: any) {
            console.error(`[CONFIG] Failed to persist .env: ${error.message}`);
        }
    }

    public start(port: number = 3090) {
        if (this.server) return;

        this.server = this.app.listen(port, () => {
            console.log(`[DASHBOARD] NewClaw Dashboard rodando em http://localhost:${port}`);
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

    private computeCentrality(db: any): Record<string, { degree: number; inDegree: number; outDegree: number }> {
        const nodes: { id: string }[] = db.prepare('SELECT id FROM memory_nodes').all();
        const edges: { from_node: string; to_node: string }[] = db.prepare('SELECT from_node, to_node FROM memory_edges').all();
        const centrality: Record<string, { degree: number; inDegree: number; outDegree: number }> = {};
        for (const n of nodes) centrality[n.id] = { degree: 0, inDegree: 0, outDegree: 0 };
        for (const e of edges) {
            if (centrality[e.from_node]) { centrality[e.from_node].outDegree++; centrality[e.from_node].degree++; }
            if (centrality[e.to_node]) { centrality[e.to_node].inDegree++; centrality[e.to_node].degree++; }
        }
        return centrality;
    }

    private computeMemoryReview(nodes: any[], edges: any[]) {
        const centrality: Record<string, { degree: number; inDegree: number; outDegree: number }> = {};
        for (const node of nodes) centrality[node.id] = { degree: 0, inDegree: 0, outDegree: 0 };
        for (const edge of edges) {
            if (centrality[edge.from_node]) {
                centrality[edge.from_node].outDegree++;
                centrality[edge.from_node].degree++;
            }
            if (centrality[edge.to_node]) {
                centrality[edge.to_node].inDegree++;
                centrality[edge.to_node].degree++;
            }
        }

        const orphanNodes = nodes
            .filter((node) => (centrality[node.id]?.degree || 0) === 0)
            .map((node) => ({
                id: node.id,
                type: node.type,
                name: node.name,
                contentLength: String(node.content || '').trim().length,
            }));

        const sparseNodes = nodes
            .filter((node) => {
                const degree = centrality[node.id]?.degree || 0;
                const contentLength = String(node.content || '').trim().length;
                return contentLength < 40 || (degree <= 1 && contentLength < 120);
            })
            .map((node) => ({
                id: node.id,
                type: node.type,
                name: node.name,
                degree: centrality[node.id]?.degree || 0,
                contentLength: String(node.content || '').trim().length,
            }))
            .sort((a, b) => a.contentLength - b.contentLength || a.degree - b.degree)
            .slice(0, 20);

        const duplicateCandidates = this.findDuplicateCandidates(nodes);

        const issues = [
            ...orphanNodes.map((node) => ({
                kind: 'orphan',
                priority: 100,
                nodeId: node.id,
                title: node.name || node.id,
                detail: 'No sem relacoes',
            })),
            ...sparseNodes.map((node) => ({
                kind: 'sparse',
                priority: 70 - Math.min(node.contentLength, 60) + (node.degree === 0 ? 10 : 0),
                nodeId: node.id,
                title: node.name || node.id,
                detail: `Conteudo curto (${node.contentLength} chars), grau ${node.degree}`,
            })),
            ...duplicateCandidates.map((pair) => ({
                kind: 'duplicate',
                priority: 80 + Math.round(pair.similarity * 10),
                nodeId: pair.left.id,
                secondaryNodeId: pair.right.id,
                title: `${pair.left.name || pair.left.id} / ${pair.right.name || pair.right.id}`,
                detail: `Possivel duplicata (${Math.round(pair.similarity * 100)}%)`,
            })),
        ]
            .sort((a, b) => b.priority - a.priority)
            .slice(0, 25);

        const totalNodes = Math.max(nodes.length, 1);
        const totalEdges = edges.length;
        const edgeDensity = totalNodes > 1 ? totalEdges / totalNodes : totalEdges;
        const orphanPenalty = Math.min(35, Math.round((orphanNodes.length / totalNodes) * 100));
        const sparsePenalty = Math.min(25, Math.round((sparseNodes.length / totalNodes) * 60));
        const duplicatePenalty = Math.min(15, duplicateCandidates.length * 3);
        const densityBonus = Math.min(20, Math.round(edgeDensity * 8));
        const qualityScore = Math.max(0, Math.min(100, 55 + densityBonus - orphanPenalty - sparsePenalty - duplicatePenalty));

        return {
            summary: {
                totalNodes: nodes.length,
                totalEdges: edges.length,
                orphanCount: orphanNodes.length,
                sparseCount: sparseNodes.length,
                duplicateCount: duplicateCandidates.length,
                qualityScore,
            },
            orphanNodes,
            sparseNodes,
            duplicateCandidates,
            issues,
            centrality,
        };
    }

    private findDuplicateCandidates(nodes: any[]) {
        const candidates: Array<{ left: any; right: any; similarity: number }> = [];
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const left = nodes[i];
                const right = nodes[j];
                const nameSimilarity = this.stringSimilarity(left.name || '', right.name || '');
                const contentSimilarity = this.stringSimilarity(left.content || '', right.content || '');
                const sameNormalizedName = this.normalizeText(left.name || '') === this.normalizeText(right.name || '');
                const similarity = Math.max(nameSimilarity, contentSimilarity * 0.75);
                if (sameNormalizedName || similarity >= 0.82) {
                    candidates.push({ left, right, similarity: sameNormalizedName ? 0.98 : similarity });
                }
            }
        }
        return candidates
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, 12)
            .map((item) => ({
                left: { id: item.left.id, name: item.left.name, type: item.left.type },
                right: { id: item.right.id, name: item.right.name, type: item.right.type },
                similarity: Number(item.similarity.toFixed(2)),
            }));
    }

    private mergeNodeContent(keepContent: string, mergeContent: string): string {
        const left = String(keepContent || '').trim();
        const right = String(mergeContent || '').trim();
        if (!left) return right;
        if (!right) return left;
        if (left === right) return left;
        if (left.includes(right)) return left;
        if (right.includes(left)) return right;
        return `${left}\n\n---\n\n${right}`;
    }

    private normalizeText(value: string): string {
        return value
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private stringSimilarity(left: string, right: string): number {
        const a = this.normalizeText(left);
        const b = this.normalizeText(right);
        if (!a || !b) return 0;
        if (a === b) return 1;

        const aTokens = new Set(a.split(' ').filter(Boolean));
        const bTokens = new Set(b.split(' ').filter(Boolean));
        const shared = [...aTokens].filter((token) => bTokens.has(token)).length;
        const tokenScore = shared / Math.max(aTokens.size, bTokens.size, 1);
        const substringBonus = a.includes(b) || b.includes(a) ? 0.15 : 0;

        return Math.min(1, tokenScore + substringBonus);
    }
}

function formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    const parts: string[] = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(' ');
}

function formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) {
        size /= 1024;
        i++;
    }
    return `${size.toFixed(1)} ${units[i]}`;
}

