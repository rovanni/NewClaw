/**
 * ToolRegistry — Registro centralizado de tools com enable/disable
 */

import { ToolExecutor, ToolResult } from '../loop/agentLoopTypes';
import { createLogger } from '../shared/AppLogger';
import { permissionRegistry } from './PermissionRegistry';
import { isReadOnlyExecCommand } from '../tools/exec_command';
const log = createLogger('Toolregistry');

/**
 * Ferramentas de entrega cujo sucesso encerra o turno. Fonte única — ver `isTerminalDelivery()`.
 *
 * Contém apenas ferramentas que EXISTEM. Até 07/08/2026 as listas duplicadas traziam também
 * `send_image` e `send_video`, que não têm arquivo em `src/tools/` nem registro: entradas mortas,
 * herdadas por cópia. Se alguma delas passar a existir, acrescentar aqui — em um lugar só.
 * `S209` falha se um nome desta lista não tiver a tool correspondente.
 */
export const TERMINAL_DELIVERY_TOOLS: readonly string[] = ['send_audio', 'send_document'];

/**
 * Ferramentas cujo `output` já é texto pronto para o usuário — não uma leitura/dump operacional
 * que precisa de síntese antes de virar resposta. Fonte única, consumida por dois caminhos de
 * entrega independentes que precisam da MESMA resposta a "posso entregar isto cru?":
 * `AgentLoop.runSynthesisAndFallbackPhase()` (bypass de síntese pós-loop) e
 * `GoalExecutionLoop.buildResult()` (fallback de `finalOutput` quando não há resumo do
 * validador). Até 14/08/2026 só o primeiro consultava isto (a constante vivia local ali) — o
 * segundo usava `lastSuccess.output` sem checar a identidade da tool, e por isso podia entregar
 * cru o dump operacional de `web_navigate`/`web_search` (URL, "Modo de navegacao: html-fallback",
 * "Resultados encontrados: 0") como se fosse a resposta final. Evidência real, 14/08/2026,
 * goal_1786759205879_fmpwq: `StepSemanticValidator` promoveu esse dump a "success" e o usuário
 * recebeu o texto de diagnóstico da ferramenta, não uma resposta.
 *
 * Pertinência de conjunto (`Este valor pertence a este enum?`) é pergunta determinística —
 * `docs/ARCHITECTURE/RESPONSABILIDADE_ANTES_DO_MECANISMO.md` lista exatamente esse tipo de
 * checagem como apropriada a determinismo, e cita `TERMINAL_DELIVERY_TOOLS.includes()` (acima)
 * como contra-exemplo legítimo do mesmo formato. Curada manualmente, não descoberta por
 * heurística: `weather`/`crypto_analysis` produzem prosa/tabela finais por design; qualquer tool
 * nova entra aqui só por decisão explícita, nunca por inferência sobre o formato do output.
 */
export const DIRECT_DELIVERABLE_TOOLS: readonly string[] = ['weather', 'crypto_analysis'];

interface ToolEntry {
    tool: ToolExecutor;
    enabled: boolean;
    dangerous: boolean;  // ex: exec_command
}

export class ToolRegistryClass {
    private tools: Map<string, ToolEntry> = new Map();

    register(tool: ToolExecutor, options?: { dangerous?: boolean }): void {
        if (this.tools.has(tool.name)) {
            log.warn(`Tool "${tool.name}" already registered, skipping duplicate.`);
            return;
        }
        this.tools.set(tool.name, {
            tool,
            enabled: true,
            dangerous: options?.dangerous || false
        });
    }

    get(name: string): ToolExecutor | undefined {
        const entry = this.tools.get(name);
        return entry?.enabled ? entry.tool : undefined;
    }

    getAll(): ToolEntry[] {
        return Array.from(this.tools.values()).map(e => ({ ...e }));
    }

    getEnabled(): ToolExecutor[] {
        return Array.from(this.tools.values())
            .filter(e => e.enabled)
            .map(e => e.tool);
    }

    enable(name: string): boolean {
        const entry = this.tools.get(name);
        if (entry) { entry.enabled = true; return true; }
        return false;
    }

    disable(name: string): boolean {
        const entry = this.tools.get(name);
        if (entry) { entry.enabled = false; return true; }
        return false;
    }

    isEnabled(name: string): boolean {
        return this.tools.get(name)?.enabled || false;
    }

    isDangerous(name: string): boolean {
        return this.tools.get(name)?.dangerous || false;
    }

    /**
     * Ponto ÚNICO da pergunta "esta tool encerra o turno?".
     *
     * Uma ferramenta de entrega bem-sucedida termina o turno, e o `output` dela vira a resposta que
     * chega ao canal (`docs/ARCHITECTURE/FERRAMENTAS_DE_ENTREGA.md` §2). O `AgentLoop` consulta isso
     * em três pontos distintos de encerramento; antes desta consolidação, a lista estava escrita
     * literalmente nos três, idêntica — a próxima ferramenta de entrega provavelmente entraria em um
     * ou dois deles. É a mesma razão que levou `requiresAuthorization()` para cá (`ADR-005` §4.1):
     * regra copiada diverge na primeira mudança.
     *
     * **Não confundir com `TERMINAL_TOOLS` do `CMIBuffer`**, que é outro conceito: lá a lista marca
     * "conclusão de workflow" para decidir corte de chunk na memória conversacional, e por isso
     * inclui `write`/`edit`, que não encerram turno nenhum. As duas listas divergem de propósito.
     *
     * Achado registrado em
     * `docs/analises-arquiteturais/INVESTIGACAO_TERMINO_DE_TURNO_E_FATOS_DE_ENTREGA_2026-08-07.md`.
     */
    isTerminalDelivery(name: string): boolean {
        return TERMINAL_DELIVERY_TOOLS.includes(name);
    }

    /**
     * Ponto ÚNICO da pergunta "este resultado encerra o turno agora?" (`ADR-007`).
     *
     * Encerrar o turno numa ferramenta de entrega é uma **otimização**: evita uma ida a mais ao LLM
     * quando não há nada a dizer além do conteúdo. Quando a tool devolve um fato sobre a entrega,
     * essa ida é exatamente o que falta — sem ela não existe quem verbalize o fato no idioma da
     * conversa, e o Core teria que escrever a frase, reintroduzindo o texto fixo em português que
     * `FERRAMENTAS_DE_ENTREGA.md` §5 existe para remover.
     *
     * Por isso a regra combinada mora aqui e não nos três pontos de encerramento do `AgentLoop`:
     * espalhada, ela divergiria — foi exatamente o que aconteceu com a lista de ferramentas
     * terminais antes da Sprint 025.
     */
    endsTurn(name: string, result: ToolResult): boolean {
        return this.isTerminalDelivery(name)
            && result.success
            && !(result.deliveryFacts && result.deliveryFacts.length > 0);
    }

    /**
     * Ponto ÚNICO da pergunta "esta chamada precisa de autorização humana?" (ADR-005).
     *
     * Existe aqui, e não dentro de um caminho de execução, porque a promessa do modo SAFE é do
     * sistema inteiro: `AgentLoop` (turno conversacional) e `GoalExecutionLoop` (step de plano)
     * consultam esta mesma função. Enquanto a regra morava no AgentLoop, um `exec_command`
     * planejado executava sem gate nenhum em modo SAFE — reproduzido em execução real
     * (04/08/2026, `docs/decisoes/ADR-005_ONDE_VIVE_O_GATE_DE_ACAO_PERIGOSA.md`).
     *
     * Decide por nome de tool, flag `dangerous` do registro, modo operacional e análise
     * estrutural do comando — nunca por texto de interface ou mensagem traduzida.
     */
    requiresAuthorization(name: string, args: Record<string, unknown>): boolean {
        return this.isDangerous(name)
            && !isReadOnlyExecCommand(name, args)
            && !permissionRegistry.can('auto_approve_exec');
    }

    has(name: string): boolean {
        return this.tools.has(name);
    }

    unregister(name: string): boolean {
        return this.tools.delete(name);
    }

    getStatus(): Array<{ name: string; description: string; enabled: boolean; dangerous: boolean }> {
        return Array.from(this.tools.entries()).map(([name, entry]) => ({
            name,
            description: entry.tool.description,
            enabled: entry.enabled,
            dangerous: entry.dangerous
        }));
    }
}

export const ToolRegistry = new ToolRegistryClass();
export type ToolRegistryType = InstanceType<typeof ToolRegistryClass>;