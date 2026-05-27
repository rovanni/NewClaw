/**
 * ResponseBuilder — Pipeline unificado de resposta.
 *
 * Consolida três responsabilidades anteriormente fragmentadas:
 *   1. Normalização de resposta LLM       (ex-ResponseAdapter)
 *   2. Formatação de resultado de tool    (ex-ResponseBuilder)
 *   3. Modulação por estado cognitivo     (ex-DecisionPostProcessor)
 *
 * Pipeline explícito: build() → adapt() → postProcess() → validate()
 *
 * Mutações de resposta permanecem EXPLÍCITAS e LOGADAS.
 * Nenhum pós-processamento oculto.
 */

import type { ParsedLLMResponse } from './ContentExtractor';
import { sanitizeContent } from './agentOutputParser';
import { AgentState } from '../core/AgentStateManager';
import { ToolResult } from './AgentLoop';

// ── Seção 1: Normalização de resposta LLM (ex-ResponseAdapter) ──────────────

/**
 * Resposta normalizada — estrutura canônica para roteamento no AgentLoop.
 * USE IN: AgentLoop, ObserverValidator, serviços que precisam rotear por tipo.
 */
export interface NormalizedResponse {
    type: 'final_answer' | 'tool' | 'error' | 'empty';
    content: string;
    thought?: string;
    evaluation?: {
        is_complete: boolean;
        confidence: 'low' | 'medium' | 'high';
        reason?: string;
    };
    toolName?: string;
    toolInput?: Record<string, unknown>;
}

/** Resultado de extração leve — apenas o texto. */
export type ExtractedText = string;

/**
 * normalizeResponse — normalização full-structure.
 * Pipeline: raw LLM → sanitizeContent → parseLLMResponse → normalizeResponse
 */
export function normalizeResponse(parsed: ParsedLLMResponse | null, rawContent: string): NormalizedResponse {
    if (parsed && typeof parsed === 'object') {
        const action = parsed.action || {};
        const evaluation = parsed.evaluation;

        if (action.type === 'tool' && action.name) {
            return {
                type: 'tool',
                content: action.content || '',
                thought: parsed.thought || undefined,
                evaluation: evaluation ? {
                    is_complete: !!evaluation.is_complete,
                    confidence: evaluation.confidence || 'medium',
                    reason: evaluation.reason,
                } : undefined,
                toolName: action.name,
                toolInput: action.input || {},
            };
        }

        if (action.type === 'final_answer' || action.content) {
            return {
                type: 'final_answer',
                content: action.content || '',
                thought: parsed.thought || undefined,
                evaluation: evaluation ? {
                    is_complete: !!evaluation.is_complete,
                    confidence: evaluation.confidence || 'medium',
                    reason: evaluation.reason,
                } : undefined,
            };
        }
    }

    if (rawContent && rawContent.trim().length > 0) {
        return { type: 'final_answer', content: rawContent.trim() };
    }

    return { type: 'empty', content: '' };
}

/**
 * extractText — extração leve de texto.
 * USE IN: ContextCompressor, ContextValidator, OnboardingService.
 * Sem estrutura, sem avaliação, sem roteamento — apenas texto legível.
 */
export function extractText(content: string): ExtractedText {
    if (!content || !content.trim()) return '';

    try {
        const parsed = JSON.parse(content);
        if (parsed?.action?.content) return parsed.action.content;
        if (parsed?.content) return parsed.content;
        if (typeof parsed === 'string') return parsed;
    } catch { /* não é JSON */ }

    try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed?.action?.content) return parsed.action.content;
            if (parsed?.content) return parsed.content;
        }
    } catch { /* não é JSON */ }

    let text = content;
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
    text = text.replace(/<\/?think>/gi, '');
    text = text.replace(/\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/gi, '');

    const codeFenceMatch = text.match(/^```[\s\S]*?```\s*$/);
    if (codeFenceMatch) {
        text = text.replace(/^```\w*\n?/, '').replace(/\n?```\s*$/, '');
    }

    return text.trim();
}

/**
 * normalizeFromRaw — ponto de entrada recomendado para o AgentLoop.
 * Pipeline: raw → sanitizeContent → parseLLMResponse → normalizeResponse
 */
export function normalizeFromRaw(rawContent: string, parseFn: (content: string) => ParsedLLMResponse | null): NormalizedResponse {
    const parsed = parseFn(rawContent);
    const sanitized = sanitizeContent(rawContent);
    return normalizeResponse(parsed, sanitized);
}

// ── Seção 2: Validação de contexto (ex-ContextValidator) ────────────────────

/**
 * Resultado da validação de qualidade do contexto LLM.
 * quality < 0.5 → recomendação 'cautious'.
 */
export interface ValidationResult {
    quality: number; // 0.0 to 1.0
    hasConflict: boolean;
    recommendation: 'assertive' | 'neutral' | 'cautious';
}

/**
 * ContextValidator — Avalia qualidade e confiabilidade do contexto atual.
 * Detecta conflitos, drift_risk, instabilidade.
 */
export class ContextValidator {
    validate(_userText: string, context: string, state: AgentState): ValidationResult {
        let quality = 1.0;
        let hasConflict = false;

        if (context.length < 30) quality -= 0.3;
        else if (context.length < 150) quality -= 0.1;

        if (state.meta.drift_risk > 0.8) quality -= 0.2;
        if (state.meta.stability < 0.3) quality -= 0.1;

        const lines = context.split('\n').filter(l => l.trim().length > 10);
        const subjects = new Map<string, string>();
        for (const line of lines) {
            if (line.includes(':')) {
                const parts = line.split(':');
                const subject = parts[0].trim().toLowerCase();
                const value = parts.slice(1).join(':').trim().toLowerCase();
                if (subjects.has(subject) && subjects.get(subject) !== value) {
                    hasConflict = true;
                    quality -= 0.4;
                    break;
                }
                subjects.set(subject, value);
            }
        }

        let recommendation: ValidationResult['recommendation'] = 'assertive';
        if (quality < 0.5 || hasConflict || state.confidence < 0.2) {
            recommendation = 'cautious';
        } else if (quality < 0.8 || state.meta.drift_risk > 0.6) {
            recommendation = 'neutral';
        }

        return { quality: Math.max(0, quality), hasConflict, recommendation };
    }
}

// ── Seção 3: Formatação de resultado de tool (ex-ResponseBuilder) ───────────

/**
 * ResponseBuilder — Formata resultados de tool sem chamar o LLM.
 *
 * Suporta: file_ops, memory_search/write/admin, exec_command.
 * Trunca conteúdo longo, formata em markdown.
 */
export class ResponseBuilder {

    /** Formata resultado de tool sem LLM. Retorna null se LLM é necessário. */
    buildResponse(toolName: string, toolParams: Record<string, unknown>, toolResult: ToolResult): string | null {
        if (!toolResult.success) {
            return this.formatError(toolName, toolResult.error || 'Erro desconhecido');
        }

        switch (toolName) {
            case 'write':
            case 'edit':
            case 'read':
                return this.formatFileOps(toolParams, toolResult);
            case 'memory_search':
                return this.formatMemorySearch(toolResult);
            case 'memory_write':
                return this.formatMemoryWrite(toolParams, toolResult);
            case 'memory_admin':
                return this.formatMemoryAdmin(toolResult);
            case 'exec_command':
                return this.formatExecCommand(toolResult);
            default:
                return null;
        }
    }

    private formatFileOps(params: Record<string, unknown>, result: ToolResult): string {
        const output = result.output || '';
        if (output.startsWith('Criado:') || output.startsWith('Sobrescrito:')) {
            return `✅ Arquivo criado: ${params['path'] || 'arquivo'}\n${output}`;
        }
        if (output.startsWith('Substituição OK:') || output.startsWith('Patch OK:') || output.startsWith('Conteúdo adicionado:') || output.startsWith('Arquivo criado:')) {
            return `✅ ${output}`;
        }
        if (output.startsWith('📁') || (output.includes('/') && output.includes('📄'))) {
            return `📁 ${output}`;
        }
        const maxLen = 1500;
        if (output.length > maxLen) {
            return `📄 Conteúdo do arquivo (truncado):\n\`\`\`\n${output.slice(0, maxLen)}\n\`\`\`\n\n*[Arquivo com ${output.length} caracteres. Use send_document para enviar o arquivo completo.]*`;
        }
        return `📄 Conteúdo do arquivo:\n\`\`\`\n${output}\n\`\`\``;
    }

    private formatMemorySearch(result: ToolResult): string {
        const output = result.output || '';
        if (output.length > 1000) {
            return `🔍 Resultados da busca:\n${output.slice(0, 1000)}\n\n*[Mais resultados disponíveis]*`;
        }
        return `🔍 Resultados da busca:\n${output}`;
    }

    private formatMemoryWrite(params: Record<string, unknown>, result: ToolResult): string {
        const action = String(params['action'] || '');
        const output = result.output || '';
        switch (action) {
            case 'create': return `✅ Nó criado: ${params['id'] || 'novo nó'}`;
            case 'update': return `✅ Nó atualizado: ${params['id'] || 'nó'}`;
            case 'connect': return `✅ Conexão criada: ${params['from'] || ''} → [${params['relation'] || 'related_to'}] → ${params['to'] || ''}`;
            case 'delete': return `✅ ${output}`;
            case 'merge':  return `✅ ${output}`;
            default: return output.slice(0, 500) || 'Ação executada.';
        }
    }

    private formatMemoryAdmin(result: ToolResult): string {
        const output = result.output || '';
        if (output.length > 1500) return `${output.slice(0, 1500)}\n\n*[Resultado truncado]*`;
        return output;
    }

    private formatExecCommand(result: ToolResult): string {
        const output = result.output || '';
        if (output.length > 1500) {
            return `💻 Resultado:\n\`\`\`\n${output.slice(0, 1500)}\n\`\`\`\n\n*[Resultado truncado]*`;
        }
        return `💻 Resultado:\n\`\`\`\n${output}\n\`\`\``;
    }

    private formatError(toolName: string, error: string): string {
        if (error.includes('não encontrado')) return `❌ Não encontrado: ${error}`;
        if (error.includes('obrigatório') || error.includes('exige')) return `❌ Parâmetro obrigatório: ${error}`;
        return `❌ Erro em ${toolName}: ${error.slice(0, 200)}`;
    }
}

// ── Seção 4: Modulação de resposta por estado cognitivo (ex-DecisionPostProcessor) ──

/**
 * DecisionPostProcessor — Modula tom da resposta LLM por estado cognitivo.
 * Nunca reescreve completamente — apenas ajusta tom e proatividade.
 * Máximo 2 modificações por resposta.
 */
export class DecisionPostProcessor {
    process(response: string, state: AgentState, validation: ValidationResult): string {
        let modulated = response;
        let changeCount = 0;
        const maxChanges = 2;

        const lowConfidencePatterns = /acredito|talvez|pode ser|provavelmente|não tenho certeza|segundo o que lembro/i;
        const isAlreadySoftened = lowConfidencePatterns.test(response);

        // 1. Modulação de assertividade
        if (validation.recommendation === 'cautious' && !isAlreadySoftened && changeCount < maxChanges) {
            const original = modulated;
            modulated = modulated
                .replace(/Certamente,|Com certeza,|Garanto que/g, 'Pode ser que')
                .replace(/é fundamental/g, 'possa ser útil');
            if (modulated !== original) changeCount++;
            if (changeCount < maxChanges && modulated.length > 40 && !modulated.toLowerCase().includes('recuperar')) {
                modulated = 'Pelo que consegui verificar, ' + modulated.charAt(0).toLowerCase() + modulated.slice(1);
                changeCount++;
            }
        }

        // 2. Modulação de proatividade
        if (state.meta.stability < 0.4 && changeCount < maxChanges) {
            const original = modulated;
            modulated = modulated.replace(/Além disso, (posso|poderia).*|Também posso.*|Que tal se.*/gi, '').trim();
            if (modulated !== original) changeCount++;
        }

        // 3. Drift compensation
        if (state.meta.drift_risk > 0.8 && !modulated.includes('?') && changeCount < maxChanges) {
            modulated += '\n\nFez sentido?';
            changeCount++;
        }

        // 4. Confidence sign-off
        if (state.confidence < 0.2 && !isAlreadySoftened && changeCount < maxChanges) {
            modulated += ' (Nota: Confiança reduzida por inconsistência de dados).';
        }

        return modulated;
    }
}
