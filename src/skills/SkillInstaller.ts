/**
 * SkillInstaller — Instala skills via git, npm ou npx
 * 
 * Adaptado do IalClaw para o NewClaw.
 * Permite instalar skills a partir de repositórios Git ou pacotes npm.
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { createLogger } from '../shared/AppLogger';
const log = createLogger('Skillinstaller');

const execAsync = promisify(exec);
const DEFAULT_TIMEOUT = 60000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout após ${ms}ms`)), ms)
        )
    ]);
}

function isValidGitUrl(url: string): boolean {
    return /^https:\/\/[a-zA-Z0-9][a-zA-Z0-9.-]*\//.test(url) && !url.includes('..');
}

function sanitizeArg(arg: string): string {
    return arg.replace(/[;&|`$()]/g, '');
}

export interface InstallResult {
    success: boolean;
    data?: { path?: string; npm?: string; npx?: string; skillName?: string };
    error?: string;
}

export class SkillInstaller {
    private skillsDir: string;
    private workspaceDir: string;

    constructor(skillsDir: string = './skills', workspaceDir: string = process.cwd()) {
        this.skillsDir = skillsDir;
        this.workspaceDir = workspaceDir;
    }

    /**
     * Install a skill from git repo, npm, or npx
     */
    async install(options: {
        git?: string;
        npm?: string;
        npx?: string;
        repo?: string;
    }): Promise<InstallResult> {
        try {
            // Git clone
            const gitUrl = options.git || options.repo;
            if (gitUrl) {
                if (!isValidGitUrl(gitUrl)) {
                    return { success: false, error: 'URL de git inválida.' };
                }
                const repoName = sanitizeArg(gitUrl.split('/').pop()?.replace('.git', '') || 'unknown-skill');
                const dest = path.join(this.skillsDir, 'public', repoName);

                await withTimeout(
                    execAsync(`git clone "${gitUrl}" "${dest}"`, { cwd: this.workspaceDir }),
                    DEFAULT_TIMEOUT
                );

                return {
                    success: true,
                    data: { path: dest, skillName: repoName }
                };
            }

            // NPM package
            if (options.npm) {
                const sanitized = sanitizeArg(options.npm);
                await withTimeout(
                    execAsync(`npm install ${sanitized}`, { cwd: this.workspaceDir }),
                    DEFAULT_TIMEOUT
                );
                return { success: true, data: { npm: sanitized } };
            }

            // NPX (one-time run)
            if (options.npx) {
                const sanitized = sanitizeArg(options.npx);
                await withTimeout(
                    execAsync(`npx ${sanitized}`, { cwd: this.workspaceDir }),
                    DEFAULT_TIMEOUT
                );
                return { success: true, data: { npx: sanitized } };
            }

            return { success: false, error: 'Nenhum método de instalação fornecido (git, npm, npx).' };
        } catch (err: any) {
            log.error('[SkillInstaller] Error:', err.message);
            return { success: false, error: err.message };
        }
    }

    /**
     * List installed skills
     */
    listInstalled(): string[] {
        const fs = require('fs');
        const publicDir = path.join(this.skillsDir, 'public');

        if (!fs.existsSync(publicDir)) return [];

        return fs.readdirSync(publicDir, { withFileTypes: true })
            .filter((d: any) => d.isDirectory())
            .map((d: any) => d.name);
    }

    /**
     * Remove an installed skill
     */
    async remove(skillName: string): Promise<InstallResult> {
        const fs = require('fs');
        const skillPath = path.join(this.skillsDir, 'public', skillName);

        if (!fs.existsSync(skillPath)) {
            return { success: false, error: `Skill "${skillName}" não encontrada.` };
        }

        try {
            fs.rmSync(skillPath, { recursive: true, force: true });
            return { success: true, data: { skillName } };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }
}