/**
 * resolveInstallCommand — decide QUAL comando de instalação usar para uma DependencyInfo,
 * dado o sistema operacional real detectado — nunca lendo `process.platform` diretamente
 * (recebe as capacidades já detectadas como parâmetro, puro e testável sem SO real).
 *
 * ACHADO que motivou esta função: `KNOWN_DEPS` (GoalEvaluator.ts) tem 19 de 20 entradas com
 * `installCmd` fixo em `sudo apt install X -y` (Linux/Debian apenas) — `GoalExecutionLoop.ts`
 * injetava esse valor VERBATIM em `exec_command` no fluxo `needs_dependency`, sem checar SO.
 * Num Windows, isso executaria um comando inexistente ("sudo"/"apt" não existem lá).
 *
 * REGRA DE SEGURANÇA ABSOLUTA: installCmd legado só é usado como fallback quando platform
 * === 'linux'. Fora de Linux, sem uma entrada explícita em installByPlatform para a
 * plataforma atual, retorna undefined — nunca tenta traduzir, adivinhar, ou cair no legado.
 */

import { DependencyInfo } from '../GoalTypes';

export interface MinimalOSCapabilities {
    platform: 'windows' | 'linux' | 'macos';
}

export function resolveInstallCommand(
    dep: DependencyInfo,
    os: MinimalOSCapabilities | null,
): string | undefined {
    if (!os) return undefined; // sem informação de SO: nunca assume, nunca arrisca

    const byPlatform = dep.installByPlatform?.[os.platform];
    if (byPlatform) return byPlatform;

    if (os.platform === 'linux' && dep.installCmd) return dep.installCmd;

    return undefined;
}
