/**
 * channels/index.ts — Export barrel
 * 
 * Facilita import: import { MessageBus, TelegramAdapter, ... } from '../channels'
 */

export { ChannelAdapter, type ChannelType, type NormalizedMessage, type NormalizedResponse, type ChannelAttachment, type ChannelSession, type ChannelConfig } from './ChannelAdapter';
export { MessageBus } from './MessageBus';
export { TelegramAdapter, type TelegramConfig } from './TelegramAdapter';
export { DiscordAdapter, type DiscordConfig } from './DiscordAdapter';