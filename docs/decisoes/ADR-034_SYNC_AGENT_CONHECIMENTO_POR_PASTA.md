# ADR-034 — NewClaw Sync Agent: o conhecimento entre instalações por uma pasta sincronizada

Data: 31/10/2026. Status: **proposta, revisão 4** (revisão 4: skill importada segue a mesma regra de ativação da
skill aprendida localmente, ADR-017, em vez de sempre esperar aprovação; revisão 3: ordem da publicação, retenção pelos cursores,
validação da origem, regras da trava, skills pendentes protegidas da limpeza e os 12 testes de aceitação). Revisão 2 (ajustes pedidos pela operadora na primeira leitura: pacotes
imutáveis, SHA-256, uma importação por vez, versionamento na pasta, skills sempre com aprovação (revisto na 4), V1/V2/V3 e a tela
"Sincronização de Conhecimento"). Nada será implementado antes da aprovação.

Relacionadas: ADR-020 (backup e importação mesclando — esta ADR a automatiza), ADR-028 (apagar memória só com
confirmação), ADR-031 (experiências opcionais não impõem dependências ao núcleo), `REUTILIZACAO_ANTES_DA_CRIACAO.md`,
`NUNCA_ADIVINHAR.md`.

## Fase 1 — Compreensão

### O problema

A operadora tem três instalações: o PC Windows, o notebook e a VPS Linux. Cada uma aprende sozinha: memória, skills
aprendidas, skills em arquivo. O que uma aprende, as outras não sabem, e ela precisa ensinar de novo. Nas palavras
dela: *"é uma coisa muito preciosa que eu tenho que ficar repassando"*. E depois: *"o legal seria automatizar"*.

### O que já existe (ADR-020, aceita e validada em 14/10/2026)

| Peça | Onde | O que faz |
|---|---|---|
| `criarPacote` | `src/core/backupDoConhecimento.ts` | `.zip` com o banco (Online Backup API, correto com WAL), `skills/**`, perfil dos juízes e manifesto (versão do app e do esquema, sistema de origem, contagens). Segredos ficam fora por padrão. |
| `importarPacote` | idem | Mescla sem apagar nada local: memória que falta entra (nem id repetido, nem nome+conteúdo repetido); nós estruturais de outra instalação ficam fora; preferência em conflito, a local vence; caminho de outro sistema entra como `REVISAR`, fora das buscas; arestas e `auto_skills` com `INSERT OR IGNORE`; skill em arquivo diferente fica ao lado (`SKILL.md.importada`). **Antes, gera um pacote de segurança do estado atual.** |
| CLI e painel | `newclaw backup`, `newclaw import`; Config → Backup | Os mesmos, à mão. |

Prova real da ADR-020: as 107 memórias da instalação Linux foram importadas numa cópia da Windows, que tinha 95 → 123,
com 60 que já existiam e 2 para revisar. O boot rodou sem erros.

**O que falta é só a automação.** Hoje alguém precisa exportar, levar o arquivo e importar.

### O que não funciona

Sincronizar o `data/newclaw.db` com um programa de arquivos (Syncthing, OneDrive, Drive). Com o banco aberto em modo
WAL, a cópia pega o banco e o `-wal` em momentos diferentes e corrompe. Isso foi levantado nas conversas da operadora
com outros assistentes, e o próprio desenho do SQLite confirma.

## Fase 2 — Crítica

- **Um programa à parte (o "Sync Agent" como executável próprio).** Seria outro processo para instalar, atualizar e
  monitorar, e teria que abrir o banco do NewClaw por fora. O núcleo já tem o pacote, a importação, o painel e o
  processo vivo. Por isso o "agente" desta ADR é um **módulo do núcleo**, não um programa.
- **O NewClaw falando direto com OneDrive ou Google Drive.** Traria SDKs e credenciais de cada nuvem para o núcleo e
  prenderia a funcionalidade a um fornecedor. A pasta é a fronteira: quem transporta é o programa que a pessoa já usa.
- **Pacote de todos num arquivo só.** Duas máquinas escreveriam o mesmo arquivo e o programa criaria conflitos
  ("arquivo (cópia de PC).zip"). Por isso cada instalação escreve **só na própria subpasta**.
- **Sobrescrever o pacote da instalação** (`pc.zip`). Apaga o histórico e mistura a versão nova com a cópia em trânsito
  da antiga. Daí: **pacotes imutáveis e numerados**; o mais novo é indicado por um `manifest.json` da instalação.
- **O programa de sincronização apaga também.** O Syncthing replica exclusões: um pacote apagado numa máquina some das
  outras. Daí: versionamento de arquivos ligado na pasta (o Syncthing tem, por pasta), pelo menos na VPS.
- **Máquina desligada por dias.** Se os pacotes fossem incrementais, ela precisaria de todos os intermediários. Daí:
  **cada pacote é uma fotografia completa**; quem volta importa só o mais novo de cada instalação.
- **Duas importações ao mesmo tempo** (a automática e um `newclaw import` à mão, ou duas rodadas). Daí: uma trava por
  instalação, valendo para os dois caminhos.
- **Arquivo pela metade.** O programa pode copiar um pacote enquanto ele é escrito, ou entregar uma cópia parcial.
  Daí: escrever com outro nome e renomear no fim; na importação, conferir o pacote e ignorar o que não fecha.
- **Importar o próprio pacote, ou importar sempre o mesmo.** Seria trabalho à toa, e cada importação ainda gera um
  pacote de segurança. Daí: nunca o próprio; só pacote mais novo que o último importado daquela instalação; e o pacote
  de segurança só quando algo vai entrar, com retenção.
- **Memória pessoal na nuvem de terceiros.** Com OneDrive ou Drive, os pacotes ficam no provedor. O Syncthing não
  passa por nuvem. A ADR-020 deixou a cifra com senha como pendência; ela volta aqui como opção.
- **Edição e exclusão.** A importação nunca altera nem apaga nada local. Então uma memória corrigida numa máquina fica
  com a versão antiga nas outras, e uma apagada continua nas outras. Resolver isso automaticamente é o passo mais
  arriscado, porque pode apagar o que a pessoa quer manter. Fica fora da 1ª versão, como etapa própria (abaixo).
- **Skill de uma máquina ativa noutra.** Uma skill aprendida na VPS com comandos de Linux, ativa no Windows, ensina o
  agente a errar. Mas exigir aprovação de toda skill importada criaria duas regras para a mesma coisa: desde a ADR-017,
  a skill aprendida localmente já nasce ativa (`APRENDIZADO_DE_SKILLS=automatico`, o padrão), com aviso e desfazer
  (`/skill_desativar`). A importada, aprendida e validada da mesma forma noutra instalação, segue **a mesma
  configuração**, com uma proteção a mais: caminho de outro sistema vai sempre para revisão (ADR-020). Como uma skill
  declara a própria origem e escreve caminhos portáveis (cabeçalho e marcadores) fica na ADR-035; a importação desta
  ADR lê esse cabeçalho quando ele existe e, sem ele, usa o detector de caminhos.

## Fase 3 — Alternativas

| # | Alternativa | Vantagem | Desvantagem |
|---|---|---|---|
| A | Memória central (Mem0, Zengram) | Tempo real | Servidor, PostgreSQL ou Docker, uma segunda memória disputando com a do Kernel (duas fontes de verdade); sem rede, sem memória. Zengram: 64★, 5 contribuidores (GitHub, 31/10/2026). |
| B | Sincronizar o banco | Nada a construir | Corrompe (Fase 1) |
| C | Servidor de sincronização próprio no NewClaw (HTTP entre instalações) | Sem programa externo | Rede, autenticação entre máquinas e portas abertas: um sincronizador novo para manter |
| D | **Pacote por instalação numa pasta sincronizada por um programa externo** | Reaproveita a ADR-020 inteira; sem servidor; funciona offline; qualquer programa serve | Cópia completa a cada vez; edição e exclusão não propagam (1ª versão) |

**Escolhida: D.** A fica registrada como evolução possível, se D não bastar.

## Fase 4 — Decisão (proposta)

### 1. Divisão de responsabilidades

| Quem | Faz |
|---|---|
| **NewClaw (Sync Agent, módulo do núcleo)** | Exporta o próprio pacote para a pasta, de tempos em tempos; confere e importa os pacotes das outras; mostra o estado no painel |
| **Programa da pessoa** | Replica a pasta entre as máquinas. O NewClaw não sabe qual é. |

**Programa recomendado para a operadora: Syncthing** (MPL-2.0). Roda igual no Windows, no notebook e na VPS Linux, e
não passa por nuvem. OneDrive e Google Drive (no modo espelhar) servem no Windows; na VPS precisariam de um cliente à
parte (rclone). O SyncBackFree copia entre pastas locais e de rede, mas não fala com a nuvem sozinho (isso é do
SyncBackPro).

### 2. Configuração (tela "Sincronização de Conhecimento"; desligada por padrão)

- **Pasta de sincronização:** caminho local, conferido ao salvar (existe e aceita escrita).
- **Nome desta instalação:** escolhido pela pessoa ("PC", "Notebook", "VPS"); vai no nome da subpasta. Junto, um UUID
  gerado uma vez e guardado em `data/`, para dois nomes iguais não se confundirem. Não usa nome de máquina nem de usuário.
- **Intervalo:** padrão 30 min (exportar e procurar novidades).
- **O que vai no pacote:** memória, skills aprendidas e skills em arquivo. Conversas e workspace ficam fora por padrão
  (são grandes e pessoais); a pessoa pode ligar.

### 3. A pasta

```
NewClaw-Sync/                         <- sincronizada pelo programa (versionamento ligado)
├── pc-3f9a1c2e/
│   ├── manifest.json                 <- só esta instalação escreve aqui
│   ├── 000041.zip
│   └── 000042.zip
├── notebook-8b21d0aa/
└── vps-c47e9910/
```

- **Subpasta:** `<nome>-<id8>`. O nome é escolhido pela pessoa; o id é um UUID gerado uma vez e guardado em `data/`.
- **`manifest.json` da instalação:** id, nome, sistema, versão do app e do esquema, e a lista dos pacotes com número,
  hora, tamanho, **SHA-256 do arquivo** e as contagens (memórias compartilhadas, skills). O SHA vai aqui, fora do zip,
  porque um arquivo não carrega o próprio resumo.
- **Cursores:** o `manifest.json` de cada instalação também diz o último pacote que ela importou de cada uma das
  outras (`importados: { "<id>": 42 }`). É assim que uma máquina sabe, sem consultar a outra, o que já chegou lá.
- **Retenção:** a instalação apaga só os próprios pacotes, e só os que todas as instalações conhecidas já passaram
  (número menor que o menor cursor delas), mantendo sempre os 5 mais novos. Instalação que não publicou cursor, ou
  cursor ilegível, conta como "não recebeu": na dúvida, o pacote fica. Como cada pacote é uma fotografia completa,
  quem volta precisa só do mais novo; a regra garante que o último confirmado por cada uma continue lá enquanto o
  mais novo ainda está em trânsito. O versionamento do programa é uma proteção a mais, não a única: o backup do banco
  do próprio NewClaw (ADR-020) continua independente.

### 4. Exportar

- Só quando o conhecimento compartilhável mudou desde o último pacote (resumo das tabelas e de `skills/`).
- **Ordem da publicação** (o manifesto nunca anuncia um pacote inacabado):
  1. `criarPacote` para `.000043.zip.parcial`, na própria subpasta;
  2. arquivo fechado, calcula o SHA-256 e o tamanho;
  3. renomeia para `000043.zip`;
  4. reescreve o `manifest.json` por arquivo temporário e renomeação.
- Cada pacote é uma **fotografia completa**, não um incremento.
- Memórias marcadas "só desta máquina" (D1) não entram.

### 5. Importar (uma importação por vez por instalação)

Sob a trava `data/sync.lock`, que o `newclaw import` à mão também respeita, para cada subpasta de outra instalação:
1. lê o `manifest.json`; o número mais novo é o único que interessa (fotografia completa);
2. se o número não for maior que o último importado daquela instalação (guardado em `data/`), não há nada a fazer;
3. confere o arquivo: existe, tem o tamanho e o **SHA-256** do manifesto, e `lerPacote` o aceita (nomes seguros,
   sem `../`, banco SQLite válido, esquema não mais novo que o local). Se o programa ainda não terminou de copiar
   (manifesto chegou antes do zip, ou zip pela metade), fica para a próxima rodada, sem erro alto;
4. confere a **origem**: o id do `manifest.json` bate com o da subpasta, e o manifesto interno do zip traz o mesmo id e
   o mesmo número. Divergência é erro na tela, e o pacote não entra.

   O SHA-256 detecta corrupção, não prova autoria. Na V1, quem pode escrever na pasta é só quem foi pareado no
   Syncthing (as três máquinas da operadora): essa é a fronteira de confiança. Assinatura dos pacotes fica para quando a
   pasta passar por terceiros (mesma etapa da cifra);
5. `importarPacote`, com as mudanças desta ADR:
   - o pacote de segurança só é gerado se algo vai entrar, e fica com retenção (os últimos 10);
   - **skills que chegam seguem a regra de ativação desta instalação (ADR-017):**

     | `APRENDIZADO_DE_SKILLS` aqui | Skill ativa na origem, sem caminho de outro sistema | Com caminho de outro sistema |
     |---|---|---|
     | `automatico` (padrão) | entra **ativa**, com aviso no painel e no canal ("chegou do PC: X; `/skill_desativar X` desfaz") | entra **proposta** (`SKILL.md.revisar`) |
     | `proposta` | entra **proposta** | entra **proposta** |
     | `desligado` | entra **proposta** (quem desliga o aprendizado não ganha skills ativas por outra via) | entra **proposta** |

     Skill proposta, recusada ou desativada na origem chega **proposta**, nunca ativa. Toda skill importada leva a
     coluna nova `origem_instalacao`, para o aviso, a tela e o desfazer dizerem de onde veio. O agente só carrega
     `SKILL.md` (`SkillLoader`): uma proposta não age até ser aprovada;
   - **o estado da skill local nunca muda numa importação:** `INSERT OR IGNORE` mantém o que já existe, então uma
     recusada continua recusada e uma pendente continua pendente;
   - **a limpeza automática do `SkillLearner` deixa as importadas propostas em paz.** Hoje ela apaga propostas cujo
     padrão já está ativo (`cleanupDuplicateKnownPatternProposals`); passa a ignorar linhas com `origem_instalacao`;
6. registra o relatório (o que entrou, o que já existia, o que está para revisar, erros) e atualiza o cursor no
   próprio `manifest.json`.

**A trava `data/sync.lock`:**
- aquisição atômica: criação exclusiva do arquivo (`wx`), com o pid e a hora dentro;
- uma segunda importação, automática ou manual, recebe "já há uma sincronização em andamento" e não espera às cegas;
- liberada num `finally`, também em erro;
- trava abandonada (processo que morreu): se o pid não existe mais, ela é retomada; se o pid existe, ela fica;
- usada pelo agente automático, pelo `newclaw import`, pela importação do painel e pelo backup e restauração do
  conhecimento (ADR-020), para nenhum deles concorrer com outro sobre o banco.

**Falha no meio da importação:** a memória entra numa transação do SQLite (já é assim na ADR-020); um erro desfaz a
parte do banco. Os arquivos de skills que já tinham sido escritos ficam com o sufixo de revisão, e o pacote de segurança
do passo 5 permite voltar ao estado anterior por inteiro. O cursor só avança no fim, então a próxima rodada tenta de
novo.

**Idempotência:** importar o mesmo pacote dez vezes dá o mesmo resultado que uma vez. Memória e arestas já são assim
(id e nome+conteúdo); as skills também (`INSERT OR IGNORE`; arquivo igual é ignorado). Um pacote que traz de volta o que
esta instalação mandou não duplica nada.

### 6. Tela "Sincronização de Conhecimento" (painel; 3 línguas)

- Esta instalação: ligada ou desligada, a pasta, o último pacote publicado, as memórias compartilhadas e as marcadas
  "só desta máquina".
- Uma linha por instalação vista na pasta (PC, notebook, VPS): último pacote dela, quando foi importado aqui, o que
  entrou, as memórias que ela compartilha (do manifesto), as **skills que chegaram dela** (ativas, com desativar, e as
  pendentes, com aprovar e recusar) e os **erros** (pacote
  com SHA errado, versão de esquema mais nova, pasta sem escrita).
- Botão "sincronizar agora"; aprovar, recusar e desativar reaproveitam o painel de skills que já existe.

O que a tela mostra sobre as outras máquinas é o que os manifestos delas dizem; uma máquina não consulta a outra.

### 7. Fases

| Versão | Entrega |
|---|---|
| **V1 (esta ADR)** | Compartilhar memórias novas e skills (pela regra da ADR-017); tela de sincronização |
| V2 | Edição: quando a mesma memória foi corrigida em duas máquinas, resolver o conflito. Exige a origem e a hora de cada mudança, para não trocar uma correção local por uma versão antiga |
| V3 | Exclusão: as outras recebem uma **sugestão de remoção**, nunca a remoção; confirmação pela ADR-028 e histórico de auditoria |
| Depois | Cifra do pacote com senha, se a pasta passar por nuvem de terceiros |

## Decisões da operadora (31/10/2026)

| # | Decisão |
|---|---|
| D1 | **Dois níveis:** "compartilhar" (padrão) e "só desta máquina". O que a importação já trata como local continua automático (identidade, estrutura, caminhos de outro sistema, perfil dos juízes, `.env`). |
| D2 | **Skill importada segue a regra local de ativação (ADR-017):** no padrão `automatico`, entra ativa com aviso e desfazer; com caminho de outro sistema, ou com `proposta`/`desligado`, espera aprovação. (Revisão 4: a operadora lembrou que a aprovação manual já não é a regra local.) |
| D3 | **Syncthing**, com versionamento de arquivos ligado na pasta, pelo menos na VPS. |
| — | Sync Agent **interno**, sem dependência externa obrigatória; SQLite continua a fonte de verdade local; transporte por **zips imutáveis**; Zengram e Mem0 não entram agora. |

## Fase 5 — Validação

| Pergunta | Resposta |
|---|---|
| Baseada em evidência? | Sim: a importação mesclando já foi provada com dados reais (ADR-020). |
| Estrutural? | Sim: tira da pessoa a tarefa de levar arquivos, sem mudar o formato nem a mesclagem. |
| Reduz complexidade? | Acrescenta um módulo pequeno; não cria serviço, banco nem dependência. |
| Fontes de verdade? | Uma por instalação, como hoje; a pasta só transporta cópias. |
| Incremental e reversível? | Desligada por padrão; desligar volta ao manual; cada importação tem pacote de segurança. |

## Plano (depois da aprovação)

| Etapa | Entrega | Teste |
|---|---|---|
| 1 | Configuração, UUID e nome; pasta e manifesto (SHA-256, cursores); publicação na ordem da seção 4; retenção pelos cursores | Arquivo parcial nunca aparece com o nome final; manifesto nunca aponta para zip inacabado; sem mudança, sem pacote novo; retenção não apaga o último confirmado por cada uma |
| 2 | Importar: trava, só o mais novo, SHA e origem conferidos, pacote incompleto adiado, segurança só se algo entra, cursor no fim | Ver os testes de aceitação |
| 3 | "Só desta máquina" (D1); skills pela regra da ADR-017 (D2), aviso, `origem_instalacao` e a limpeza que respeita as propostas importadas | Ver os testes de aceitação |
| 4 | Tela "Sincronização de Conhecimento" | — |
| 5 | Prova real: PC, notebook e VPS com Syncthing | Ver os testes de aceitação |

**Testes de aceitação** (o Sync Agent só está pronto com todos passando; os de 1 a 3 e o 12 também na prova real):

| # | Caso | Como |
|---|---|---|
| 1 | PC publica e o notebook importa | Pastas simuladas + prova real |
| 2 | Notebook publica e a VPS importa | Pastas simuladas + prova real |
| 3 | VPS publica e o PC importa | Pastas simuladas + prova real |
| 4 | Máquina desligada por vários pacotes recupera tudo com o mais novo | Pastas simuladas |
| 5 | Pacote incompleto (manifesto antes do zip; zip cortado) não é importado e entra na rodada seguinte | Regressão |
| 6 | Hash errado e origem divergente são rejeitados, com o erro na tela | Regressão |
| 7 | O mesmo pacote importado 10 vezes = 1 vez | Regressão (contagens iguais) |
| 8 | Importação automática e manual nunca simultâneas; trava abandonada é retomada | Regressão com dois processos |
| 9 | Skill importada segue `APRENDIZADO_DE_SKILLS` (os três valores); com caminho de outro sistema, fica proposta; proposta não age e não é apagada pela limpeza; `/skill_desativar` desfaz uma importada; reimportar não reativa o que foi desativado aqui | Regressão (`SkillLoader`, `SkillLearner`) |
| 10 | Falha no meio da importação: banco intacto, cursor não avança, a rodada seguinte completa | Regressão com falha injetada |
| 11 | O pacote de segurança anterior à importação restaura o estado | Regressão (restaurar e comparar) |
| 12 | Pasta indisponível (desmontada, sem permissão): as três instalações seguem funcionando, só a tela avisa | Regressão + prova real |
