# ADR-016 — Juiz adaptativo: o motor descobre o que o modelo declara e aprende como ele se comporta

> **Status:** implementado (10/10/2026) — ver "Registro de implementação".
> **Data:** 10/10/2026
> **Origem:** operador — *"Esse juiz tem que ser escolhido quando a pessoa escolhe o modelo, não é você e deixar ele
> no modo incluído no código"*; *"Não adianta a gente fazer uma solução pontual para determinado modelo. Tem que ser
> genérico, que se adapte aos tipos de modelos atuais… por isso que eu falei que é um MCP"*.
> **Relacionadas:** `ADR-014` (motor único de validação), `ADR-010` (grounding fail-closed), `ADR-013` (flight recorder),
> `SOBERANIA_DA_CONFIGURACAO.md`, `NUNCA_ADIVINHAR.md`.

---

## Fase 1 — Compreensão

### O caso (produção, 10/10/2026, flight recorder `logs/avaliadores/`)

O modelo escolhido pelo operador como observador (`OBSERVER_MODEL`) passou a ser o juiz de TODOS os tipos de validação.
Em uso real, o mesmo juiz falhou de três jeitos diferentes, conforme o jeito de chamar:

| Como foi chamado | O que o modelo fez |
|---|---|
| Raciocínio do provedor ligado | Raciocinou 65–95 mil caracteres, 178–240 s, sem entregar JSON (estourou o orçamento) |
| Raciocínio desligado (`think:false`) | Escreveu a análise inteira DENTRO do conteúdo (7–67 mil caracteres) antes do JSON |
| Modelos "flash"/pequenos | Respondem JSON direto em segundos |

O que fazer não pode depender do nome do modelo: o operador escolhe qualquer um (local, nuvem, de qualquer família) e
a lista muda todo mês.

### Causa raiz

O motor chamava todo modelo do mesmo jeito, uma vez, com o orçamento inteiro do juiz. Não sabia (a) o que o provedor
declara do modelo nem (b) o que de fato funcionou com ele. Qualquer modelo cujo comportamento não coubesse no "jeito
único" consumia minutos do usuário e terminava em "sem veredito" (e, no grounding, em bloqueio — ADR-010).

## Fase 2/3 — Alternativas

| Alternativa | Por que não |
|---|---|
| Tabela de modelos conhecidos no código (`glm-5.3` → desligar raciocínio) | É o remendo pontual que o operador recusou; envelhece a cada modelo novo |
| Trocar o modelo do juiz por um "bom" | Fere a soberania da configuração: o modelo é do operador |
| Prazo maior | Mais minutos do usuário esperando um veredito que não vem |
| **Descobrir (declarado) + aprender (observado)** | Escolhida — o princípio do MCP: o cliente descobre o que o servidor suporta; o contrato é um só |

## Fase 4 — Decisão

Um **perfil do juiz** (`src/validation/perfilDoJuiz.ts`), compartilhado por todos os tipos de validação, alimenta o motor
com duas fontes de informação — nenhuma escrita à mão:

1. **Capacidade DECLARADA pelo provedor.** O catálogo de modelos (`ModelRegistryService.getCatalog()`, que no Ollama vem
   das `capabilities` reais do modelo) diz se o modelo tem canal de raciocínio. Se declara que **não** tem, há um modo
   só — nada de segunda chamada idêntica à primeira.
2. **Comportamento OBSERVADO.** Cada chamada registra, por modelo e por modo (`livre` = raciocínio do provedor,
   `desligado`), se produziu veredito válido e em quanto tempo. O modo que funciona (taxa suavizada por Laplace, para um
   azar isolado não enterrar um modo) passa a ser o primeiro da vez seguinte.

O motor então:

- tenta os modos em ordem, cada um com uma **fatia do orçamento** (o primeiro, 55% do que resta; o último, o restante) —
  o orçamento do juiz (`getBudgetAuxiliar('validacao')`) nunca é ultrapassado;
- **disjuntor:** modelo que falha em todos os modos, repetidamente (2 falhas seguidas em cada), deixa de ser chamado por
  5 minutos (então uma sondagem passa) — o usuário não espera minutos por um veredito que não vem;
- erro do provedor e cancelamento do usuário **não** são comportamento do modelo: não punem o perfil e não gastam o
  outro modo;
- persiste o aprendizado em `data/validation-judge-profile.json` (dados de uso, fora do código-fonte), sobrevivendo a
  reinícios.

### O que NÃO muda

- O modelo do juiz continua sendo o que o operador escolheu (`OBSERVER_MODEL`/painel). O perfil não troca modelo.
- A política de "sem veredito" de cada tipo (`bloquear` | `liberar`) continua declarada no descritor. Em particular, o
  grounding segue **fail-closed** (ADR-010). Mudar isso é decisão do operador, **pendente**: bloquear (atual) × entregar
  com aviso curto quando o juiz não vem a tempo.
- Nenhum nome de modelo no código (verificado por teste).

### Riscos que permanecem

- Um modelo que só funciona com raciocínio longo e que o orçamento do juiz não comporta continuará sem veredito; a
  correção é o operador escolher outro modelo para observar, ou ampliar o orçamento — não o código adivinhar.
- Provedores que não declaram capacidades caem só no comportamento observado (primeira validação pode gastar os dois
  modos).

## Registro de implementação

- `src/validation/perfilDoJuiz.ts` — `PerfilDoJuiz` (ordem dos modos, disjuntor, persistência, capacidades declaradas).
- `src/validation/ValidationEngine.ts` — laço de tentativas por modo com fatias; `modosTentados` no flight recorder;
  desfecho `juiz_indisponivel`. O perfil é injetado (padrão: perfil novo, isolado).
- `src/validation/motorPadrao.ts` — usa o perfil do processo quando ele está persistido (produção).
- `src/core/AgentController.ts` — no boot: persistência e resolvedor de capacidades (catálogo de modelos).
- Também nesta campanha: conferência da citação tolerante a forma tipográfica (sinal de menos Unicode, travessão,
  espaço não separável, markdown) e instrução de citação curta no prompt do grounding — o juiz reprovava citações
  corretas por diferença de caractere.
- Cobertura: `S374` (leitor/citação), `S376` (perfil, famílias de modelo simuladas, disjuntor, fiação).

## Adendo (10/10/2026, mesmo dia) — o orçamento acompanha o tamanho do trabalho

**Evidência (produção, 14:29, `glm-5.3-flash:cloud`):** "salvar na memória" com a análise da River colada no pedido →
prompt de 12.634 caracteres, 17 afirmações a conferir. O juiz de grounding estourou os 30 s nos dois modos e a resposta
— verdadeira, a memória foi mesmo gravada — foi bloqueada (`UNVALIDATED`). Reproduzido com o mesmo prompt: 84 s (com
raciocínio) e 71 s (sem), ambos `aprovado`. O mesmo modelo, em prompts de ~3 mil caracteres, leva 2–8 s. O orçamento era
o **piso** do perfil (30 s) porque a latência típica do provedor é uma média de chamadas rápidas e não enxerga o tamanho
do trabalho — a "correção estrutural pendente" já registrada em `auxTimeout.ts`.

**Decisão (ordem do operador: "ele tem que levar em conta o tamanho do trabalho"):**
- `getBudgetAuxiliar(perfil, …, tamanhoDoTrabalhoChars)`: o perfil `validacao` declara `msPorMilCaracteres = 8000` (pior caso
  medido ≈ 6,7 s/mil caracteres, +20% de folga). Orçamento = o MAIOR entre o derivado da latência e o proporcional ao
  trabalho, sempre dentro do teto do perfil (300 s). Sem informar o tamanho (ou noutros perfis), nada muda.
- O motor informa o tamanho do prompt montado; o resultado expõe `orcamentoMs`, e o `[GROUNDING-TRACE]` passa a registrar
  o orçamento real (antes mostrava sempre o piso).
- Modo **confiável** (≥ 2 chamadas e ≥ 60% de sucesso para aquele modelo) recebe o orçamento restante inteiro; só o modelo
  ainda desconhecido divide o tempo entre os dois modos (proteção contra quem se perde raciocinando).

**Verificado ao vivo** (mesmo prompt que foi bloqueado, motor real, modelo barato): perfil aquecido → `VALIDATED` em 56 s
(orçamento 101 s); a frio → `VALIDATED` em 44 s.

**Pendente (sem dados suficientes):** a taxa de 8 s/mil caracteres vem de um único prompt grande. Afinar com mais casos
reais do registro do juiz (`orcamentoMs` × `duracaoMs`) e, se fizer sentido, aprender a taxa por modelo no perfil.
Modelo que se perde raciocinando num prompt grande, ainda desconhecido, pode gastar o orçamento esticado uma vez antes de o
disjuntor passar a protegê-lo. A política para "sem veredito" (bloquear × entregar com aviso) segue como está, decisão do operador.
