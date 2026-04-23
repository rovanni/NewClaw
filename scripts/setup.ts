/**
 * Setup interativo do NewClaw
 * Adaptado do IalClaw
 * 
 * Uso: npx tsx scripts/setup.ts
 */
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';

function parseEnvFile(envPath: string): Record<string, string> {
    if (!fs.existsSync(envPath)) return {};
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    const env: Record<string, string> = {};
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
        const [key, ...rest] = trimmed.split('=');
        env[key.trim()] = rest.join('=').trim();
    }
    return env;
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (query: string): Promise<string> => {
    return new Promise(resolve => rl.question(query, resolve));
};

async function runSetup() {
    const envPath = path.join(process.cwd(), '.env');
    const currentEnv = parseEnvFile(envPath);

    console.log('\n==========================================');
    console.log(' 🛠️  Configuração Interativa do NewClaw  🛠️ ');
    console.log('==========================================\n');
    console.log('Vamos configurar passo a passo. Enter = manter atual.\n');

    // Idioma
    const currentLang = currentEnv.APP_LANG || 'pt-BR';
    console.log(`0. Idioma (atual: ${currentLang}):`);
    console.log('   1 - English (en-US)');
    console.log('   2 - Português (pt-BR)');
    const langOption = (await question('Digite 1 ou 2 [padrão: 2]: ')).trim();
    const finalLang = langOption === '1' ? 'en-US' : 'pt-BR';

    // Ollama
    const currentUseOllama = currentEnv.USE_OLLAMA || 'true';
    const useOllama = (await question(`1. Usar Ollama local? (s/n) [atual: ${currentUseOllama}]: `)).trim().toLowerCase();
    const finalUseOllama = useOllama === 'n' || useOllama === 'nao' || useOllama === 'não' ? 'false' : 'true';

    const currentOllamaHost = currentEnv.OLLAMA_HOST || 'http://127.0.0.1:11434';
    const ollamaHost = (await question(`2. Endereço do Ollama [atual: ${currentOllamaHost}]: `)).trim();
    const finalOllamaHost = ollamaHost || currentOllamaHost;

    const currentOllamaBin = currentEnv.OLLAMA_BIN || 'ollama';
    const ollamaBin = (await question(`3. Caminho do binário Ollama [atual: ${currentOllamaBin}]: `)).trim();
    const finalOllamaBin = ollamaBin || currentOllamaBin;

    // Modelo
    const currentModel = currentEnv.MODEL || 'glm-5.1:cloud';
    const model = (await question(`4. Modelo de IA [atual: ${currentModel}]: `)).trim();
    const finalModel = model || currentModel;

    // Embedding model
    const currentEmbedModel = currentEnv.EMBED_MODEL || 'nomic-embed-text';
    const embedModel = (await question(`5. Modelo de embeddings [atual: ${currentEmbedModel}]: `)).trim();
    const finalEmbedModel = embedModel || currentEmbedModel;

    // Telegram
    console.log('\n[DICA] Para criar um Bot no Telegram, fale com @BotFather.');
    console.log('[DICA] Se quiser só o dashboard web, deixe em branco.');

    const currentTelegramToken = currentEnv.TELEGRAM_BOT_TOKEN || '';
    const telegramToken = (await question(`6. TELEGRAM_BOT_TOKEN [atual: ${currentTelegramToken.substring(0, 10)}...]: `)).trim();
    const finalTelegramToken = telegramToken || currentTelegramToken;

    console.log('\n[DICA] Para descobrir seu ID, mande "Oi" para @userinfobot.');
    const currentTelegramId = currentEnv.TELEGRAM_ALLOWED_USER_IDS || '';
    const telegramId = (await question(`7. Seu ID do Telegram [atual: ${currentTelegramId}]: `)).trim();
    const finalTelegramId = telegramId || currentTelegramId;

    // Whisper
    const currentWhisper = currentEnv.WHISPER_API_URL || '';
    const whisperUrl = (await question(`8. Whisper API URL (ex: http://localhost:8177) [atual: ${currentWhisper}]: `)).trim();
    const finalWhisperUrl = whisperUrl || currentWhisper;

    // Dashboard
    const currentPort = currentEnv.DASHBOARD_PORT || '3090';
    const port = (await question(`9. Porta do Dashboard [atual: ${currentPort}]: `)).trim();
    const finalPort = port || currentPort;

    // Escrever .env
    const envContent = `# NewClaw Configuration
APP_LANG=${finalLang}

# Ollama
USE_OLLAMA=${finalUseOllama}
OLLAMA_HOST=${finalOllamaHost}
OLLAMA_BIN=${finalOllamaBin}

# Models
MODEL=${finalModel}
EMBED_MODEL=${finalEmbedModel}

# Telegram
TELEGRAM_BOT_TOKEN=${finalTelegramToken}
TELEGRAM_ALLOWED_USER_IDS=${finalTelegramId}

# Whisper (Speech-to-Text)
WHISPER_API_URL=${finalWhisperUrl}

# Dashboard
DASHBOARD_PORT=${finalPort}
`;

    fs.writeFileSync(envPath, envContent, 'utf8');

    console.log('\n✅ .env criado com sucesso!');
    console.log('▶️  Para iniciar: node bin/newclaw start --daemon');
    console.log(`🌐 Dashboard: http://localhost:${finalPort}`);
    if (finalTelegramToken) {
        console.log('📱 Telegram: configurado');
    }
    console.log('');

    rl.close();
}

runSetup().catch(console.error);