/**
 * SkillLoader — Carrega skills via hot-reload
 * 
 * Skills são definidas em SKILL.md com frontmatter YAML
 * Carregamento síncrono a cada request (1ms por skill)
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';
const log = createLogger('Skillloader');

export interface SkillMeta {
    name: string;
    description: string;
    version?: string;
    triggers?: string[];
    tools?: string[];
    /** Tags de domínio para capability-based discovery (genéricas, em inglês).
     *  Ex: ["presentation", "slides", "export", "document-generation"]
     *  Skills sem tags continuam sendo descobertas apenas por triggers. */
    tags?: string[];
}

export interface Skill extends SkillMeta {
    content: string;       // Conteúdo completo (injetado quando skill é tarefa primária)
    globalContent: string; // Conteúdo sem seções TASK_ONLY (injetado em contexto parcial)
}

export class SkillLoader {
    private skillsDir: string;
    private cache: Map<string, Skill> = new Map();
    private lastLoadTime = 0;
    // TTL de 10s: hot-reload ainda funciona para edições de skills entre requests,
    // mas evita o I/O repetido quando loadAll() é chamado múltiplas vezes no mesmo ciclo de goal.
    private static readonly CACHE_TTL_MS = 10_000;

    constructor(skillsDir: string = './skills') {
        this.skillsDir = skillsDir;
    }

    /**
     * Carrega todas as skills do diretório.
     * Hot-reload com TTL: relê do FS a cada 10s. Chamadas dentro do mesmo segundo retornam o cache.
     */
    loadAll(): Skill[] {
        const t0 = Date.now();
        const cacheAge = t0 - this.lastLoadTime;
        if (this.cache.size > 0 && cacheAge < SkillLoader.CACHE_TTL_MS) {
            log.info(`[SKILLLOAD] loaded=${this.cache.size} cached=${this.cache.size} duration_ms=0`);
            return Array.from(this.cache.values());
        }
        // Obs #8: registra quantas skills estavam em cache antes do clear (hot-reload descarta sempre)
        const prevCacheSize = this.cache.size;
        this.cache.clear();

        const skillsDir = this.resolveSkillsDir();
        if (!skillsDir) {
            log.info('Diretório de skills não encontrado:', this.skillsDir);
            log.info(`[SKILLLOAD] loaded=0 cached=${prevCacheSize} duration_ms=${Date.now() - t0}`);
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
            } catch (error) {
                log.error(`Erro ao carregar ${entry.name}:`, errorMessage(error));
            }
        }

        const duration_ms = Date.now() - t0;
        this.lastLoadTime = t0;
        log.info(`[SKILLLOAD] loaded=${this.cache.size} cached=${prevCacheSize} duration_ms=${duration_ms}`);
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

        const fullContent = this.stripFrontmatter(content);
        return {
            ...meta,
            content: fullContent,
            globalContent: this.stripTaskOnlySections(fullContent)
        };
    }

    /**
     * Remove seções marcadas com <!-- TASK_ONLY_START --> ... <!-- TASK_ONLY_END -->
     * do conteúdo da skill. Essas seções só são injetadas quando a skill é a
     * tarefa primária do turno (alta confiança de intenção).
     */
    private stripTaskOnlySections(content: string): string {
        return content
            .replace(/<!--\s*TASK_ONLY_START\s*-->[\s\S]*?<!--\s*TASK_ONLY_END\s*-->/g, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    /**
     * Parser de frontmatter YAML simples
     */
    private parseFrontmatter(content: string): SkillMeta {
        const match = content.match(/^---\n([\s\S]*?)\n---/);
        if (!match) return { name: '', description: '' };

        const frontmatter = match[1];
        const meta: SkillMeta = { name: '', description: '' };
        let inTagsList = false; // flag para parsear tags em formato lista YAML

        for (const line of frontmatter.split('\n')) {
            // Detectar início de lista de tags (formato multi-linha YAML)
            if (/^tags:\s*$/.test(line.trim())) {
                inTagsList = true;
                meta.tags = [];
                continue;
            }
            if (inTagsList) {
                const listItem = line.match(/^\s+-\s+(.+)/);
                if (listItem) {
                    meta.tags!.push(listItem[1].trim());
                    continue;
                }
                inTagsList = false; // fim da lista
            }
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
                case 'tags':
                    // Suporta dois formatos:
                    //   tags: presentation, slides, export          (linha única CSV)
                    //   tags:\n  - presentation\n  - slides         (lista YAML)
                    meta.tags = value
                        ? value.split(',').map(s => s.trim()).filter(Boolean)
                        : [];
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
