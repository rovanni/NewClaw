/**
 * Motor de validação com os tipos do NewClaw registrados (ADR-014/ADR-015) — o único lugar onde a lista de tipos é
 * montada. Quem precisa validar cria o motor por aqui; o motor não tem estado além do registro (só dados), então cada
 * consumidor pode ter a sua instância sem divergir.
 */
import type { ProviderFactory } from '../core/ProviderFactory';
import { ValidationEngine } from './ValidationEngine';
import { RegistroDeValidacoes } from './contratoDeValidacao';
import { PerfilDoJuiz, perfilDoJuizDoProcesso } from './perfilDoJuiz';
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

export function criarMotorDeValidacao(providerFactory: ProviderFactory): ValidationEngine {
    // Em produção (perfil do processo ligado no boot) o aprendizado de como cada modelo se comporta como juiz é UM só, em
    // disco, para todos os tipos e entre reinícios; fora disso (testes, CLI) cada motor aprende sozinho, sem tocar o disco.
    const perfil = perfilDoJuizDoProcesso.persistente ? perfilDoJuizDoProcesso : new PerfilDoJuiz();
    return new ValidationEngine(providerFactory, criarRegistroPadrao(), undefined, perfil);
}

// Uma instância por ProviderFactory: o motor é só dados (o registro) + a fábrica de provedores.
const motores = new WeakMap<object, ValidationEngine>();

/** O motor único do NewClaw para esta fábrica de provedores — todo consumidor valida por aqui (ADR-014). */
export function obterMotor(providerFactory: ProviderFactory): ValidationEngine {
    let m = motores.get(providerFactory);
    if (!m) { m = criarMotorDeValidacao(providerFactory); motores.set(providerFactory, m); }
    return m;
}
