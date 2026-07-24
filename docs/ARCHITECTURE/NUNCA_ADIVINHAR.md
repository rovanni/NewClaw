# Nunca Adivinhar

> Documento normativo. Define o comportamento obrigatório de qualquer componente determinístico
> do NewClaw diante de informação insuficiente: relatar a ausência, nunca preencher a lacuna com
> uma suposição plausível.

## 1. Objetivo

Garantir que toda informação que chega à camada de julgamento (o `GoalPlanner`, via LLM) seja
observada ou explicitamente ausente — nunca inferida silenciosamente por um componente
determinístico e apresentada como se fosse fato. A confiabilidade do sistema depende de a camada
de julgamento poder distinguir "isto é verdade porque foi checado" de "isto é uma suposição" — um
componente que adivinha e não sinaliza isso apaga essa distinção.

## 2. Motivação

Um componente determinístico que precisa de um dado que não tem (SO não detectado, comando de
instalação sem entrada explícita para a plataforma, nome de dependência que não pôde ser
extraído do texto de erro) enfrenta duas opções: inventar um valor plausível, ou admitir que não
sabe. A primeira opção é sedutora porque "geralmente funciona" — mas quando falha, falha de forma
silenciosa e difícil de depurar, porque nada no sistema registrou que aquele valor era um palpite.
`resolveInstallCommand()` (`src/loop/planning/resolveInstallCommand.ts`) documenta o caso concreto
que motivou nomear este princípio: antes de existir, 19 de 20 entradas de `KNOWN_DEPS` tinham
`installCmd` fixo em sintaxe Debian/Ubuntu (`sudo apt install X -y`) injetado verbatim em
`exec_command` sem checar o SO — num Windows, isso executaria um comando inexistente
("sudo"/"apt" não existem lá), e o erro resultante em nada indicava que a causa raiz era uma
suposição de plataforma nunca verificada.

## 3. Definição

Diante de um dado necessário que não está disponível com certeza suficiente, um componente
determinístico deve escolher entre exatamente duas saídas:

1. **O dado, quando genuinamente conhecido** — extraído, detectado, ou configurado
   explicitamente para aquele caso.
2. **Ausência explícita** (`undefined`, `null`, string vazia, ou equivalente) — nunca um valor
   "razoável" construído por heurística, tradução entre plataformas, ou extrapolação de um caso
   parecido.

Não existe uma terceira saída "melhor esforço" nesta definição. Um componente que não sabe deve
dizer que não sabe — a decisão sobre o que fazer diante dessa ausência pertence à camada de
julgamento (ou, em último caso, a uma instrução explícita ao usuário), nunca ao componente que
descobriu a lacuna.

## 4. Responsabilidades

Um componente determinístico **DEVE**:

- Retornar ausência explícita sempre que o dado necessário não tiver sido observado, detectado ou
  configurado para o caso exato em mãos.
- Tratar "plataforma não detectada" e "plataforma detectada mas sem entrada configurada para ela"
  como o mesmo caso: ausência — nunca cair num fallback de outra plataforma por proximidade.
- Deixar rastreável, no dado retornado ou no log, a diferença entre "verifiquei e não há" e
  "não tentei verificar" — as duas nunca devem ser indistinguíveis para quem depura depois.

Um componente determinístico **NÃO DEVE**:

- Traduzir um comando ou fato válido para uma plataforma em uma suposição de comando equivalente
  para outra plataforma sem configuração explícita para essa segunda plataforma.
- Usar um valor de fallback "genérico" (ex.: assumir Linux quando o SO não foi detectado) como
  substituto silencioso de detecção real.
- Inferir o nome de uma dependência, comando ou caminho a partir de correspondência aproximada de
  texto quando a extração determinística não encontrou uma correspondência exata — preferir
  retornar nada a arriscar um nome errado (ver `extractMissingExecutable()`, que devolve `null`
  em vez de tentar "adivinhar" um nome parecido).

## 5. Exemplos atuais

| Componente | Situação sem dado suficiente | Comportamento |
|---|---|---|
| `resolveInstallCommand()` | SO não detectado, ou sem entrada em `installByPlatform` para o SO detectado | Retorna `undefined` — nunca cai no `installCmd` legado (Linux) fora de Linux |
| `extractMissingExecutable()` | Texto de erro não bate com nenhum padrão reconhecido | Retorna `null` — nunca tenta um match aproximado |
| `OperationalKnowledge.buildEvidenceHint()` | Nenhum registro para (ferramenta, plataforma) consultada | Retorna string vazia — nunca sugere um comando de outra plataforma/ferramenta parecida |
| `GoalEvaluator` (KNOWN_DEPS lookup) | Nome extraído não bate com nenhuma chave do catálogo | Segue sem `depInfo` — nunca escolhe a entrada "mais parecida" do catálogo |

## 6. Exceções

Não há exceção conhecida a este princípio. Diferente do Evidence Provider Pattern (que tem duas
classes nomeadas de exceção para decisão determinística), "Nunca Adivinhar" é sobre a integridade
do próprio dado antes de ele virar decisão ou evidência — não existe caso legítimo em que
apresentar uma suposição como fato observado seja a escolha correta. Se um caso futuro parecer
exigir essa exceção, o desenho correto é sinalizar explicitamente a suposição como tal (ex.: um
campo `confidence` ou `inferred: true`), nunca omitir a distinção.

## 7. Benefícios

- **Falhas depuráveis**: quando algo dá errado por falta de dado, o sistema já reportou isso
  explicitamente antes — não é preciso reconstruir a cadeia de suposições silenciosas.
- **Confiança calibrada na camada de julgamento**: o `GoalPlanner` só recebe fatos que o
  componente de origem realmente verificou, nunca palpites disfarçados de observação.
- **Portabilidade honesta**: um projeto open source roda em ambientes imprevisíveis — reportar
  "não sei" para um ambiente não testado é mais seguro do que estender por analogia um
  comportamento validado só noutro.

## 8. Relação com outros princípios

- **Evidence Provider Pattern**: um Evidence Provider que "adivinha" quando não tem evidência
  suficiente viola tanto este princípio quanto o requisito de degradação segura (retornar vazio)
  já definido em `EVIDENCE_PROVIDER_PATTERN.md`, Seção 5.
- **Separação Distribuído × Aprendido**: quando nem o catálogo distribuído nem o conhecimento
  aprendido têm uma entrada para a consulta, a resposta correta é ausência — nunca inferir um
  valor a partir de uma das duas fontes para preencher a lacuna da outra.

## 9. Checklist para novos componentes

Antes de implementar um componente que produz um dado a partir de detecção, extração ou consulta,
responder:

- [ ] Existe algum caminho de código onde este componente retorna um valor "razoável" em vez de
      ausência explícita, quando o dado real não foi observado?
- [ ] Um fallback de plataforma/idioma/formato "parecido" está sendo usado como substituto de
      configuração explícita para o caso exato?
- [ ] É possível, a partir do valor retornado sozinho, distinguir "verificado e ausente" de
      "nunca verificado"?
- [ ] Em caso de dúvida entre inferir e retornar ausência, o desenho escolheu retornar ausência?
