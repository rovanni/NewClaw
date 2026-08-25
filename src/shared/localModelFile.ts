/**
 * Extensões de arquivo que só existem como modelo local (llama.cpp/llamafile) — nunca uma tag
 * válida de nenhum provider de nuvem/nativo (Ollama, Gemini, DeepSeek, Groq, OpenRouter,
 * Anthropic). Fonte única — antes vivia só em `dashboard/routes/models.ts` (camada de rota, que
 * `loop/ModelProfileRegistry.ts` não pode importar sem violar a separação Core↔Dashboard já
 * documentada em `docs/ARCHITECTURE.md`), extraída pra cá quando o Core também passou a precisar
 * do mesmo fato (campanha "Ollama API error: 404", Fase 3, S264): invalidar um par
 * (modelo local, provider nativo herdado) exige saber o que conta como "modelo local", o mesmo
 * dado que já existia pro Dashboard listar arquivos `.gguf` na pasta.
 */
export const LOCAL_MODEL_EXTENSIONS = ['.gguf'];

export function isLocalModelFile(model: string | undefined | null): boolean {
    if (!model) return false;
    const lower = model.toLowerCase();
    return LOCAL_MODEL_EXTENSIONS.some(ext => lower.endsWith(ext));
}
