/**
 * Padrão único de detecção de path placeholder gerado por LLM (ex: "{output_step_1}",
 * "{{step_1.output}}", "<nome_do_arquivo>", "/path/to/arquivo").
 *
 * Usado por GoalPlanner (parse de plano), RiskAnalyzer (ajuste de plano) e pelas tools
 * read/write (última linha de defesa em runtime). Antes vivia como 3 cópias quase-iguais
 * — uma em cada arquivo — e já tinham divergido: read_tool/write_tool reconheciam
 * "caminho/do" e o GoalPlanner não. Consolidado aqui em shared/ (camada sem dependência de
 * loop/ nem tools/) para as duas direções poderem importar sem inverter a hierarquia.
 */
// Colchete angular: <[^<>{}\n]{1,60}> em vez de exigir só letras/números/underscore —
// precisa cobrir "<sanitize_memory.py>" (ponto), "<arquivo real>.txt" etc. "<"/">" já não
// são caracteres válidos em nome de arquivo no Windows, então são um sinal forte por si só;
// a única exclusão é não deixar casar através de outro "<", ">", "{" ou "}" (evita capturar
// texto solto demais que por acaso tenha um "<" no meio).
export const PLACEHOLDER_ARG_PATTERN =
    /\b(caminho_do|path_to|arquivo_identificado|the_file_path|nome_do_arquivo|your_file|nome_arquivo|caminho\/do)\b|\{[a-zA-Z_][a-zA-Z0-9_]{0,40}\}|<[^<>{}\n]{1,60}>|\/path\/to\/|\/caminho\/do\/|\{\{step_\d+\.output\}\}/i;
