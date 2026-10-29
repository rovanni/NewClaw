# ADR-031 — Experiências opcionais não impõem dependências ao núcleo (harness)

Data: 28/10/2026. Status: **aprovada em 29/10/2026** — princípio pedido pela operadora e confirmado na decisão R1 da ADR-030 (harness em repositório separado, dependência por contratos documentados). Relacionada:
`ADR-030_CANAL_DE_VOZ_PIPECAT.md` (interface de voz), `docs/ARCHITECTURE.md`, RFC-008.

## Fase 1 — Compreensão

### O que motivou

A interface de voz (ADR-030) é a primeira funcionalidade do NewClaw que traz **código e componentes de terceiros com outra pilha**:

- **Pilhas novas:** Python com Pipecat e React com Vite, enquanto o núcleo é TypeScript e autoral.
- **Licenças com obrigações próprias:** a auditoria da Etapa 0 da ADR-030 encontrou licenças BSD, MIT, Apache, ISC, OFL, LGPL e
  binários GPL dentro de pacotes de terceiros.

A operadora quer preservar a autoria e a autonomia do núcleo: *o harness usa o núcleo; o núcleo não depende do harness.*

### O que o código já mostra

| Evidência | Onde | O que ensina |
|---|---|---|
| O suplemento do PowerPoint vive em `addins/powerpoint-addin`, com `package.json`, build e instalador próprios | `addins/` | Separação física funciona e já é convenção |
| Mas o núcleo conhece o suplemento: uma exceção de CORS só para a origem dele (`ADDIN_ORIGIN = 'https://localhost:3000'`, rotas fixas) | `src/dashboard/security.ts` | É o acoplamento que este princípio proíbe: o núcleo mudou por causa de um cliente |
| E o painel conhece o prefixo de sessão do suplemento (`powerpoint-addin-` → `metadata.hostApp`) e um broker próprio | `chat.ts:272-285`; `WebChannelAdapter.ts:57, 358-370` | Idem — conhecimento do cliente dentro do núcleo |
| O protocolo de acompanhamento de um turno já está escrito **duas vezes**: no script do painel (`index.html`, `startTurnPolling`) e no suplemento (`turnPolling.ts`) | `src/dashboard/public/index.html:1184-1279`; `addins/powerpoint-addin/src/taskpane/turnPolling.ts` | Sem um contrato público, cada cliente novo vira mais uma cópia |
| O núcleo já tem uma regra parecida para os canais: nenhum `src/loop/**` importa um `*Adapter` | `ARCHITECTURE.md`, "Dependências proibidas" | O princípio existe para canais; falta para experiências opcionais |

## Fase 2 — Crítica

- **"Separar em pasta" não isola licenças.** Distribuir no mesmo repositório continua sendo distribuir. O isolamento real
  vem de: o núcleo não importar nada do harness, o harness declarar as próprias dependências (sem empacotar binários de
  terceiros) e manter o próprio inventário de licenças.
- **Risco de duplicar regras de negócio no harness.** O harness não pode virar um segundo backend inteligente: ele não tem
  memória, roteamento de modelos, persona nem execução.
- **Risco do oposto: o núcleo se moldar ao harness.** Exceções de CORS, prefixos e brokers feitos sob medida (como no caso do
  suplemento) são a forma concreta desse risco.
- **Contrato público precisa existir de verdade.** Hoje o contrato da API de chat está implícito no código e em duas cópias
  de cliente. Sem um contrato explícito e testado, "usar só interfaces públicas" não é verificável.

## Fase 3 — Alternativas

| # | Alternativa | Vantagens | Desvantagens |
|---|---|---|---|
| A | Incorporar a interface de voz ao núcleo (versão anterior da ADR-030: rota de sinalização e página de voz própria no servidor do NewClaw) | Um processo, uma instalação | O núcleo passa a conhecer a interface de voz; dependências e avisos misturados |
| **B** | **Harness opcional, com dependência num sentido só** | Núcleo autoral e leve; obrigações de licença concentradas; harness substituível | Mais uma peça para instalar e versionar; exige contrato público explícito |
| C | Harness como "plugin" carregado dentro do processo do núcleo | Um processo só | O núcleo passa a carregar código e dependências de terceiros — o oposto do objetivo |

## Fase 4 — Decisão proposta (B)

### Regras

1. **Sentido único:** o harness depende do núcleo; o núcleo não importa, não serve, não conhece e não testa o harness.
   Verificável por `grep` (como "Dependências proibidas"): nenhum arquivo do núcleo menciona o harness.
2. **Só interfaces públicas:** o harness usa as rotas HTTP documentadas (contrato versionado) e nada além disso.
3. **Sem segundo cérebro:** o harness não tem memória, histórico próprio, roteamento de modelos, persona nem execução.
   Sessões e histórico ficam sob controle do núcleo.
4. **Instalação básica intacta:** instalar e usar o NewClaw não instala nem exige nada do harness. A suíte de regressão do
   núcleo passa igual com e sem o harness presente.
5. **Ativação verifica requisitos:** o harness informa o que falta (serviços, runtime, versão do núcleo compatível) em vez de
   assumir.
6. **Inventário de terceiros:** toda dependência do harness tem nome, versão, origem e licença registradas; o harness nunca
   empacota binários de terceiros na distribuição — o usuário os instala dos repositórios oficiais (PyPI, npm).
7. **Contrato antes do cliente:** quando um harness precisa de algo do núcleo, a extensão entra no núcleo como **interface
   pública genérica**, útil a qualquer cliente, nunca como exceção para um cliente específico.

### O que o núcleo passa a oferecer (genérico, não "para a interface de voz")

- **Contrato do turno documentado e versionado:** envio, aceitação, andamento, progresso, resposta, cancelamento, aprovação
  e histórico. Inclui teste de conformidade na suíte de regressão.
- **Um cliente público desse contrato:** módulo neutro, sem dependências, servido pelo próprio núcleo. Painel, suplemento e
  harnesses passam a usar o mesmo módulo, e as cópias somem, cada migração numa etapa própria com teste.

Feito na Etapa 1 da ADR-030 (29/10/2026):
- o contrato, em `docs/CONTRATO_DO_TURNO.md`, versão anunciada em `GET /api/status` → `status.contracts.turn`;
- o cliente público, em `src/dashboard/public/turn-client.js`;
- a conformidade, no teste `S457`.

### Fora do escopo desta ADR

- Corrigir os acoplamentos já existentes do suplemento do PowerPoint (exceção de CORS, prefixo, broker): ficam registrados
  como débito, com migração possível para o contrato público.
- O repositório da interface de voz: decidido na R1 da ADR-030 (repositório separado, 29/10/2026).

## Fase 5 — Validação

- **Baseado em evidência:** sim — o acoplamento e a duplicação citados estão no código.
- **Estrutural:** sim — troca "cada cliente ganha uma exceção" por "um contrato público".
- **Reduz complexidade:** a médio prazo, sim (três cópias do protocolo viram uma). No curto prazo, há mais uma peça.
- **Uma fonte de verdade:** o contrato passa a ser a única definição do protocolo do turno.
- **Incremental e reversível:** cada regra se aplica a código novo; a migração do que existe é opcional e etapa por etapa.

## Critérios de verificação

- `grep` do nome do harness em `src/` retorna zero.
- A suíte de regressão do núcleo é a mesma com o harness instalado e sem ele.
- O teste de conformidade do contrato do turno faz parte da suíte do núcleo.
- O inventário de licenças do harness cobre 100% das dependências diretas e transitivas.
