/**
 * Rotas do instalador genérico de integrações opcionais — `/api/integrations/opcionais` (ADR-030, Etapa 5).
 *
 *   GET    /                         → catálogo com o estado de cada integração
 *   GET    /:id                      → manifesto (nome, descrição, origem), requisitos medidos e estado
 *   GET    /:id/opcoes               → escolhas que a integração oferece (baixa o pacote na 1ª vez)
 *   POST   /:id/licencas             → peças de terceiros das escolhas  { escolhas }
 *   POST   /:id/instalar             → instala em segundo plano  { escolhas, aceito: true } → 202 { andamento }
 *   POST   /:id/atualizar            → pacote mais novo com as mesmas escolhas e o mesmo aceite → 202 { andamento };
 *                                       409 { motivo: 'revisar' } quando as licenças ou as escolhas mudaram
 *   GET    /:id/andamento/:andamento → linhas e estado da instalação
 *   POST   /:id/ligar | /:id/desligar
 *   DELETE /:id                      → desinstala (só pasta criada pelo NewClaw)
 *
 * Tudo atrás do login do painel (as rotas /api/* passam pelo authMiddleware) e, nos pedidos que mudam estado, pela
 * checagem de origem contra CSRF.
 */
import { Router, Request, Response } from 'express';
import { errorMessage } from '../../shared/errors';
import { createLogger } from '../../shared/AppLogger';
import { ErroDaIntegracao, GerenciadorDeIntegracoes } from '../integracoesOpcionais/gerenciador';

const log = createLogger('IntegracoesOpcionais');

export function createIntegracoesOpcionaisRouter(gerenciador: GerenciadorDeIntegracoes): Router {
    const router = Router();

    const responder = (res: Response, e: unknown) => {
        const status = e instanceof ErroDaIntegracao ? e.status : 500;
        if (status >= 500) log.warn(`integração opcional: ${errorMessage(e)}`);
        const motivo = e instanceof ErroDaIntegracao ? e.motivo : undefined;
        res.status(status).json({ error: errorMessage(e), ...(motivo ? { motivo } : {}) });
    };
    const escolhasDo = (req: Request): Record<string, unknown> => {
        const e = req.body?.escolhas;
        return e && typeof e === 'object' && !Array.isArray(e) ? e : {};
    };

    router.get('/', async (_req, res) => {
        const lista = [];
        for (const item of gerenciador.catalogo()) {
            try {
                const m = await gerenciador.manifesto(item.id);
                lista.push({ id: m.id, nome: m.nome, descricao: m.descricao, site: m.site, ...(await gerenciador.estado(m)) });
            } catch (e) {
                lista.push({ id: item.id, erro: errorMessage(e) });
            }
        }
        res.json({ integracoes: lista });
    });

    router.get('/:id', async (req, res) => {
        try {
            const m = await gerenciador.manifesto(req.params.id);
            res.json({
                id: m.id, nome: m.nome, descricao: m.descricao, site: m.site, pacote: m.pacote,
                requisitos: await gerenciador.requisitos(m), ...(await gerenciador.estado(m)),
            });
        } catch (e) { responder(res, e); }
    });

    router.get('/:id/opcoes', async (req, res) => {
        try { res.json({ opcoes: await gerenciador.opcoes(await gerenciador.manifesto(req.params.id)) }); } catch (e) { responder(res, e); }
    });

    router.post('/:id/licencas', async (req, res) => {
        try { res.json(await gerenciador.licencas(await gerenciador.manifesto(req.params.id), escolhasDo(req))); } catch (e) { responder(res, e); }
    });

    router.post('/:id/instalar', async (req, res) => {
        try {
            const m = await gerenciador.manifesto(req.params.id);
            const a = await gerenciador.instalar(m, escolhasDo(req), req.body?.aceito === true);
            log.info(`instalação da integração '${m.id}' começou (${a.id}); licenças aceitas no painel`);
            res.status(202).json({ andamento: a.id });
        } catch (e) { responder(res, e); }
    });

    router.post('/:id/atualizar', async (req, res) => {
        try {
            const m = await gerenciador.manifesto(req.params.id);
            const a = await gerenciador.atualizar(m);
            log.info(`atualização da integração '${m.id}' começou (${a.id}); mesmas escolhas e mesma lista de licenças aceita`);
            res.status(202).json({ andamento: a.id });
        } catch (e) { responder(res, e); }
    });

    router.get('/:id/andamento/:andamento', (req, res) => {
        const a = gerenciador.andamento(req.params.andamento);
        if (!a || a.integracao !== req.params.id) return res.status(404).json({ error: 'andamento não encontrado' });
        res.json(a);
    });

    router.post('/:id/ligar', async (req, res) => {
        try { await gerenciador.ligar(await gerenciador.manifesto(req.params.id)); res.json({ ok: true }); } catch (e) { responder(res, e); }
    });

    router.post('/:id/desligar', async (req, res) => {
        try { await gerenciador.desligar(await gerenciador.manifesto(req.params.id)); res.json({ ok: true }); } catch (e) { responder(res, e); }
    });

    router.delete('/:id', async (req, res) => {
        try {
            const m = await gerenciador.manifesto(req.params.id);
            await gerenciador.desinstalar(m);
            log.info(`integração '${m.id}' desinstalada`);
            res.json({ ok: true });
        } catch (e) { responder(res, e); }
    });

    return router;
}
