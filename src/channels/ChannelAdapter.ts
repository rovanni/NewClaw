/**
 * ChannelAdapter — Interface comum para todos os canais de entrada/saída
 * 
 * Cada canal (Telegram, Discord, Signal, WhatsApp, etc.) implementa
 * esta interface para normalizar mensagens de/para o AgentLoop.
 * 
 * Inspirado no OpenClaw Gateway, mas integrado ao NewClaw.
 */

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
    metadata?: Record<string, any>;
    /** Responder a (thread/conversation) */
    replyToId?: string;
    /** Contexto do canal (ctx original) para responder */
    rawContext?: any;
    /** Chat ID para responder (usado por Discord e canais com múltiplos canais) */
    chatId?: string;
}

export interface ChannelAttachment {
    type: 'photo' | 'audio' | 'voice' | 'document' | 'video';
    fileId: string;
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
}

export interface ResponseAttachment {
    type: 'audio' | 'document' | 'photo';
    data: Buffer | string;  // Buffer ou filepath
    fileName?: string;
    mimeType?: string;
}

/** Tipo de ação de digitação para o canal */
export type TypingAction = 'typing' | 'upload_photo' | 'record_video' | 'record_voice' | 'upload_document';

/** Interface que cada canal deve implementar */
export interface ChannelAdapter {
    /** Tipo do canal */
    readonly channelType: ChannelType;
    /** Nome de exibição */
    readonly displayName: string;
    /** Se o canal está conectado */
    readonly isConnected: boolean;

    /** Iniciar o adapter */
    start(): Promise<void>;
    /** Parar o adapter */
    stop(): Promise<void>;
    /** Enviar mensagem para o canal */
    send(response: NormalizedResponse, context: any): Promise<void>;
    /** Verificar saúde */
    healthCheck(): Promise<{ ok: boolean; details?: string }>;
    /** Enviar indicador de digitação ao canal (typing, recording, etc.) */
    sendTypingIndicator?(context: any, action?: TypingAction): Promise<void>;
}

/** Configuração base para qualquer canal */
export interface ChannelConfig {
    enabled: boolean;
    [key: string]: any;
}

/** Sessão de canal (mapeia userId → SessionKey) */
export interface ChannelSession {
    channel: ChannelType;
    userId: string;
    userName?: string;
}