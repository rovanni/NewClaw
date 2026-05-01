/**
 * DiscordAdapter — ChannelAdapter para Discord.js
 * 
 * Stub — estrutura pronta para implementação futura.
 * Quando quiser ativar Discord, preencha os métodos.
 */

import {
    ChannelAdapter,
    ChannelType,
    NormalizedResponse,
    ChannelConfig
} from './ChannelAdapter';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('DiscordAdapter');

export interface DiscordConfig extends ChannelConfig {
    botToken: string;
    allowedGuildIds?: string[];
    allowedUserIds?: string[];
}

export class DiscordAdapter implements ChannelAdapter {
    readonly channelType: ChannelType = 'discord';
    readonly displayName: string = 'Discord';
    private _isConnected: boolean = false;

    private config: DiscordConfig;

    constructor(config: DiscordConfig) {
        this.config = config;
    }

    get isConnected(): boolean {
        return this._isConnected && !!this.config.botToken;
    }

    async start(): Promise<void> {
        if (!this.config.enabled) {
            log.info('adapter_disabled', 'Discord adapter is disabled');
            return;
        }
        // TODO: Initialize discord.js Client
        // const { Client, GatewayIntentBits } = require('discord.js');
        // this.client = new Client({ intents: [...] });
        // await this.client.login(this.config.botToken);
        log.warn('adapter_stub', 'Discord adapter is a stub — not yet implemented');
    }

    async stop(): Promise<void> {
        // TODO: this.client.destroy();
        this._isConnected = false;
        log.info('bot_stopped', 'Discord Bot stopped');
    }

    async send(response: NormalizedResponse, context: any): Promise<void> {
        // TODO: Send message to Discord channel
        // context.channel.send(response.text);
        log.warn('send_stub', 'Discord send not implemented');
    }

    async healthCheck(): Promise<{ ok: boolean; details?: string }> {
        return { ok: false, details: 'Discord adapter not yet implemented' };
    }
}