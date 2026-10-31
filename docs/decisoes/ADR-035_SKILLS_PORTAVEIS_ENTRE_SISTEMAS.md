# ADR-035 — Skills portáveis entre sistemas: cabeçalho de origem e marcadores de caminho

Data: 31/10/2026. Status: **proposta**. Nada será implementado antes da aprovação da operadora.

Relacionadas: ADR-017 (aprendizado de skills automático), ADR-020 (backup e importação mesclando; detector de
caminhos de outro sistema), ADR-034 (Sync Agent; skills chegando de outras instalações).

## Contexto

O NewClaw roda em Windows, Linux e Mac, e com a ADR-034 uma skill aprendida numa instalação chega às outras. Uma
skill é texto para o agente seguir. Se esse texto tem `C:\Users\...` e chega à VPS, ensina o agente a errar.

### O que foi medido (31/10/2026, `C:\Users\<operadora>\NewClaw\skills`)

- 33 skills, 9 com caminho de sistema no corpo:
  - 5 com a pasta do próprio NewClaw (`gmail-himalaya`, `aprendida_patch_newclaw_codigo_proprio`,
    `extrair_texto_pdf`, `verificar_novidades_emails_agenda`, `skill-manager`);
  - 3–4 com pastas de dados da operadora (`<unidade>:\<pasta de aulas>`), skills de aula;
  - 1 que só existe no Windows (`localizar_app_windows`, lê o registro).
- O cabeçalho de hoje tem `name`, `description`, `version`, `triggers`, `tools` e `tags`. A plataforma aparece só
  como texto: na descrição, quando o modelo a escreveu, e na linha
  `> Aprendida automaticamente pelo NewClaw em <data>, ao concluir: "..." (win32).` que `montarCorpoDaSkill`
  (`src/loop/aprendizadoDeSkills.ts`) põe no corpo.

### O que já existe

| Peça | Onde | O que faz |
|---|---|---|
| Leitor do cabeçalho | `SkillLoader.parseFrontmatter` | Linha a linha, `chave: valor`; só `tags` aceita lista YAML; **chave desconhecida é ignorada** (switch sem `default`) |
| Gravação da aprendida | `SkillLearner.exportSkillFile` | Regera o `SKILL.md` a partir da linha de `auto_skills` (`name`, `description`, `triggers`, `tools`, `tags`) |
| Detector de caminhos | `temCaminhoDeOutroSistema` (`src/core/backupDoConhecimento.ts`) | `X:\` vindo do Windows, `/home/` do Linux, `/Users/` do Mac; usado pela importação para mandar a skill para revisão (`SKILL.md.revisar`) |
| Sistema do pacote | `manifesto.sistema` (ADR-020) | O pacote inteiro diz de qual sistema veio, mas não cada skill |

O detector funciona, mas adivinha pelo texto e trata o pacote como um todo. Ele não sabe que uma skill nasceu no
Windows e já foi usada no Linux, nem que uma skill só faz sentido no Windows.

## Pergunta

O que cada skill precisa declarar sobre si para que a importação, noutro sistema, saiba o que fazer com ela sem
adivinhar? E como escrever os caminhos para que o mesmo arquivo sirva nas três máquinas?

## Fase 2 — Crítica da hipótese ("cabeçalho com a origem")

- **Quebra as instalações antigas?** Não. O leitor ignora chaves que não conhece, então um `SKILL.md` com campos
  novos é lido por uma versão antiga como se não os tivesse. Isso vale enquanto os campos novos forem linhas planas
  `chave: valor`. O leitor não entende aninhamento: num bloco `a:` seguido de `  name: x`, ele tiraria o recuo e
  leria `name: x` como o nome da skill. **Regra: só linhas planas, valores separados por vírgula.**
- **`:` dentro do valor.** O leitor junta o que vem depois do primeiro `:`; `C:\...` sobreviveria, mas caminho não
  entra no cabeçalho de jeito nenhum (abaixo).
- **Só a origem basta?** Não. "Veio do Windows" não diz se a skill depende do Windows. A que lê o registro não serve
  no Linux; a que extrai texto de PDF serve em qualquer lugar, se o programa existir. Por isso três fatos separados:
  onde nasceu (`origem`), onde faz sentido (`plataformas`) e onde já funcionou (`validada_em`).
- **O cabeçalho resolve os caminhos?** Não sozinho. Ele diz que a skill tem caminhos; ainda é o corpo que os usa.
  Daí os marcadores (seção 2).
- **Reescrever o corpo na importação** (trocar `C:\NewClaw` por `/home/.../NewClaw`) foi descartado: o arquivo
  seria diferente em cada máquina, e o Sync Agent mandaria a versão reescrita de volta, num pingue-pongue. O corpo
  viaja igual; a troca é feita só na hora de carregar.
- **Nome da máquina, do usuário ou IP** no cabeçalho foi descartado: as skills podem ir parar no GitHub. Para dizer
  de qual instalação veio, basta o id curto que a ADR-034 já criou.
- **Componente decidindo pelo agente?** (Princípio da Preservação do Raciocínio.) O carregamento só **informa**
  ("validada no Windows; os comandos podem não valer aqui"), e o agente decide. A única decisão determinística é
  não oferecer a skill quando `plataformas` exclui este sistema. Ela é aceitável porque quem decidiu foi o autor da
  skill, de forma explícita, e não uma heurística: é o mesmo caso de uma ferramenta que não existe neste sistema.
- **`validada_em` crescendo sozinho:** hoje **não existe** registro de "esta skill foi usada num objetivo que deu
  certo" (`auto_skills` não tem contador de uso; o `OperationalKnowledge` conta comandos, não skills). Inventar
  essa ligação agora seria adivinhar. Na V1, `validada_em` começa com a `origem` e cresce por confirmação no painel.
  O crescimento automático fica para quando o uso da skill for registrado (seção 5).

## Fase 3 — Alternativas

| Alternativa | A favor | Contra |
|---|---|---|
| A. Manter só o detector de caminhos (hoje) | Nada a fazer | Adivinha pelo texto; não distingue "nasceu no Windows" de "só serve no Windows"; manda para revisão skills que só citam a pasta do NewClaw |
| B. Uma skill por sistema (`SKILL.win32.md`, `SKILL.linux.md`) | Cada uma exata | Triplica o trabalho; o aprendizado gera uma só; as cópias divergem (`QUANDO_EXTRAIR_DUPLICACAO.md`) |
| C. Reescrever caminhos ao importar | Skill pronta no destino | Arquivo diferente por máquina; pingue-pongue no Sync Agent; reescrita errada estraga a skill sem aviso |
| **D. Cabeçalho com fatos + marcadores no corpo, resolvidos ao carregar** | Um arquivo para as três; compatível com as versões antigas; a importação lê fatos em vez de adivinhar | Migração única das skills existentes; cada instalação precisa configurar as pastas pessoais que usa (seção 2) |

**Gate "extensão antes de criação":** nenhum arquivo novo. Tudo é extensão do que existe:
`SkillLoader.parseFrontmatter` (campos novos e expansão dos marcadores), `SkillLearner.exportSkillFile` e
`montarCorpoDaSkill` (escrever os campos), `importarPacote` (ler os campos antes do detector) e colunas novas em
`auto_skills`.

## Decisão (proposta): alternativa D

### 1. O cabeçalho

```yaml
---
name: extrair-texto-pdf
description: Extrai o texto de um PDF do workspace
triggers: pdf, extrair, texto
tools: exec_command
origem: win32
validada_em: win32
plataformas: todas
requer: pdftotext
instalacao_origem: pc-3f9a1c2e
formato_skill: 1
---
```

| Campo | Significado | Valores | Quem preenche |
|---|---|---|---|
| `origem` | Sistema onde a skill nasceu. Não muda depois | `win32`, `linux`, `darwin` | O NewClaw, ao aprender (`process.platform`); à mão, quem escreve |
| `validada_em` | Sistemas onde ela já funcionou de verdade | Lista: `win32, linux` | Começa igual à `origem`; cresce por confirmação (seção 5) |
| `plataformas` | Onde ela faz sentido | `todas`, ou lista | O modelo, ao aprender (ele já escreve isso hoje na descrição, como texto); à mão, quem escreve |
| `requer` | Programas necessários, **por nome**, sem caminho | Lista: `himalaya, pdftotext` | O modelo, ao aprender, a partir dos comandos usados |
| `instalacao_origem` | Instalação de onde veio | `<nome>-<id8>` da ADR-034 | O NewClaw (o id da própria instalação) |
| `formato_skill` | Versão deste cabeçalho | `1` | O NewClaw |

Regras do formato:
1. **Nomes de sistema do Node**, os mesmos de `process.platform` e de `manifesto.sistema`. Nada de "Windows 11"
   ou "Ubuntu", que variam e não dá para comparar.
2. **Linhas planas**, uma por campo, listas separadas por vírgula (como `triggers` e `tools` já são).
3. **Nenhum caminho, nome de máquina, usuário ou IP** no cabeçalho.
4. **Campo ausente = desconhecido**, nunca um valor presumido. Skill de terceiros sem os campos segue a regra de
   hoje (detector de caminhos).
5. **O `name` e o resto do cabeçalho atual não mudam.**

### 2. Os marcadores de caminho no corpo

| Marcador | Vira | Exemplo no Windows | Exemplo no Linux |
|---|---|---|---|
| `{NEWCLAW}` | Pasta da instalação | `C:\Users\<u>\NewClaw` | `/home/<u>/NewClaw` |
| `{WORKSPACE}` | Workspace configurado | `...\NewClaw\workspace` | `.../NewClaw/workspace` |
| `{SKILLS}` | Pasta das skills | `...\NewClaw\skills` | `.../NewClaw/skills` |

- O corpo guarda o marcador. `SkillLoader`, ao carregar, troca pelo valor desta instalação, com o separador do
  sistema. O arquivo em disco não muda.
- Ao aprender, `montarCorpoDaSkill` troca os caminhos desta instalação pelos marcadores antes de gravar. É uma troca
  exata de prefixo conhecido (a pasta do NewClaw, do workspace, das skills), não um palpite sobre o texto.
- **Pastas de dados da pessoa entram com marcador com nome (D2):** `{PASTA:aulas}`.
  - Cada instalação tem a sua tabela `nome → pasta`, editada no painel (Skills → "Pastas"). A tabela é **local**:
    não vai no pacote da ADR-034, porque a mesma pasta fica num lugar diferente em cada máquina.
  - O nome usa só letras minúsculas, números e hífen. É o único pedaço que viaja dentro da skill.
  - Na expansão, o resto do caminho depois do marcador (`{PASTA:aulas}\2026\prova.docx`) ganha o separador deste
    sistema, até o primeiro espaço, aspas ou fim de linha.
  - **Nome sem pasta nesta instalação:** o marcador fica como está, e o agente recebe a linha "a pasta 'aulas'
    não está configurada nesta instalação". O painel mostra o mesmo, com um botão para configurar. Nada de procurar
    uma pasta parecida (`NUNCA_ADIVINHAR.md`).
  - Ao aprender, só os prefixos que estão na tabela viram marcador, e o mais longo ganha. No Windows a comparação
    ignora maiúsculas e minúsculas. Caminho fora da tabela fica literal, e o detector o segura noutro sistema.
- Marcador desconhecido fica como está, sem erro.

### 3. Carregamento (`SkillLoader`)

| Situação | O que acontece |
|---|---|
| `plataformas` é `todas`, ou inclui este sistema, e `validada_em` inclui este sistema | Carrega normal |
| `plataformas` inclui este sistema, mas `validada_em` não | Carrega, com uma linha para o agente: "validada em win32; ainda não neste sistema (linux); confira os comandos" |
| `plataformas` não inclui este sistema | Não é oferecida ao agente. O painel mostra "não se aplica a este sistema". A skill continua no disco e continua viajando para as outras máquinas |
| `requer` lista um programa que não está no PATH | Carrega, com uma linha para o agente: "falta: himalaya". O painel mostra o mesmo |
| Sem os campos novos | Como hoje |

A verificação de `requer` usa a sonda de programas que já existe (`EnvironmentProbe`: `where` no Windows,
`command -v` nos outros), não um teste novo.

### 4. Importação (ADR-020/ADR-034)

Antes do detector de caminhos, `importarPacote` lê o cabeçalho:
- Com `formato_skill`: a decisão usa os campos. Corpo só com marcadores, sem caminho literal de outro sistema → segue
  a regra de ativação da ADR-017, como na ADR-034. Caminho literal de outro sistema no corpo → proposta, como hoje.
- Sem `formato_skill`: o detector decide, como hoje.
- `plataformas` que exclui este sistema não é motivo para recusar: a skill entra, só não é oferecida aqui.

### 5. Como `validada_em` cresce

- V1: botão "funcionou aqui" no painel de skills, que acrescenta este sistema. A pessoa também pode editar o campo.
- Depois: quando o uso de uma skill num objetivo for registrado (hoje não é), um objetivo aprovado pelo juiz que usou
  a skill acrescenta o sistema. Isso exige uma decisão própria; não está nesta ADR.

### 6. Migração das skills existentes (uma vez, com relatório)

- Aprendidas (`auto_skills`): `origem` sai da linha "Aprendida automaticamente ... (win32)" do corpo, quando existe.
  `validada_em` = `origem`. `plataformas` e `requer` ficam **vazios** (desconhecidos), sem chute.
- Escritas à mão: só `formato_skill: 1`; o resto fica desconhecido até alguém preencher.
- Caminhos da pasta do NewClaw, do workspace e das skills nos corpos viram marcadores.
- Pastas pessoais: a migração lista os caminhos literais que sobraram, agrupados por pasta, e **propõe** um nome
  para cada uma. A operadora confirma ou troca o nome no relatório; só as pastas confirmadas entram na tabela e viram
  `{PASTA:nome}`. As outras ficam literais.
- A migração gera um relatório: o que mudou em cada arquivo, antes e depois, e quais skills ainda têm caminho literal.
  Ela roda primeiro numa cópia. Antes de rodar, faz um pacote de segurança (ADR-020).

### 7. Banco

`auto_skills` ganha `origem`, `validada_em`, `plataformas`, `requer`. `exportSkillFile` escreve os campos, e o pacote
da ADR-034 os leva. Sem elas, o arquivo regerado a partir do banco perderia o cabeçalho.

## Decisões da operadora

| # | Pergunta |
|---|---|
| D1 | Os nomes dos campos (`origem`, `validada_em`, `plataformas`, `requer`, `instalacao_origem`, `formato_skill`) ficam assim? |
| D2 | **Decidido (31/10/2026): pastas pessoais já entram na V1**, com `{PASTA:nome}` e uma tabela local por instalação, editada no painel (seção 2). |
| D3 | `plataformas` excluindo este sistema: a skill some para o agente (proposta) ou aparece com aviso? |

## Fase 5 — Validação

| Pergunta | Resposta |
|---|---|
| Baseada em evidência? | Sim: as 33 skills reais medidas, das quais 9 têm caminhos; o leitor conferido no código |
| Problema estrutural ou sintoma? | Estrutural: a skill passa a declarar fatos sobre si, em vez de a importação adivinhar pelo texto |
| Reduz a complexidade? | Mantém: nenhum arquivo novo; o detector continua como rede para as skills sem cabeçalho |
| Elimina fontes de verdade? | Uma: a plataforma deixa de existir só como texto livre na descrição |
| Cognitive Kernel? | Sim: o carregamento entrega fatos ao agente; a única decisão (não oferecer) é declarada pelo autor da skill |
| Incremental? | Sim (plano abaixo) |
| Reversível? | Sim: os campos são ignorados por quem não os conhece; os marcadores voltam a ser caminhos com a migração inversa |

## Plano (depois da aprovação)

| Etapa | Entrega | Teste |
|---|---|---|
| 1 | `SkillLoader`: campos novos e expansão dos marcadores, inclusive `{PASTA:nome}` com a tabela local | Versão antiga do leitor com cabeçalho novo = mesmo resultado; marcador vira caminho com o separador certo nos três sistemas, também no resto do caminho; nome sem pasta fica intacto e gera o aviso; marcador desconhecido fica intacto |
| 2 | Aprender: `montarCorpoDaSkill` troca prefixos (das pastas do NewClaw e da tabela) por marcadores; `exportSkillFile` e `auto_skills` com os campos | Skill aprendida tem os campos e nenhum caminho da tabela no corpo; prefixo mais longo ganha; maiúsculas no Windows; regerar a partir do banco mantém o cabeçalho; a tabela não entra no pacote da ADR-034 |
| 3 | Carregamento: as três situações da seção 3 e o `requer` | Regressão com skills de exemplo nos três casos |
| 4 | Importação lê o cabeçalho antes do detector | Skill só com marcadores, vinda de outro sistema, segue a ADR-017; com caminho literal, fica proposta; sem cabeçalho, como hoje |
| 5 | Migração das 33 skills, primeiro numa cópia, com relatório e pacote de segurança | Relatório revisado pela operadora antes de rodar na instalação real |
| 6 | Painel: "funcionou aqui", "não se aplica", "falta: X", tabela de pastas e "pasta não configurada" | Prova real: uma skill aprendida no PC carregando na VPS |

A etapa 4 depende da ADR-034. As etapas 1 a 3 servem sozinhas, para backup e importação manual (ADR-020).
