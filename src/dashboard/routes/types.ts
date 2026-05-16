import { AgentController, NewClawConfig } from '../../core/AgentController';
import { ProviderFactory } from '../../core/ProviderFactory';
import { MemoryManager } from '../../memory/MemoryManager';
import { MemoryCurator } from '../../memory/MemoryCurator';
import { EmbeddingService } from '../../memory/EmbeddingService';
import { ClassificationMemory } from '../../memory/ClassificationMemory';
import { DecisionMemory } from '../../memory/DecisionMemory';
import { SkillInstaller } from '../../skills/SkillInstaller';
import type Database from 'better-sqlite3';

export interface DashboardContext {
    controller?: AgentController;
    providerFactory?: ProviderFactory;
    memoryManager?: MemoryManager;
    memoryCurator?: MemoryCurator;
    embeddingService?: EmbeddingService;
    classificationMemory?: ClassificationMemory;
    decisionMemory?: DecisionMemory;
    skillInstaller?: SkillInstaller;
    config: NewClawConfig;
    db?: Database.Database;
}

export interface ExtendedConfig extends NewClawConfig { customModels?: string[] }
export interface DashboardNode { id: string; type: string; name: string; content: string; [key: string]: unknown }
export interface DashboardEdge { from_node: string; to_node: string; relation: string; weight: number; confidence?: number; [key: string]: unknown }
