/**
 * SkillLoader — Carrega skills via hot-reload
 * 
 * Skills são definidas em SKILL.md com frontmatter YAML
 * Carregamento síncrono a cada request (1ms por skill)
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '../shared/AppLogger';
const log = createLogger('Skillloader');

export interface SkillMeta {
    name: string;
    description: string;
    version?: string;
    triggers?: string[];
    tools?: string[];
}

export interface Skill extends SkillMeta {
    content: string;  // Conteúdo completo do SKILL.md
}

export class SkillLoader {
    private skillsDir: string;
    private cache: Map<string, Skill> = new Map();
    private lastLoadTime: number = 0;

    constructor(skillsDir: string = './skills') {
        this.skillsDir = skillsDir;
    }

    /**
     * Carrega todas as skills do diretório
     * Hot-reload: lê do FS a cada request
     */
    loadAll(): Skill[] {
        this.cache.clear();

        const skillsDir = this.resolveSkillsDir();
        if (!skillsDir) {
            log.info('Diretório de skills não encontrado:', this.skillsDir);
            return [];
        }

        const entries = fs.readdirSync(skillsDir, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;

            const skillPath = path.join(skillsDir, entry.name, 'SKILL.md');
            if (!fs.existsSync(skillPath)) continue;

            try {
                const skill = this.loadSkill(skillPath);
                if (skill) {
                    this.cache.set(skill.name, skill);
                    log.info(`Carregada: ${skill.name} - ${skill.description}`);
                }
            } catch (error: any) {
                log.error(`Erro ao carregar ${entry.name}:`, error.message);
            }
        }

        this.lastLoadTime = Date.now();
        return Array.from(this.cache.values());
    }

    private resolveSkillsDir(): string | null {
        if (fs.existsSync(this.skillsDir)) {
            return this.skillsDir;
        }

        const legacyDir = './workspace/skills';
        const defaultDir = './skills';

        if (this.skillsDir === legacyDir && fs.existsSync(defaultDir)) {
            log.info(`Fallback automático: usando ${defaultDir} no lugar de ${legacyDir}`);
            this.skillsDir = defaultDir;
            return this.skillsDir;
        }

        return null;
    }

    /**
     * Carrega uma skill individual
     */
    private loadSkill(skillPath: string): Skill | null {
        const content = fs.readFileSync(skillPath, 'utf-8');
        const meta = this.parseFrontmatter(content);

        if (!meta.name) {
            log.warn(`SKILL.md sem nome: ${skillPath}`);
            return null;
        }

        return {
            ...meta,
            content: this.stripFrontmatter(content)
        };
    }

    /**
     * Parser de frontmatter YAML simples
     */
    private parseFrontmatter(content: string): SkillMeta {
        const match = content.match(/^---\n([\s\S]*?)\n---/);
        if (!match) return { name: '', description: '' };

        const frontmatter = match[1];
        const meta: SkillMeta = { name: '', description: '' };

        for (const line of frontmatter.split('\n')) {
            const [key, ...values] = line.split(':');
            const value = values.join(':').trim();
            
            switch (key.trim()) {
                case 'name':
                    meta.name = value;
                    break;
                case 'description':
                    meta.description = value;
                    break;
                case 'version':
                    meta.version = value;
                    break;
                case 'triggers':
                    meta.triggers = value.split(',').map(s => s.trim());
                    break;
                case 'tools':
                    meta.tools = value.split(',').map(s => s.trim());
                    break;
            }
        }

        return meta;
    }

    /**
     * Remove frontmatter do conteúdo
     */
    private stripFrontmatter(content: string): string {
        return content.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
    }

    /**
     * Retorna skill pelo nome
     */
    getSkill(name: string): Skill | undefined {
        return this.cache.get(name);
    }

    /**
     * Retorna todas as skills
     */
    getAllSkills(): Skill[] {
        return Array.from(this.cache.values());
    }

    /**
     * Retorna resumo das skills para o router
     */
    getSkillSummaries(): string {
        const skills = this.getAllSkills();
        if (skills.length === 0) return '';

        return skills.map(s => `- ${s.name}: ${s.description}`).join('\n');
    }

    /**
     * Retorna skill names para detecção de intenção
     */
    getSkillNames(): string[] {
        return Array.from(this.cache.keys());
    }
}
