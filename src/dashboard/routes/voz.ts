/**
 * Dicionário da voz — ADR-039, Revisão 2 (07/11/2026).
 *
 * As palavras que a pessoa ensinou a uma interface de voz (uma integração opcional, fora do núcleo) para o reconhecimento
 * acertar nomes próprios e termos raros ("River", e não "Rigger"). O núcleo só guarda a lista: não conhece a integração.
 * Moram no banco do NewClaw, e não na pasta da integração, para irem no backup do conhecimento
 * (ADR-020), que leva o banco inteiro. Ficam na tabela `memory` (chave e valor), pelo `getSetting`/`setSetting` que já
 * existem: não são memória do agente (nada aqui entra nas buscas nem passa pelo curador).
 *
 * Quem decide o que entra é sempre a pessoa, pela janela: esta rota só guarda e confere a FORMA (tipos, tamanhos,
 * duplicatas). Nada aqui interpreta o sentido das palavras.
 *
 * `PUT` leva a lista inteira com a `revisao` que a janela leu: se outra janela mudou a lista antes, responde 409 e não
 * sobrescreve. O "Desfazer" da janela é um `PUT` da lista anterior.
 */
import { Router, Request, Response } from 'express';
import type { DashboardContext } from './types';

/** Versão desta rota, anunciada em `GET /api/status` → `status.contracts.voz_vocabulario`. */
export const VOZ_VOCABULARIO_VERSION = 1;

export const CHAVE_DO_VOCABULARIO = 'voz_vocabulario';
const CATEGORIA = 'voz';

/**
 * Tetos de proteção contra abuso ou acidente (um corpo gigante, uma lista colada sem querer). NÃO são o tamanho bom da
 * lista: esse sai da medição com a voz da operadora (ADR-039, D1), e o motor da voz conta quantas cabem no Whisper.
 */
export const TETO_DE_PALAVRAS = 200;
export const TETO_DE_CARACTERES = 60;
export const TETO_DE_OUVIDAS = 10;

export interface PalavraDaVoz {
    /** Como deve aparecer na transcrição. */
    palavra: string;
    /** Como o reconhecimento tinha escrito, nas correções que a pessoa confirmou. */
    ouvia: string[];
    /** Quantas vezes a pessoa confirmou esta palavra (ensinar e cada nova correção). */
    vezes: number;
    criadaEm: string;
    atualizadaEm: string;
}

export interface Vocabulario {
    revisao: number;
    palavras: PalavraDaVoz[];
}

export interface GuardaDeConfiguracao {
    getSetting(chave: string): string | null;
    setSetting(chave: string, valor: string, categoria?: string): void;
}

const VAZIO: Vocabulario = { revisao: 0, palavras: [] };

/** O que está guardado. Valor ausente é a lista vazia; valor ilegível é erro (nunca uma lista vazia no lugar dele). */
export function lerVocabulario(guarda: GuardaDeConfiguracao): Vocabulario {
    const bruto = guarda.getSetting(CHAVE_DO_VOCABULARIO);
    if (bruto === null) return { ...VAZIO, palavras: [] };
    const lido = JSON.parse(bruto) as Vocabulario;
    if (!lido || typeof lido.revisao !== 'number' || !Array.isArray(lido.palavras)) {
        throw new Error(`o valor guardado em "${CHAVE_DO_VOCABULARIO}" não tem a forma esperada`);
    }
    return lido;
}

const juntarEspacos = (s: string) => s.replace(/\s+/g, ' ').trim();
const chave = (s: string) => s.toLocaleLowerCase('pt-BR');

/**
 * Confere a forma da lista que a janela mandou e devolve a versão guardável, ou o motivo da recusa. Datas ausentes
 * recebem o momento `agora`; espaços repetidos viram um; "eu ouvia" repetido ou igual à própria palavra sai.
 */
export function conferirPalavras(entrada: unknown, agora: string): { palavras: PalavraDaVoz[] } | { erro: string } {
    if (!Array.isArray(entrada)) return { erro: '"palavras" precisa ser uma lista' };
    if (entrada.length > TETO_DE_PALAVRAS) return { erro: `no máximo ${TETO_DE_PALAVRAS} palavras` };
    const vistas = new Set<string>();
    const saida: PalavraDaVoz[] = [];
    for (const [i, item] of entrada.entries()) {
        if (!item || typeof item !== 'object') return { erro: `item ${i + 1}: não é um objeto` };
        const p = item as Record<string, unknown>;
        if (typeof p.palavra !== 'string' || !juntarEspacos(p.palavra)) return { erro: `item ${i + 1}: "palavra" vazia` };
        const palavra = juntarEspacos(p.palavra);
        if (palavra.length > TETO_DE_CARACTERES) return { erro: `"${palavra.slice(0, 20)}…": mais de ${TETO_DE_CARACTERES} caracteres` };
        if (vistas.has(chave(palavra))) return { erro: `"${palavra}" aparece duas vezes` };
        vistas.add(chave(palavra));

        const ouviaBruto = p.ouvia ?? [];
        if (!Array.isArray(ouviaBruto) || ouviaBruto.some((o) => typeof o !== 'string')) return { erro: `"${palavra}": "ouvia" precisa ser uma lista de textos` };
        const ouvia: string[] = [];
        for (const o of ouviaBruto as string[]) {
            const t = juntarEspacos(o);
            if (!t || chave(t) === chave(palavra) || ouvia.some((x) => chave(x) === chave(t))) continue;
            if (t.length > TETO_DE_CARACTERES) return { erro: `"${palavra}": um "ouvia" com mais de ${TETO_DE_CARACTERES} caracteres` };
            ouvia.push(t);
        }
        if (ouvia.length > TETO_DE_OUVIDAS) return { erro: `"${palavra}": no máximo ${TETO_DE_OUVIDAS} "ouvia"` };

        const vezes = p.vezes ?? 1;
        if (typeof vezes !== 'number' || !Number.isInteger(vezes) || vezes < 1) return { erro: `"${palavra}": "vezes" precisa ser um inteiro a partir de 1` };
        const data = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : agora);
        saida.push({ palavra, ouvia, vezes, criadaEm: data(p.criadaEm), atualizadaEm: data(p.atualizadaEm) });
    }
    return { palavras: saida };
}

export function createVozRouter(ctx: Pick<DashboardContext, 'memoryManager'>, relogio: () => Date = () => new Date()): Router {
    const router = Router();
    const guarda = (): GuardaDeConfiguracao | null => ctx.memoryManager ?? null;

    router.get('/vocabulario', (_req: Request, res: Response) => {
        const g = guarda();
        if (!g) { res.status(503).json({ success: false, error: 'a memória do NewClaw não está disponível' }); return; }
        try {
            res.json({ success: true, ...lerVocabulario(g) });
        } catch (e) {
            res.status(500).json({ success: false, error: (e as Error).message });
        }
    });

    router.put('/vocabulario', (req: Request, res: Response) => {
        const g = guarda();
        if (!g) { res.status(503).json({ success: false, error: 'a memória do NewClaw não está disponível' }); return; }
        const corpo = (req.body ?? {}) as { revisao?: unknown; palavras?: unknown };
        if (typeof corpo.revisao !== 'number' || !Number.isInteger(corpo.revisao)) {
            res.status(400).json({ success: false, error: '"revisao" (a que foi lida) é obrigatória' });
            return;
        }
        const conferido = conferirPalavras(corpo.palavras, relogio().toISOString());
        if ('erro' in conferido) { res.status(400).json({ success: false, error: conferido.erro }); return; }
        let atual: Vocabulario;
        try { atual = lerVocabulario(g); } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); return; }
        // Leitura, conferência e gravação no mesmo trecho síncrono (better-sqlite3): nenhum outro pedido entra no meio.
        if (corpo.revisao !== atual.revisao) {
            res.status(409).json({ success: false, error: 'a lista mudou em outra janela; leia de novo', ...atual });
            return;
        }
        const novo: Vocabulario = { revisao: atual.revisao + 1, palavras: conferido.palavras };
        g.setSetting(CHAVE_DO_VOCABULARIO, JSON.stringify(novo), CATEGORIA);
        res.json({ success: true, ...novo });
    });

    return router;
}
