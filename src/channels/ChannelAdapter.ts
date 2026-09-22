/**
 * ChannelAdapter — Interface comum para todos os canais de entrada/saída
 *
 * Cada canal (Telegram, Discord, Signal, WhatsApp, etc.) implementa
 * esta interface para normalizar mensagens de/para o AgentLoop.
 *
 * Inspirado no OpenClaw Gateway, mas integrado ao NewClaw.
 */

import path from 'path';

export type ChannelType = 'telegram' | 'discord' | 'signal' | 'whatsapp' | 'web';

/** Mensagem normalizada de qualquer canal */
export interface NormalizedMessage {
    /** ID único da mensagem no canal */
    messageId: string;
    /** Canal de origem */
    channel: ChannelType;
    /** ID do usuário no canal */
    userId: string;
    /** Nome do usuário (se disponível) */
    userName?: string;
    /** Tipo de conteúdo */
    type: 'text' | 'photo' | 'audio' | 'voice' | 'document' | 'video' | 'command';
    /** Texto da mensagem ou legenda */
    text: string;
    /** Anexos (fotos, áudio, etc.) */
    attachments?: ChannelAttachment[];
    /** Metadados específicos do canal */
    metadata?: Record<string, unknown>;
    /** Responder a (thread/conversation) */
    replyToId?: string;
    /** Contexto do canal (ctx original) para responder */
    rawContext?: unknown;
    /** Chat ID para responder (usado por Discord e canais com múltiplos canais) */
    chatId?: string;
}

export interface ChannelAttachment {
    type: 'photo' | 'audio' | 'voice' | 'document' | 'video';
    /** ID do arquivo no canal de origem (Telegram etc). Ausente em canais que enviam o conteúdo inline (ex: web via `data`). */
    fileId?: string;
    mimeType?: string;
    fileName?: string;
    width?: number;
    height?: number;
    duration?: number;
    /** Base64 content (populado após download) */
    data?: string;
    /** URL para download direto (Discord usa isso) */
    url?: string;
}

/** Resposta normalizada do agente para qualquer canal */
export interface NormalizedResponse {
    text: string;
    /** Formato da resposta */
    format: 'markdown' | 'html' | 'plain';
    /** Anexos (áudio, documento, etc.) */
    attachments?: ResponseAttachment[];
    /** Reações (emoji) */
    reactions?: string[];
    /** Reply to message ID */
    replyToId?: string;
    /** Opções interativas (botões) */
    options?: ResponseOption[];
}

export interface ResponseOption {
    label: string;
    value: string;
}

export interface ResponseAttachment {
    type: 'audio' | 'document' | 'photo';
    data: Buffer | string;  // Buffer ou filepath
    fileName?: string;
    mimeType?: string;
}

// Movido de dashboard/routes/chat.ts (issue 040/041, 22/09/2026): a mesma serialização
// (Buffer → base64, extensão → mimetype) agora é consumida também por conversationRepository.ts
// (Core, para persistir o anexo entregue) — Core nunca pode importar de dashboard/ (ver
// docs/ARCHITECTURE.md, "Dependências proibidas"), então a lógica compartilhada mora aqui, o
// módulo-folha neutro que os dois lados já importam. dashboard/routes/chat.ts reexporta os
// mesmos nomes para não quebrar call sites nem o teste S14 que já importa de lá.
//
// Anexos de SAÍDA (arquivos gerados pelo agente via send_document/send_audio) chegam como
// Buffer puro — Telegram/Discord não precisam de mimetype (a própria API do canal infere), mas o
// navegador precisa de um Blob com `type` correto pra abrir/baixar direito. Cobre só as extensões
// que as skills deste projeto realmente geram (pptx-generator, html-pdf-converter, marp) — sem
// dependência nova (pacote `mime`) para uma lista pequena e estável.
const EXT_MIME: Record<string, string> = {
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pdf': 'application/pdf',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.zip': 'application/zip',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.mp4': 'video/mp4',
};
export function mimeTypeForFile(fileName: string): string {
    return EXT_MIME[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
}

/** Serializa ResponseAttachment (data: Buffer | string) para JSON — base64 puro. */
export function serializeAttachment(a: ResponseAttachment): { type: string; fileName?: string; mimeType: string; data: string } {
    const fileName = a.fileName || 'arquivo';
    return {
        type: a.type,
        fileName,
        mimeType: a.mimeType || mimeTypeForFile(fileName),
        data: Buffer.isBuffer(a.data) ? a.data.toString('base64') : String(a.data),
    };
}

/** Tipo de ação de digitação para o canal */
export type TypingAction = 'typing' | 'upload_photo' | 'record_video' | 'record_voice' | 'upload_document';

/** Configuração de reconexão automática */
export interface ReconnectConfig {
    /** Habilitar auto-reconexão em caso de falha */
    enabled: boolean;
    /** Atraso inicial em segundos antes da primeira tentativa */
    initialDelaySeconds: number;
    /** Fator de multiplicação para backoff exponencial */
    backoffMultiplier: number;
    /** Atraso máximo em segundos */
    maxDelaySeconds: number;
    /** Número máximo de tentativas (0 = ilimitado) */
    maxRetries: number;
}

/** Configuração padrão de reconexão */
export const DEFAULT_RECONNECT_CONFIG: ReconnectConfig = {
    enabled: true,
    initialDelaySeconds: 10,
    backoffMultiplier: 2,
    maxDelaySeconds: 300, // 5 minutos
    maxRetries: 0, // ilimitado
};

/** Interface que cada canal deve implementar */
export interface ChannelAdapter {
    /** Tipo do canal */
    readonly channelType: ChannelType;
    /** Nome de exibição */
    readonly displayName: string;
    /** Se o canal está conectado */
    readonly isConnected: boolean;
    /**
     * true quando o próprio adapter já gerencia reconexão/backoff/circuit-breaker
     * internamente (ex.: TelegramAdapter + TelegramPollingSupervisor). Quando true, o
     * MessageBus NÃO agenda seu próprio `scheduleAdapterReconnect` para este adapter —
     * evita dois mecanismos de reconexão concorrentes e descoordenados sobre a mesma
     * conexão (auditoria adversarial 2026-07-12, achado B1). Adapters sem supervisor
     * próprio deixam este campo undefined/false e continuam usando o reconnect do bus.
     */
    readonly selfHealing?: boolean;

    /** Iniciar o adapter */
    start(): Promise<void>;
    /** Parar o adapter */
    stop(): Promise<void>;
    /**
     * Enviar mensagem para o canal.
     *
     * Retorno opcional (issue 040/041, campanha "sistema não utilizável", 22/09/2026): um
     * adapter que mescla anexos acumulados via sendDocument()/sendVoice() ANTES de entregar
     * (ex.: WebChannelAdapter, que só resolve o texto e os anexos juntos no outbox) pode
     * devolver o `NormalizedResponse` final — o que o usuário realmente recebeu, texto e
     * anexos — para que o chamador persista isso no histórico (ver `SessionManager.
     * recordAssistantMessage`). Sem isso, MessageBus/AgentController nunca sabem que um anexo
     * foi mesclado dentro do adapter, e o histórico salvo no banco só tem o texto — motivo
     * pelo qual um PPTX entregue "sumia" de uma conversa reaberta depois. Adapters que não
     * mesclam nada (Telegram/Discord/WhatsApp/Signal, que enviam anexo direto à plataforma,
     * que já é o registro permanente) continuam retornando `void` — mudança aditiva, nenhum
     * adapter existente precisa mudar.
     */
    send(response: NormalizedResponse, context: unknown): Promise<NormalizedResponse | void>;
    /** Enviar mensagem diretamente para um chatId (sem rawContext — usado pelo Scheduler) */
    sendToChat?(chatId: string, response: NormalizedResponse): Promise<void>;
    /** Verificar saúde */
    healthCheck(): Promise<{ ok: boolean; details?: string }>;
    /** Enviar indicador de digitação ao canal (typing, recording, etc.) */
    sendTypingIndicator?(context: unknown, action?: TypingAction): Promise<void>;
    /** Baixar arquivo por fileId (ex: Telegram getFile + download) */
    downloadFile?(fileId: string): Promise<Buffer>;
    /** Enviar áudio/voz para um chatId específico */
    sendVoice?(chatId: string, buffer: Buffer, filename?: string): Promise<void>;
    /** Enviar documento para um chatId específico */
    sendDocument?(chatId: string, buffer: Buffer, filename: string, caption?: string): Promise<void>;
}

/** Configuração base para qualquer canal */
export interface ChannelConfig {
    enabled: boolean;
    [key: string]: unknown;
}

/** Sessão de canal (mapeia userId → SessionKey) */
export interface ChannelSession {
    channel: ChannelType;
    userId: string;
    userName?: string;
}