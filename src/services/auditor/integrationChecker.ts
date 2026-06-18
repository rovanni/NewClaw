import fs from 'fs';
import { createLogger } from '../../shared/AppLogger';
import { errorMessage } from '../../shared/errors';
import { AuditConfig, AuditFinding, OllamaModelsResponse } from './types';
import { which, diskUsagePercent, countNodeProcesses, isWindows } from '../../utils/crossPlatform';

const log = createLogger('AuditIntegrationChecker');

export async function auditIntegration(config: AuditConfig): Promise<AuditFinding[]> {
    const findings: AuditFinding[] = [];

    // 1. Ollama (LLM provider)
    try {
        const ollamaUrl = config.ollamaUrl.replace(/\/api\/generate$/, '');
        const response = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) {
            findings.push({
                severity: 'critical',
                category: 'integration',
                title: 'Ollama retornou erro',
                description: `Status: ${response.status}`,
                suggestion: 'Verificar se o Ollama está rodando: systemctl status ollama',
                autoFixable: false,
                riskLevel: 'high'
            });
        } else {
            try {
                const models = await response.json() as OllamaModelsResponse;
                const modelNames = (models?.models || []).map(m => m.name);
                if (modelNames.length === 0) {
                    findings.push({
                        severity: 'warning',
                        category: 'integration',
                        title: 'Nenhum modelo Ollama disponível',
                        description: 'Ollama está rodando mas não tem modelos baixados.',
                        suggestion: 'Baixar modelo: ollama pull glm-5.1:cloud',
                        autoFixable: false,
                        riskLevel: 'medium'
                    });
                }
            } catch (e) { log.debug('audit_check_skipped', String(e)); }
        }
    } catch (e) {
        findings.push({
            severity: 'critical',
            category: 'integration',
            title: 'Ollama inacessível',
            description: errorMessage(e),
            suggestion: 'Iniciar Ollama: ollama serve',
            autoFixable: false,
            riskLevel: 'high'
        });
    }

    const channelStatuses: { channel: string; connected: boolean; detail: string }[] = [];

    // 2. Telegram
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    if (telegramToken) {
        try {
            const response = await fetch(`https://api.telegram.org/bot${telegramToken}/getMe`, {
                signal: AbortSignal.timeout(5000)
            });
            const data = await response.json() as Record<string, unknown>;
            if (data.ok) {
                const botName = (data.result as Record<string, unknown>)?.username || 'unknown';
                channelStatuses.push({ channel: 'Telegram', connected: true, detail: `@${String(botName)}` });
            } else {
                channelStatuses.push({ channel: 'Telegram', connected: false, detail: `API erro: ${String(data.error_code || data.description)}` });
                findings.push({
                    severity: 'critical',
                    category: 'integration',
                    title: 'Token Telegram inválido',
                    description: `A API do Telegram rejeitou o token.`,
                    suggestion: 'Verificar TELEGRAM_BOT_TOKEN no .env',
                    autoFixable: false,
                    riskLevel: 'high'
                });
            }
        } catch (e) {
            channelStatuses.push({ channel: 'Telegram', connected: false, detail: errorMessage(e) });
            findings.push({
                severity: 'warning',
                category: 'integration',
                title: 'Telegram API inacessível',
                description: errorMessage(e),
                suggestion: 'Verificar conexão com api.telegram.org',
                autoFixable: false,
                riskLevel: 'medium'
            });
        }
    } else {
        channelStatuses.push({ channel: 'Telegram', connected: false, detail: 'TELEGRAM_BOT_TOKEN não configurado' });
    }

    // 3. Discord
    const discordToken = process.env.DISCORD_BOT_TOKEN;
    if (discordToken) {
        try {
            const response = await fetch('https://discord.com/api/v10/users/@me', {
                headers: { Authorization: `Bot ${discordToken}` },
                signal: AbortSignal.timeout(5000)
            });
            if (response.ok) {
                const data = await response.json() as Record<string, unknown>;
                channelStatuses.push({ channel: 'Discord', connected: true, detail: String(data.username || 'connected') });
            } else {
                channelStatuses.push({ channel: 'Discord', connected: false, detail: `HTTP ${response.status}` });
                findings.push({
                    severity: 'critical',
                    category: 'integration',
                    title: 'Discord Bot Token inválido',
                    description: `Discord API retornou ${response.status}. Token pode estar revogado.`,
                    suggestion: 'Verificar DISCORD_BOT_TOKEN no .env e regenerar no Discord Developer Portal se necessário',
                    autoFixable: false,
                    riskLevel: 'high'
                });
            }
        } catch (e) {
            channelStatuses.push({ channel: 'Discord', connected: false, detail: errorMessage(e) });
            findings.push({
                severity: 'warning',
                category: 'integration',
                title: 'Discord API inacessível',
                description: errorMessage(e),
                suggestion: 'Verificar conexão com discord.com',
                autoFixable: false,
                riskLevel: 'medium'
            });
        }
    } else {
        channelStatuses.push({ channel: 'Discord', connected: false, detail: 'DISCORD_BOT_TOKEN não configurado' });
    }

    // 4. WhatsApp (Baileys — no remote API to check; verify auth dir exists)
    const whatsappNumber = process.env.WHATSAPP_PHONE_NUMBER;
    const whatsappAuthDir = process.env.WHATSAPP_AUTH_DIR || './data/whatsapp-auth';
    if (whatsappNumber) {
        const authExists = fs.existsSync(whatsappAuthDir);
        if (authExists) {
            channelStatuses.push({ channel: 'WhatsApp', connected: true, detail: `${whatsappNumber} (auth dir ok)` });
        } else {
            channelStatuses.push({ channel: 'WhatsApp', connected: false, detail: 'Auth dir não encontrado — precisa escanear QR' });
            findings.push({
                severity: 'warning',
                category: 'integration',
                title: 'WhatsApp auth não configurado',
                description: `Diretório ${whatsappAuthDir} não existe. WhatsApp precisa de escaneamento QR.`,
                suggestion: 'Iniciar o bot e escanear QR code para autenticar WhatsApp',
                autoFixable: false,
                riskLevel: 'medium'
            });
        }
    } else {
        channelStatuses.push({ channel: 'WhatsApp', connected: false, detail: 'WHATSAPP_PHONE_NUMBER não configurado' });
    }

    // 5. Signal
    const signalNumber = process.env.SIGNAL_PHONE_NUMBER;
    const rawSignalPath = process.env.SIGNAL_CLI_PATH || 'signal-cli';
    // Validar antes de injetar em execSync: apenas caracteres seguros para paths de executável
    const signalCliPath = /^[a-zA-Z0-9_.\-/]+$/.test(rawSignalPath) ? rawSignalPath : 'signal-cli';
    if (signalNumber) {
        try {
            const signalResult = which(signalCliPath) ? signalCliPath : 'not_found';
            if (signalResult === 'not_found') {
                channelStatuses.push({ channel: 'Signal', connected: false, detail: 'signal-cli não instalado' });
                findings.push({
                    severity: 'warning',
                    category: 'integration',
                    title: 'signal-cli não encontrado',
                    description: `SIGNAL_PHONE_NUMBER configurado mas ${signalCliPath} não está instalado.`,
                    suggestion: 'Instalar signal-cli: https://github.com/AsamK/signal-cli',
                    autoFixable: false,
                    riskLevel: 'medium'
                });
            } else {
                channelStatuses.push({ channel: 'Signal', connected: true, detail: `${signalNumber} (cli ok)` });
            }
        } catch (e) {
            channelStatuses.push({ channel: 'Signal', connected: false, detail: errorMessage(e) });
        }
    } else {
        channelStatuses.push({ channel: 'Signal', connected: false, detail: 'SIGNAL_PHONE_NUMBER não configurado' });
    }

    // 6. Dashboard (Web)
    const dashboardPort = process.env.DASHBOARD_PORT || '3090';
    try {
        const dashResponse = await fetch(`http://localhost:${dashboardPort}/`, { signal: AbortSignal.timeout(3000) });
        if (dashResponse.ok) {
            channelStatuses.push({ channel: 'Web Dashboard', connected: true, detail: `porta ${dashboardPort}` });
        } else {
            channelStatuses.push({ channel: 'Web Dashboard', connected: false, detail: `HTTP ${dashResponse.status}` });
        }
    } catch (e) {
        channelStatuses.push({ channel: 'Web Dashboard', connected: false, detail: 'não responde' });
        findings.push({
            severity: 'warning',
            category: 'integration',
            title: 'Dashboard Web offline',
            description: `Dashboard na porta ${dashboardPort} não está respondendo.`,
            suggestion: 'Verificar se o DashboardServer está inicializando corretamente',
            autoFixable: false,
            riskLevel: 'low'
        });
    }

    // Channel summary finding
    const connectedCount = channelStatuses.filter(c => c.connected).length;
    const totalChannels = channelStatuses.length;
    if (connectedCount === 0) {
        findings.push({
            severity: 'critical',
            category: 'integration',
            title: 'Nenhum canal conectado',
            description: 'Nenhum canal (Telegram, Discord, WhatsApp, Signal, Web) está funcional.',
            suggestion: 'Verificar .env e reiniciar o bot.',
            autoFixable: false,
            riskLevel: 'high'
        });
    } else if (connectedCount < totalChannels) {
        const offlineChannels = channelStatuses.filter(c => !c.connected).map(c => c.channel).join(', ');
        findings.push({
            severity: 'info',
            category: 'integration',
            title: `${connectedCount}/${totalChannels} canais conectados`,
            description: `Canais offline: ${offlineChannels}`,
            suggestion: 'Configurar tokens/chaves no .env para canais desejados',
            autoFixable: false,
            riskLevel: 'low'
        });
    }

    // Disk usage
    try {
        const usage = diskUsagePercent();
        if (usage !== null && usage > 85) {
            findings.push({
                severity: usage > 95 ? 'critical' : 'warning',
                category: 'runtime',
                title: `Disco ${usage}% cheio`,
                description: 'Pouco espaço em disco pode causar falhas no SQLite e logs.',
                suggestion: 'Limpar logs antigos, backups e arquivos temporários.',
                autoFixable: false,
                riskLevel: usage > 95 ? 'high' : 'medium'
            });
        }
    } catch (e) { log.debug('audit_check_skipped', String(e)); }

    // Node.js version
    try {
        const nodeVersion = process.version;
        const major = parseInt(nodeVersion.slice(1).split('.')[0]);
        if (major < 18) {
            findings.push({
                severity: 'warning',
                category: 'runtime',
                title: `Node.js ${nodeVersion} desatualizado`,
                description: 'Versões < 18 podem ter vulnerabilidades e falta de features.',
                suggestion: 'Atualizar para Node.js 18+ LTS',
                autoFixable: false,
                riskLevel: 'medium'
            });
        }
    } catch (e) { log.debug('audit_check_skipped', String(e)); }

    // Process health
    try {
        const processCount = countNodeProcesses('newclaw') ?? countNodeProcesses('dist/index') ?? 0;
        if (processCount < 1) {
            findings.push({
                severity: 'critical',
                category: 'integration',
                title: 'NewClaw pode estar offline',
                description: 'Nenhum processo newclaw encontrado. Bot pode estar parado.',
                suggestion: isWindows ? 'Verificar: pm2 list ou newclaw status' : 'Verificar: pm2 list ou ./start.sh restart',
                autoFixable: false,
                riskLevel: 'high'
            });
        }
    } catch (e) { log.debug('audit_check_skipped', String(e)); }

    return findings;
}
