export interface NewClawConfig {
    telegramBotToken: string;
    telegramAllowedUserIds: string[];
    discordBotToken?: string;
    discordAllowedGuildIds?: string[];
    discordAllowedUserIds?: string[];
    whatsappPhoneNumber?: string;
    whatsappAllowedJids?: string[];
    whatsappAuthDir?: string;
    signalPhoneNumber?: string;
    signalAllowedNumbers?: string[];
    signalCliPath?: string;
    language: string;
    defaultProvider: string;
    geminiApiKey?: string;
    deepseekApiKey?: string;
    groqApiKey?: string;
    openrouterApiKey?: string;
    anthropicApiKey?: string;
    ollamaUrl?: string;
    ollamaModel?: string;
    ollamaApiKey?: string;
    maxIterations: number;
    memoryWindowSize: number;
    skillsDir: string;
    tmpDir: string;
    whisperPath: string;
    dashboardPort?: number;
    ownerName?: string;
    ownerUserId?: string;
    ownerLocked?: boolean;
    systemPrompt?: string;
    customModels?: string[];
    /** Pasta onde o usuário guarda arquivos de modelo locais (.gguf). Sempre vazia por padrão e
     *  configurada por quem instala — um caminho embutido no código só funcionaria na máquina de
     *  quem o escreveu, e este projeto é distribuído para Windows, Linux e macOS. */
    localModelsDir?: string;
    /** Opções extras de carregamento por arquivo de modelo: `{ "modelo.gguf": "-fit off --n-gpu-layers 12" }`.
     *  Nunca vem preenchido de fábrica — o valor certo depende da GPU e da RAM de CADA máquina
     *  (`--n-gpu-layers 12` é a divisão ideal numa placa de 16GB e errada em outra), então é
     *  configuração de ambiente, não conhecimento que o projeto possa distribuir. */
    localModelOptions?: Record<string, string>;
    /** Preferência do Directory Picker (campanha FP–FP.6.3): dentro do que a política do
     *  ambiente (`NEWCLAW_NATIVE_DIRECTORY_PICKER`, lida direto de `process.env`, nunca guardada
     *  aqui) permitir, o operador escolhe se o Wizard tenta o seletor nativo do SO por padrão ou
     *  vai direto pro navegador de pasta web. Persiste mesmo com a política negada — só fica sem
     *  efeito enquanto ela negar, nunca é apagada automaticamente (evita forçar reconfiguração se
     *  a política for religada depois). Ausente = 'native' (tenta nativo quando a política permite
     *  — o comportamento padrão já estabelecido nas sprints de investigação). */
    directoryPickerPreference?: 'native' | 'web';
    customProviders?: { label: string; baseUrl: string; apiKey?: string; model?: string }[];
    modelRouter?: {
        chat?: string;
        code?: string;
        vision?: string;
        light?: string;
        analysis?: string;
        execution?: string;
        visionServer?: string;
        classifierModel?: string;
        classifierServer?: string;
        // Provider por perfil — se ausente, usa defaultProvider
        provider_chat?: string;
        provider_code?: string;
        provider_vision?: string;
        provider_light?: string;
        provider_analysis?: string;
        provider_execution?: string;
        // Modelos dos componentes internos
        plannerModel?: string;
        riskModel?: string;
        observerModel?: string;
    };
}
