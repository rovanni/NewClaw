# Localidade da Recuperação

> Documento normativo. Define em que camada uma política de recuperação deve ser implementada, e
> exige que ela seja alcançável no instante em que a falha acontece.
>
> Origem: `docs/decisoes/RFC-005_POLITICAS_DE_SUBSTITUICAO_DE_RECURSOS.md`, formulado pelo operador
> diante do incidente do `newclaw-kernel-adapter` (06/08/2026).

## 1. Objetivo

Evitar recuperações **corretas porém inalcançáveis**: código de degradação graciosa que existe,
está bem escrito, tem cobertura de teste — e nunca executa, porque a falha que ele trata acontece
numa fase anterior àquela em que ele vive.

## 2. Motivação

`CognitiveKernelGate` prometia, no próprio cabeçalho do arquivo, cair em `{action:'proceed'}`
diante de "dependência ausente", com circuit breaker e kill-switch implementados. O `newclaw-kernel-adapter`
é um pacote opcional referenciado por caminho relativo (`file:../newclaw-kernel-adapter`), que só
resolve onde os dois repositórios são irmãos.

Numa segunda máquina do operador, `newclaw update` falhou com
`TS2307: Cannot find module 'newclaw-kernel-adapter'`. O `import` era **estático**: a falha
ocorria em tempo de compilação, onde nenhum `try/catch` de runtime existe ainda. O build quebrava
em toda instalação que não a do autor.

**A proteção era real, correta e inalcançável.** Nenhum teste a pegaria, porque o teste também
precisa compilar. Corrigido em `45d6365`, cobertura `S203`.

Um segundo caso, de natureza diferente, mostra que o princípio vale também para o *diagnóstico*:
`ProviderFactory`/`CircuitBreaker` não conseguem distinguir um servidor de modelo local **desligado
pelo usuário** de um **realmente avariado**, e por isso acumulam falhas indevidamente (observado em
produção: `CIRCUIT-OPEN: Skipping 'Modelo local' (failures: 72)`). A informação que permitiria a
distinção existe — mas mora em `src/dashboard/routes/models.ts`, uma camada de apresentação, fora
do alcance de quem precisa dela.

## 3. Definição

> As políticas de recuperação devem ser implementadas na mesma camada em que a falha pode ocorrer.

| Tipo de falha | Camada que deve tratá-la |
|---|---|
| Dependência ausente (import) | resolução de módulos / composição |
| Provider indisponível | `ProviderFactory` / `CircuitBreaker` |
| Modelo recusou a requisição | camada do provider |
| Ferramenta retornou erro | executor da ferramenta |
| Prompt inválido | Planner |

## 4. Corolário — alcançabilidade

**Declarar a intenção de degradar não basta.** O mecanismo de degradação precisa ser alcançável no
instante em que a indisponibilidade acontece.

Um recurso que falta em **tempo de build** exige tratamento em tempo de build — `import` dinâmico,
dependência opcional real, ou barreira de composição. Um `try/catch` de runtime não protege contra
um `import` estático que não resolve, por mais completo que seja.

A pergunta a fazer não é *"existe tratamento para esta falha?"*, e sim *"o tratamento já foi
carregado quando esta falha ocorre?"*.

## 5. Corolário — localidade do diagnóstico

O princípio vale também para a **informação que permite classificar a falha**, não só para a reação
a ela.

Se a camada onde a falha ocorre não alcança o sinal que distinguiria uma causa de outra, ela é
obrigada a adivinhar — e adivinhar é proibido por `NUNCA_ADIVINHAR.md`. As `72 failures` do exemplo
acima são, literalmente, setenta e duas suposições registradas como observações.

Quando o diagnóstico não é alcançável, o comportamento correto é **reportar indeterminação**, nunca
escolher a causa mais provável. Um estado "não sei classificar" que permanece visível é também um
indicador de dívida arquitetural — mascará-lo esconde o problema estrutural junto.

## 6. Responsabilidades

Ao escrever tratamento de falha, o autor **DEVE**:

- Identificar em que fase a falha ocorre (composição, build, inicialização, runtime) antes de
  escolher onde tratá-la.
- Garantir que o código de tratamento esteja carregado e executável naquela fase.
- Colocar o tratamento na camada que **detecta** a falha, não numa camada acima que apenas a
  observa de longe.
- Verificar que o sinal necessário para classificar a falha é alcançável de onde ela ocorre — e,
  não sendo, reportar indeterminação em vez de inferir a causa.

O autor **NÃO DEVE**:

- Confiar em `try/catch` de runtime para falha de resolução de módulo.
- Expor estado de uma camada de apresentação para o Core consumir — isso resolve o sintoma (o dado
  chega) invertendo a arquitetura de canais que `ARCHITECTURE.md` protege.
- Duplicar a mesma política de recuperação em vários caminhos de execução. Contar caminhos à mão
  não funciona: `ADR-005` §5.1 registra o caso em que a própria ADR contou dois quando eram cinco.

## 7. Exceções

Não há exceção conhecida ao princípio em si — uma recuperação que não pode executar não é uma
recuperação.

Há, porém, uma tensão legítima e recorrente: às vezes a camada onde a falha ocorre **está certa** e
o comportamento continua errado. O caso `searx.be` é o exemplo: tratar "instância local fora do ar"
dentro do método de busca é apropriado; o que não pertence àquela camada é a decisão de enviar a
consulta do usuário a um terceiro. Isso não é recuperação técnica — é política de privacidade, e
cai sob `SOBERANIA_DA_CONFIGURACAO.md`.

Localidade satisfeita **não** implica comportamento correto. Os dois princípios precisam ser
verificados separadamente.

## 8. Estado atual

Situação em 06/08/2026, verificada caso a caso na Fase 0:

| Caso | Camada da falha | Camada do tratamento | Situação |
|---|---|---|---|
| `newclaw-kernel-adapter` | resolução de módulo (build) | runtime (`try/catch`) | ❌ → ✅ corrigido (`S203`) |
| `CircuitBreaker` sobre provider local | transporte/provider | `CircuitBreaker` | ✅ reação certa, ⚠️ diagnóstico fora de alcance |
| `chatWithFallback` | provider | `ProviderFactory` | ✅ |
| Whisper remoto → local | handler de mídia | mesmo handler | ✅ |
| TTS Piper → edge-tts | geração de áudio | `send_audio` | ✅ |
| `ProactiveRecovery` (args/tools) | execução de ferramenta | executor | ✅ |
| `exec_command` AUTO-FIX | execução de comando | executor | ✅ |
| Classificação LLM → keyword | classificador | classificador | ✅ |
| `resolveProfile ?? chat ?? [0]` | configuração de perfil | registry | ✅ |
| `searXNG` local → público | serviço de busca | método de busca | ✅ camada certa, ver Seção 7 |

**Onde vive a capacidade de ciclo de vida do runtime local permanece questão aberta**, a ser
decidida em ADR própria (`RFC-005`, Sprint 019). O que está estabelecido é apenas o achado: a
capacidade existe, é madura e testada (`S171`), e não é alcançável por quem precisa dela.

## 9. Relação com outros princípios

- **Soberania da Configuração do Usuário** (`SOBERANIA_DA_CONFIGURACAO.md`): ortogonal.
  Localidade responde *onde* a recuperação mora; Soberania responde *quem* decide. O
  `newclaw-kernel-adapter` errava as duas; o `searx.be` erra só a segunda.
- **Nunca Adivinhar** (`NUNCA_ADIVINHAR.md`): o corolário do diagnóstico (Seção 5) é uma aplicação
  direta — diagnóstico inalcançável produz ausência explícita, nunca a causa mais plausível.
- **`ADR-005`** (onde vive o gate de ação perigosa): o mesmo raciocínio aplicado à segurança. A
  pergunta "isto precisa de autorização?" morava num caminho de execução enquanto a promessa era do
  sistema; a correção foi movê-la para o executor comum, não repeti-la em cada caminho.

## 10. Checklist para novos componentes

Antes de escrever tratamento de falha:

- [ ] Em que **fase** esta falha ocorre — composição, build, inicialização, runtime?
- [ ] O código de tratamento já está carregado e executável nessa fase?
- [ ] O tratamento está na camada que **detecta** a falha, ou numa que só a observa?
- [ ] O sinal necessário para classificar a causa é alcançável de onde a falha ocorre?
- [ ] Não sendo alcançável, o componente reporta indeterminação — ou escolhe a causa mais provável?
- [ ] Esta política está sendo escrita numa camada só, ou copiada para vários caminhos?
