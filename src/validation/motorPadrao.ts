/**
 * Motor de validação com os tipos do NewClaw registrados (ADR-014/ADR-015) — o único lugar onde a lista de tipos é
 * montada. Quem precisa validar cria o motor por aqui; o motor não tem estado além do registro (só dados), então cada
 * consumidor pode ter a sua instância sem divergir.
 */
import type { ProviderFactory } from '../core/ProviderFactory';
import { ValidationEngine } from './ValidationEngine';
import { RegistroDeValidacoes } from './contratoDeValidacao';
import { descritorSuficienciaDoPedido } from './tipos/suficienciaDoPedido';
import { descritorSaidaContraEvidencia } from './tipos/saidaContraEvidencia';
import { descritorQualidadeDaResposta, descritorResultadoDoPasso, descritorRiscoDoPlano, descritorConclusaoDoObjetivo, descritorConteudoMolde } from './tipos/demaisTipos';

/** Registro com todos os tipos — também usado pelo recenseamento (S356) e por testes. */
export function criarRegistroPadrao(): RegistroDeValidacoes {
    const registro = new RegistroDeValidacoes();
    for (const d of [
        descritorSuficienciaDoPedido, descritorSaidaContraEvidencia, descritorQualidadeDaResposta, descritorResultadoDoPasso,
        descritorRiscoDoPlano, descritorConclusaoDoObjetivo, descritorConteudoMolde,
    ]) registro.registrar(d as never);
    return registro;
}

/** Estado do motor na escala comum — usado pelas sombras dos tipos de agregação 'modelo'. */
export const estadoDoVeredito = (_: unknown, v: { estado: string }): string => v.estado;

/**
 * ADR-014 (M1–M6): um tipo roda em SOMBRA — junto do validador atual, sem decidir nada — quando está em
 * `VALIDACAO_SOMBRA` (lista separada por vírgula, ou `todos`). Desligado por padrão: num servidor local que atende um
 * pedido por vez, cada sombra é uma chamada a mais na fila do usuário; liga-se para medir, por um período.
 */
export function sombraLigadaPara(tipo: string): boolean {
    const v = (process.env.VALIDACAO_SOMBRA ?? '').split(',').map(s => s.trim()).filter(Boolean);
    return v.includes('todos') || v.includes(tipo);
}

export function criarMotorDeValidacao(providerFactory: ProviderFactory): ValidationEngine {
    return new ValidationEngine(providerFactory, criarRegistroPadrao());
}
