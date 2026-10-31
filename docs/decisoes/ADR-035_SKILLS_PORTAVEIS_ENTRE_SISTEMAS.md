# ADR-035 — Skills portáveis entre sistemas: cabeçalho de origem e marcadores de caminho

Data: 31/10/2026. Status: **proposta, revisão 2** (revisão 2: os três limites da seção 8, validação presa ao
conteúdo, `requer` com "não verificado", avisos no catálogo e no conteúdo, `origem` renomeado para `sistema_origem`). Nada será implementado antes da aprovação da operadora.

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
  onde nasceu (`sistema_origem`), onde faz sentido (`plataformas`) e onde já funcionou (`validada_em`).
- **"Origem" quer dizer o quê?** Pode ser o sistema, a instalação ou a fonte (um repositório no GitHub, um zip). São
  fatos diferentes, por isso cada um tem o próprio nome: `sistema_origem` (win32/linux/darwin), `instalacao_origem`
  (qual NewClaw a aprendeu). A fonte de skills de terceiros não entra na V1 (seção 8).
- **Validada quando, e em qual versão?** Uma skill validada há seis meses e editada ontem não está validada. Por isso
  cada entrada de `validada_em` leva o resumo do conteúdo que foi validado (seção 5).
- **O cabeçalho resolve os caminhos?** Não sozinho. Ele diz que a skill tem caminhos; ainda é o corpo que os usa.
  Daí os marcadores (seção 2).
- **Reescrever o corpo na importação** (trocar `C:\NewClaw` por `/home/.../NewClaw`) foi descartado: o arquivo
  seria diferente em cada máquina, e o Sync Agent mandaria a versão reescrita de volta, num pingue-pongue. O corpo
  viaja igual; a troca é feita só na hora de carregar.
- **Nome da máquina, do usuário ou IP** no cabeçalho foi descartado: as skills podem ir parar no GitHub. Para dizer
  de qual instalação veio, basta o id curto que a ADR-034 já criou.
- **Componente decidindo pelo agente?** (Princípio da Preservação do Raciocínio.) O carregamento só **informa**
  ("validada no Windows; os comandos podem não valer aqui"), e o agente decide. Nem a skill cujo `plataformas`
  exclui este sistema é escondida (D3): ela é oferecida com o aviso, e o agente decide se algo dela serve aqui.
- **`validada_em` crescendo sozinho:** hoje **não existe** registro de "esta skill foi usada num objetivo que deu
  certo" (`auto_skills` não tem contador de uso; o `OperationalKnowledge` conta comandos, não skills). Inventar
  essa ligação agora seria adivinhar. Na V1, `validada_em` começa com o `sistema_origem` e cresce por confirmação no
  painel.
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
sistema_origem: win32
validada_em: win32@3f9a1c2e
plataformas: todas
requer: pdftotext
instalacao_origem: pc-3f9a1c2e
formato_skill: 1
---
```

| Campo | Significado | Valores | Quem preenche |
|---|---|---|---|
| `sistema_origem` | Sistema onde a skill nasceu. Não muda depois | `win32`, `linux`, `darwin` | O NewClaw, ao aprender (`process.platform`); à mão, quem escreve |
| `validada_em` | Sistemas onde ela já funcionou de verdade, e com qual conteúdo | Lista `sistema@resumo`: `win32@3f9a1c2e, linux@3f9a1c2e` | Começa com o `sistema_origem` e o resumo atual; cresce por confirmação (seção 5) |
| `plataformas` | Onde ela faz sentido | `todas`, ou lista | O modelo, ao aprender (ele já escreve isso hoje na descrição, como texto); à mão, quem escreve |
| `requer` | Programas necessários, **por nome**, sem caminho | Lista: `himalaya, pdftotext` | O modelo, ao aprender, a partir dos comandos usados |
| `instalacao_origem` | Instalação do NewClaw onde a skill foi aprendida ou escrita. Não é o sistema nem a fonte | `<nome>-<id8>` da ADR-034 | O NewClaw (o id da própria instalação); ausente em skill de terceiros |
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
| `plataformas` não inclui este sistema | Carrega, com uma linha para o agente: "feita só para win32; este sistema é linux; os passos podem não existir aqui" (D3). O painel mostra "feita para outro sistema". A skill continua viajando para as outras máquinas |
| `requer` lista um programa que não está no PATH | Carrega, com uma linha para o agente: "falta: himalaya". O painel mostra o mesmo |
| Sem os campos novos | Como hoje |

| `requer` lista algo que a sonda não sabe conferir | Carrega, com uma linha para o agente: "requisito não verificado: X" |

A verificação de `requer` usa a sonda de programas que já existe (`EnvironmentProbe`: `where` no Windows,
`command -v` nos outros), não um teste novo. Cada item tem um de três estados: **encontrado**, **falta** ou **não
verificado**. Nunca "provavelmente tem".

Na V1, `requer` aceita só nomes de programa. Versão mínima (`python>=3.10`), serviço (`docker` rodando) e acesso a
um serviço externo exigem sondas próprias; entram num `formato_skill: 2`, quando houver necessidade medida. Até lá,
quem escreve à mão põe esses requisitos no texto da skill, e o agente os lê.

**Onde os avisos aparecem:** a lista de skills que o planejador recebe (`SkillLoader.getSkillSummaries` e
`GoalPlanner.loadSkillsSummary`, hoje `- nome: descrição`) ganha os avisos curtos, por exemplo
`- nome: descrição [feita para win32; falta: himalaya]`. O conteúdo inteiro, que só entra quando a skill casa com o
pedido (`getSkillContextForQuery`), começa pelas linhas completas. Os avisos são calculados uma vez, no
`SkillLoader`, e guardados na própria skill; os dois resumos usam o mesmo campo, sem cada um montar o seu.

### 4. Importação (ADR-020/ADR-034)

Antes do detector de caminhos, `importarPacote` lê o cabeçalho:
- Com `formato_skill`: a decisão usa os campos. Corpo só com marcadores, sem caminho literal de outro sistema → segue
  a regra de ativação da ADR-017, como na ADR-034. Caminho literal de outro sistema no corpo → proposta, como hoje.
- Sem `formato_skill`: o detector decide, como hoje.
- `plataformas` que exclui este sistema não é motivo para recusar: a skill entra e é oferecida com o aviso.
- A importação não mexe em `validada_em`: a validação de outro sistema continua valendo como fato daquele sistema.

### 5. Como `validada_em` cresce, e o que ela garante

- Cada entrada é `sistema@resumo`. O resumo são os 8 primeiros caracteres do SHA-256 do **corpo** da skill: sem o
  cabeçalho, com as quebras de linha normalizadas (CRLF vira LF) e com os marcadores ainda não trocados. Assim o
  mesmo conteúdo dá o mesmo resumo no Windows e no Linux.
- Corpo mudou depois da validação: o resumo não bate, e o aviso vira "validada em win32 numa versão anterior desta
  skill". A validação antiga não some (é histórico), mas também não vale para o texto novo.
- O resumo é calculado ao carregar, não guardado num campo à parte, para não existirem duas fontes de verdade.
- V1: botão "funcionou aqui" no painel de skills, que acrescenta `este sistema@resumo atual`. A pessoa também pode
  editar o campo.
- Depois: quando o uso de uma skill num objetivo for registrado (hoje não é), um objetivo aprovado pelo juiz que usou
  a skill acrescenta o sistema. Isso exige uma decisão própria; não está nesta ADR.

### 6. Migração das skills existentes (uma vez, com relatório)

- Aprendidas (`auto_skills`): `sistema_origem` sai da linha "Aprendida automaticamente ... (win32)" do corpo,
  quando existe. `validada_em` = `sistema_origem@resumo` do corpo já migrado. `plataformas` e `requer` ficam **vazios** (desconhecidos), sem chute.
- Escritas à mão: só `formato_skill: 1`; o resto fica desconhecido até alguém preencher.
- Caminhos da pasta do NewClaw, do workspace e das skills nos corpos viram marcadores.
- Pastas pessoais: a migração lista os caminhos literais que sobraram, agrupados por pasta, e **propõe** um nome
  para cada uma. A operadora confirma ou troca o nome no relatório; só as pastas confirmadas entram na tabela e viram
  `{PASTA:nome}`. As outras ficam literais.
- A migração gera um relatório: o que mudou em cada arquivo, antes e depois, e quais skills ainda têm caminho literal.
  Ela roda primeiro numa cópia. Antes de rodar, faz um pacote de segurança (ADR-020).

### 7. Banco

`auto_skills` ganha `sistema_origem`, `validada_em`, `plataformas`, `requer`. `exportSkillFile` escreve os campos, e o pacote
da ADR-034 os leva. Sem elas, o arquivo regerado a partir do banco perderia o cabeçalho.

### 8. Limites explícitos (o que esta ADR não muda)

1. **Descobrir e carregar uma skill não é executar.** O agente sempre recebe o catálogo (nome, descrição e avisos
   curtos). O conteúdo inteiro só entra quando a skill casa com o pedido, como já acontece hoje. Qualquer comando que
   o agente tire de uma skill passa pelos mesmos controles de qualquer outro comando: o modo SAFE com aprovação
   (ADR-005) e o bloqueio de comandos destrutivos (`isDestructive`). Uma skill não concede permissão: o campo
   `tools:` é só lido, não libera ferramenta nenhuma (conferido no `SkillLoader`).
2. **Incompatível não é indisponível.** Skill feita para outro sistema continua no catálogo, com o aviso (D3).
   Disponível (existe), compatível (feita para este sistema), aplicável (serve ao pedido) e executável (os
   programas existem) são quatro perguntas diferentes. As duas do meio são do agente; a primeira e a última são
   fatos que o NewClaw mede e informa.
3. **Procedência e integridade não são confiança.** `sistema_origem`, `instalacao_origem` e o resumo dizem de onde a
   skill veio e se o texto mudou, não que ela é segura. Na V1, a confiança vem de outro lugar:
   - a fronteira da ADR-034: só as instalações pareadas no Syncthing (as três máquinas da operadora) escrevem na
     pasta;
   - a regra de ativação da ADR-017, que vale igual para a skill local e para a importada (ADR-034, D2), com aviso
     e `/skill_desativar`. Desativar é a revogação, e reimportar não reativa o que foi desativado aqui (teste 9
     da ADR-034);
   - caminho literal de outro sistema sempre vai para proposta;
   - o histórico de alterações fica no versionamento do Syncthing e nos pacotes numerados da ADR-034.

   Skill de terceiros (um repositório no GitHub, um zip de outra pessoa) é outro caso: precisa de fonte declarada,
   assinatura ou revisão antes de ativar. Fica para uma decisão própria e não entra por esta ADR.

## Decisões da operadora

| # | Pergunta |
|---|---|
| D1 | Os nomes dos campos (`sistema_origem`, `validada_em`, `plataformas`, `requer`, `instalacao_origem`, `formato_skill`) ficam assim? (Revisão 2: `origem` virou `sistema_origem`, para não ser confundido com a instalação nem com a fonte.) |
| D2 | **Decidido (31/10/2026): pastas pessoais já entram na V1**, com `{PASTA:nome}` e uma tabela local por instalação, editada no painel (seção 2). |
| D3 | **Decidido (31/10/2026): skill feita para outro sistema aparece com aviso**, nunca é escondida; o agente decide (seção 3). |

## Fase 5 — Validação

| Pergunta | Resposta |
|---|---|
| Baseada em evidência? | Sim: as 33 skills reais medidas, das quais 9 têm caminhos; o leitor conferido no código |
| Problema estrutural ou sintoma? | Estrutural: a skill passa a declarar fatos sobre si, em vez de a importação adivinhar pelo texto |
| Reduz a complexidade? | Mantém: nenhum arquivo novo; o detector continua como rede para as skills sem cabeçalho |
| Elimina fontes de verdade? | Uma: a plataforma deixa de existir só como texto livre na descrição |
| Cognitive Kernel? | Sim: o carregamento só entrega fatos ao agente, sem esconder nenhuma skill |
| Incremental? | Sim (plano abaixo) |
| Reversível? | Sim: os campos são ignorados por quem não os conhece; os marcadores voltam a ser caminhos com a migração inversa |

## Plano (depois da aprovação)

| Etapa | Entrega | Teste |
|---|---|---|
| 1 | `SkillLoader`: campos novos e expansão dos marcadores, inclusive `{PASTA:nome}` com a tabela local | Versão antiga do leitor com cabeçalho novo = mesmo resultado; marcador vira caminho com o separador certo nos três sistemas, também no resto do caminho; nome sem pasta fica intacto e gera o aviso; marcador desconhecido fica intacto |
| 2 | Aprender: `montarCorpoDaSkill` troca prefixos (das pastas do NewClaw e da tabela) por marcadores; `exportSkillFile` e `auto_skills` com os campos | Skill aprendida tem os campos e nenhum caminho da tabela no corpo; prefixo mais longo ganha; maiúsculas no Windows; regerar a partir do banco mantém o cabeçalho; a tabela não entra no pacote da ADR-034 |
| 3 | Carregamento: as situações da seção 3, o `requer` com os três estados, os avisos no catálogo e no conteúdo, e o resumo da `validada_em` | Regressão com skills de exemplo em cada caso; o mesmo corpo com CRLF e com LF dá o mesmo resumo; corpo editado mostra "versão anterior"; nenhuma skill some do catálogo |
| 4 | Importação lê o cabeçalho antes do detector | Skill só com marcadores, vinda de outro sistema, segue a ADR-017; com caminho literal, fica proposta; sem cabeçalho, como hoje |
| 5 | Migração das 33 skills, primeiro numa cópia, com relatório e pacote de segurança | Relatório revisado pela operadora antes de rodar na instalação real |
| 6 | Painel: "funcionou aqui", "feita para outro sistema", "falta: X", tabela de pastas e "pasta não configurada" | Prova real: uma skill aprendida no PC carregando na VPS |

A etapa 4 depende da ADR-034. As etapas 1 a 3 servem sozinhas, para backup e importação manual (ADR-020).
