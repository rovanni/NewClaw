import { Router, Request, Response } from 'express';
import { errorMessage } from '../../shared/errors';
import { pastaAvaliadores } from '../../shared/evaluatorFlightRecorder';
import { lerRelatos } from '../../validation/relatosDosJuizes';

/**
 * Tela "Validadores" — GET /api/validators/reports. Camada HTTP fina: lê o gravador de voo (ADR-013) e devolve o que cada juiz
 * relatou (`faltou` / `dificuldade`), por extenso, mais o resumo por juiz. `disponivel: false` quando o gravador está desligado
 * (sem `LOG_FILE`).
 */
export function createValidatorsRouter(pasta: () => string | null = pastaAvaliadores): Router {
    const router = Router();
    router.get('/reports', (_req: Request, res: Response) => {
        try {
            const p = pasta();
            if (!p) return res.json({ success: true, disponivel: false, porJuiz: [], relatos: [] });
            res.json({ success: true, disponivel: true, ...lerRelatos(p) });
        } catch (err) {
            res.status(500).json({ success: false, error: errorMessage(err) });
        }
    });
    return router;
}
