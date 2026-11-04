import { Router } from 'express';
import { errorMessage } from '../../shared/errors';
import { DashboardContext } from './types';
import { createLogger } from '../../shared/AppLogger';
import { createIntegracoesOpcionaisRouter } from './integracoesOpcionais';
import { GerenciadorDeIntegracoes } from '../integracoesOpcionais/gerenciador';
import { dependenciasReais } from '../integracoesOpcionais/dependencias';

const log = createLogger('Integrations');

/**
 * Integrações do painel. Só o instalador genérico de integrações opcionais (ADR-030, Etapa 5; ADR-031): cada integração
 * mora no próprio repositório, publica um manifesto e conversa com o NewClaw pelo contrato público do turno. O suplemento
 * do PowerPoint tinha rotas e instalador próprios aqui; saiu do núcleo em 04/11/2026 (repositório newclaw-powerpoint).
 */
export function createIntegrationsRouter(_ctx: DashboardContext, gerenciador?: GerenciadorDeIntegracoes): Router {
    const router = Router();

    // A integração usa sempre o HTTP local deste NewClaw.
    if (!gerenciador) {
        gerenciador = new GerenciadorDeIntegracoes(dependenciasReais(`http://127.0.0.1:${_ctx?.config?.dashboardPort || 3090}`));
        // As que a pessoa deixou ligadas voltam com o NewClaw (depois de reiniciar o computador, o PM2 não as traz).
        void gerenciador.restaurar().then((lista) => {
            for (const r of lista) {
                if (r.resultado === 'falhou') log.warn(`integração opcional '${r.id}' não foi religada: ${r.erro}`);
                else log.info(`integração opcional '${r.id}': ${r.resultado === 'religada' ? 'religada' : 'já estava ligada'}`);
            }
        }).catch((e) => log.warn(`religar integrações opcionais: ${errorMessage(e)}`));
    }
    router.use('/opcionais', createIntegracoesOpcionaisRouter(gerenciador));

    return router;
}
