/**
 * Medição padronizada da velocidade de um modelo COMO JUIZ (ADR-016).
 *
 * A capacidade que o provedor declara não separa rápido de lento (hoje quase todo modelo declara raciocínio, inclusive os que
 * respondem em 2 s), e o tempo de uso mistura prompts pequenos e enormes. Então, quando o operador pede, o motor faz UMA
 * conferência real — sempre o mesmo caso pequeno, de gabarito conhecido — e registra quanto o modelo levou. É comparável entre
 * modelos e não depende de nome nenhum.
 *
 * O caso é neutro de propósito (nenhum dado pessoal): duas afirmações verdadeiras sobre o que a "ferramenta" devolveu. Um
 * juiz que não aprova uma resposta claramente verdadeira também não serve; por isso `ok` exige veredito E aprovação.
 */
import type { ValidationEngine } from './ValidationEngine';
import type { PerfilDoJuiz } from './perfilDoJuiz';
import type { DecisaoDeGrounding } from './tipos/saidaContraEvidencia';
import { TIPO_SAIDA_CONTRA_EVIDENCIA } from './tipos/saidaContraEvidencia';

const CASO_PADRAO = {
    pedido: 'Qual é a temperatura e a umidade agora?',
    resposta: 'Agora estão 18 °C, com umidade de 60%.',
    evidencias: '[E1] ferramenta=weather args={"cidade":"exemplo"}\nTemperatura: 18 °C | Umidade: 60% | Atualizado agora',
};

export interface ResultadoDaSondagem {
    ok: boolean;
    ms: number;
    desfecho: string;
    classe: 'rapido' | 'lento' | 'sem_medicao';
}

export async function medirVelocidadeDoJuiz(motor: ValidationEngine, perfil: PerfilDoJuiz, modelo: string, signal?: AbortSignal): Promise<ResultadoDaSondagem> {
    const t0 = Date.now();
    const r = await motor.validar<DecisaoDeGrounding>(TIPO_SAIDA_CONTRA_EVIDENCIA, CASO_PADRAO, { modelo, phase: 'medicao_do_juiz', signal });
    const ms = Date.now() - t0;
    const ok = !r.semVeredito && r.adaptado?.state === 'VALIDATED';
    perfil.registrarSondagem(modelo, ok, ms);
    return { ok, ms, desfecho: r.desfecho, classe: perfil.classeDoJuiz(modelo) };
}
