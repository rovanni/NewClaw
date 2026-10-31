# ADR-034 — NewClaw Sync Agent: o conhecimento entre instalações por uma pasta sincronizada

Data: 31/10/2026. Status: **proposta**. Nada será implementado antes da aprovação da operadora.

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
  ("arquivo (cópia de PC).zip"). Por isso cada instalação escreve **só o próprio arquivo**.
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
  agente a errar. Caminhos de outro sistema já vão para revisão (ADR-020); uma skill nova sem caminho entra ativa. Isso
  é uma decisão da operadora (D2).

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

### 2. Configuração (painel → Backup → "Sincronizar entre instalações"; desligada por padrão)

- **Pasta de sincronização:** caminho local, conferido ao salvar (existe e aceita escrita).
- **Nome desta instalação:** escolhido pela pessoa ("PC", "Notebook", "VPS"); vai no nome do arquivo. Junto, um id
  gerado uma vez e guardado em `data/`, para dois nomes iguais não se confundirem. Não usa nome de máquina nem de usuário.
- **Intervalo:** padrão 30 min (exportar e procurar novidades).
- **O que vai no pacote:** memória, skills aprendidas e skills em arquivo. Conversas e workspace ficam fora por padrão
  (são grandes e pessoais); a pessoa pode ligar.

### 3. Exportar

- Só quando o conhecimento mudou desde o último pacote: comparação de um resumo das tabelas e de `skills/`.
- `criarPacote` num arquivo temporário da pasta (`.<nome>.parcial`), depois renomeado para
  `<nome>-<id8>.newclaw-sync.zip`.
- O manifesto ganha o id e o nome da instalação, a hora e o resumo (sha256) do conteúdo.

### 4. Importar

Para cada `*.newclaw-sync.zip` da pasta:
1. ignora o desta instalação;
2. ignora se a hora do manifesto não for mais nova que a do último importado daquela instalação (guardado em `data/`);
3. confere o zip e o manifesto (`lerPacote`); um pacote incompleto fica para a próxima rodada, sem erro alto;
4. `importarPacote`. O pacote de segurança só é gerado se a contagem prévia indicar que algo vai entrar, e fica com
   retenção (os últimos 10);
5. registra o relatório (o que entrou, o que já existia, o que foi para revisão).

Importar um pacote que traz de volta o que esta instalação mandou não duplica nada: o id já existe.

### 5. Painel

Cartão com: ligado ou desligado, a pasta, a última exportação, e cada outra instalação vista (nome, hora do último
pacote, o que entrou, o que está para revisar). Mais o botão "sincronizar agora".

### 6. Fora da 1ª versão (etapas próprias, depois de medir)

- **Edição:** propagar a versão mais nova de uma memória. Exige a origem e a hora de cada mudança, para não trocar uma
  correção local por uma versão antiga.
- **Exclusão:** quando uma memória some de uma instalação, as outras recebem uma **sugestão de remoção**, nunca a
  remoção. A confirmação segue a ADR-028.
- **Cifra do pacote com senha:** necessária se a pasta passar por nuvem de terceiros.

## Decisões da operadora antes de implementar

| # | Pergunta | Recomendo |
|---|---|---|
| D1 | Classificação das memórias: três níveis (Global, Local, Privado) ou dois? | **Dois: "compartilhar" (padrão) e "só desta máquina".** Local e Privado têm o mesmo efeito na sincronização (não saem). O que a importação já trata como local continua automático: identidade, estrutura, caminhos de outro sistema, perfil dos juízes, `.env`. A pessoa marca "só desta máquina" pela conversa ou pelo painel. |
| D2 | Skill nova de outra instalação: entra ativa ou espera aprovação? | **Ativa se veio do mesmo sistema e não tem caminho de outro sistema; senão, espera aprovação.** É a regra da ADR-020, com a origem do sistema como critério a mais. |
| D3 | Programa de sincronização | **Syncthing** nas três (a VPS é Linux). OneDrive/Drive se preferir nuvem, com a cifra do pacote como etapa seguinte. |

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
| 1 | Configuração, id e nome; exportar com escrita atômica e "só se mudou" | Arquivo parcial nunca visível com o nome final; sem mudança, sem pacote novo |
| 2 | Importar: próprio ignorado, só mais novo, pacote incompleto adiado, segurança só se algo entra, retenção | Três instalações simuladas em pastas, ida e volta sem duplicar |
| 3 | "Só desta máquina" (D1) e regra das skills (D2) | O marcado não sai; skill de outro sistema espera aprovação |
| 4 | Cartão no painel (3 línguas) e "sincronizar agora" | — |
| 5 | Prova real: PC, notebook e VPS com o programa escolhido | Algo aprendido numa máquina aparece nas outras duas, sem duplicar; sem rede, nada quebra |
