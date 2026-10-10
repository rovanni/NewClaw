/**
 * O que os juízes relataram de si mesmos — leitura do gravador de voo (ADR-013) para a tela "Validadores".
 *
 * Todo juiz do motor único pode dizer, em uma frase, o que lhe FALTOU para decidir com segurança (`faltou`) e o que
 * DIFICULTOU a decisão (`dificuldade`). Esses relatos apontaram as lacunas reais entre o que uma pessoa teria no lugar do juiz e o
 * que ele recebia (S378). Este módulo só LÊ e agrupa por fatos estruturais (qual juiz, qual campo, quando) — nunca classifica o
 * texto: agrupar por tema é interpretar, e interpretar é do modelo, não de uma regra.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface RelatoDoJuiz {
    avaliacaoId: string;
    ts: string;
    avaliador: string;
    modelo: string;
    desfecho: string;
    estado?: string;
    faltou?: string;
    dificuldade?: string;
}

export interface ResumoDoJuiz {
    avaliador: string;
    avaliacoes: number;
    /** Avaliações em que o juiz declarou falta de informação (com ou sem o texto gravado). */
    comFaltou: number;
    comDificuldade: number;
    /** Declararam, mas o texto não ficou gravado (registros anteriores a gravá-lo sempre, sem TRACE_CONTENT). */
    semTexto: number;
}

export interface RelatosDosJuizes {
    porJuiz: ResumoDoJuiz[];
    relatos: RelatoDoJuiz[];
}

const MAX_RELATOS = 500;

const texto = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function lerRelatos(pasta: string | null): RelatosDosJuizes {
    const resumo = new Map<string, ResumoDoJuiz>();
    const relatos: RelatoDoJuiz[] = [];
    if (!pasta || !fs.existsSync(pasta)) return { porJuiz: [], relatos: [] };
    for (const nome of fs.readdirSync(pasta).filter(n => n.endsWith('.jsonl'))) {
        let linhas: string[];
        try { linhas = fs.readFileSync(path.join(pasta, nome), 'utf8').split('\n'); } catch { continue; }
        for (const linha of linhas) {
            if (!linha.trim()) continue;
            let r: any;
            try { r = JSON.parse(linha); } catch { continue; }
            if (r?.tipo !== 'avaliacao' || !r.depois) continue;
            const avaliador = String(r.avaliador ?? nome);
            const g = resumo.get(avaliador) ?? { avaliador, avaliacoes: 0, comFaltou: 0, comDificuldade: 0, semTexto: 0 };
            g.avaliacoes++;
            const fatos = r.depois.fatos ?? {};
            const conteudo = r.depois.conteudo ?? {};
            // O texto vem dos fatos (sempre gravado, desde S380) ou do conteúdo (registros antigos, só com TRACE_CONTENT).
            const faltou = texto(fatos.faltou) ?? texto(conteudo.faltou);
            const dificuldade = texto(fatos.dificuldade) ?? texto(conteudo.dificuldade);
            const declaraFaltou = fatos.faltouInformado === true || !!faltou;
            const declaraDificuldade = fatos.dificuldadeInformada === true || !!dificuldade;
            if (declaraFaltou) g.comFaltou++;
            if (declaraDificuldade) g.comDificuldade++;
            if ((declaraFaltou && !faltou) || (declaraDificuldade && !dificuldade)) g.semTexto++;
            resumo.set(avaliador, g);
            if (faltou || dificuldade) {
                relatos.push({
                    avaliacaoId: String(r.id ?? ''), ts: String(r.ts ?? ''), avaliador,
                    modelo: String(r.antes?.modelo ?? '?'), desfecho: String(r.depois.desfecho ?? ''), estado: r.depois.estado,
                    faltou, dificuldade,
                });
            }
        }
    }
    relatos.sort((a, b) => b.ts.localeCompare(a.ts));
    return { porJuiz: [...resumo.values()].sort((a, b) => b.avaliacoes - a.avaliacoes), relatos: relatos.slice(0, MAX_RELATOS) };
}
