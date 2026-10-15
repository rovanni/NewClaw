# ADR-020 — Backup e restauração do conhecimento (para qualquer usuário)

Status: **aceita** (14/10/2026, "Pode rodar as sprints"). **Sprint A implementada e validada** — `src/core/backupDoConhecimento.ts`,
rotas `/api/maintenance/backup/conhecimento[/inspecionar|/restaurar]`, cartão no painel (3 línguas), `newclaw backup` /
`newclaw restore <a.zip>`, `PRAGMA user_version` (`VERSAO_DO_ESQUEMA`), teste `S399`. Etapa 4: pacote dos dados reais da
instalação Windows (95 memórias, 20 skills, 154 conversas, sem `.env` nem `.hermes`) restaurado numa instalação vazia e
isolada — o boot aplicou o banco (esquema 0 → 1), a API listou as 20 skills e o banco tinha as 95 memórias; criação pelo
painel conferida no navegador. **Sprint B implementada e validada** — `importarPacote`, rota
`/api/maintenance/backup/conhecimento/importar`, ação "🔀 importar (mesclar)" no painel, `newclaw import <a.zip>`, teste
`S400`. Etapa 4: o conhecimento REAL da instalação Linux (107 memórias, 25 skills) importado numa cópia isolada da do
Windows (95 memórias, 21 skills) → 123 memórias e 34 skills; 60 memórias já existiam, 19 nós estruturais ignorados,
2 memórias com caminho do Linux ficaram para revisão, 107 arestas, `gmail-himalaya` e `gmail_access` diferentes →
a do Windows ficou ativa e a do Linux em `SKILL.md.importada`; o boot rodou sem erros, as 34 skills carregaram e a
busca por palavras achou a memória importada.
Origem: pergunta da mantenedora ao comparar Windows × Linux — *"tem um jeito de toda essa inteligência, toda essa
experiência salvar de alguma forma, fazer um backup, restaurar?"* — e a correção logo em seguida: *"o sistema é open
source; não é só para mim, é para qualquer usuário"*.

## Fase 1 — Compreensão

**Onde o conhecimento mora** (levantado no código, 14/10/2026):

| Conhecimento | Onde | Coberto hoje? |
|---|---|---|
| Memória (grafo: fatos, preferências), skills aprendidas (tabela), reflexões, casos, conhecimento operacional, conversas | `data/newclaw.db` (SQLite, WAL) | Sim — "backup do banco" (Online Backup API) |
| Configuração, chaves de API, cofre de senhas (ADR-019) | `.env` | Sim — "backup do sistema" (cópia do arquivo) |
| Skills em arquivo (`SKILL.md`): aprendidas (`aprendida_*`, ADR-017) e escritas à mão | `skills/` (`SKILLS_DIR`) | **Não** — e várias nem estão no git |
| Perfil medido dos juízes (ADR-016) | `data/validation-judge-profile.json` | **Não** |
| Transcrições das conversas | `data/sessions/` | **Não** |
| Arquivos de trabalho do usuário | `workspace/` | **Não** |

**O que existe e funciona.** `routes/maintenance.ts`: backup do banco pela Online Backup API (correto com WAL), backup
do `.env`, retenção, envio de arquivo (upload), restauração com validação do SQLite, cópia de segurança automática
antes de restaurar e aplicação por processo auxiliar após o reinício.

**Compatibilidade entre versões.** O esquema evolui só por acréscimo — 30 comandos idempotentes em `memorySchema.ts`
(`CREATE TABLE IF NOT EXISTS`, colunas novas): um banco antigo restaurado numa versão nova é completado no boot. Não há
`user_version`: um backup NOVO numa versão ANTIGA não é detectado.

**Lacunas.** Uma instalação do zero perde as skills em arquivo, o perfil dos juízes e o histórico; o backup são dois
arquivos soltos, sem descrição do conteúdo; não há caminho para levar o conhecimento de uma instalação para outra.

## Fase 2 — Crítica (motivos para NÃO fazer do jeito óbvio)

| Risco | Tratamento |
|---|---|
| Backup com senhas circulando (anexado num issue, nuvem, pen drive) | Segredos FORA por padrão (`.env`, `SEGREDO_*`, `workspace/.hermes`-like); incluir é opção explícita com aviso; opcional: cifrar o pacote com senha (como o Home Assistant) |
| Restaurar destrói o que existe | Cópia de segurança automática do estado atual antes de qualquer restauração (já existe para o banco — estender ao pacote) |
| Copiar o banco do Linux para o Windows apaga o que o Windows aprendeu | Restaurar ≠ importar: importação MESCLA (Sprint B), nunca sobrescreve |
| Skill de um sistema operacional usada no outro (caminhos, comandos) | Medido em 14/10/2026: 3 de 20 skills no Windows têm caminhos `C:\…` (entre elas `gmail-himalaya`, `content-validator`, `skill-manager`) e 4 de 95 memórias; no Linux, 3 de 25 skills com `/home/…`. O banco SQLite e o `.zip` são portáteis entre Windows, Linux e macOS; o que não é portátil é o CONTEÚDO com caminho. O manifesto registra o sistema de origem; restaurando em outro sistema, skills e memórias com caminho do sistema de origem (letra de unidade, `/home/`, `/Users/`) entram **marcadas para revisão**, não ativas às cegas. Os caminhos NÃO são reescritos automaticamente — seria adivinhar onde as coisas estão na outra máquina (Nunca Adivinhar) |
| Backup de versão nova numa versão antiga | Manifesto com versão do app e do esquema; recusar com mensagem clara em vez de corromper |
| Arquivo malicioso (zip com `../`, banco adulterado) | Extração só para pasta temporária, nomes normalizados (sem travessia de caminho), validação do SQLite antes de usar, tamanho máximo |
| Dados pessoais no código | Nada fixo: caminhos vêm da instalação; o manifesto não carrega nome de máquina nem usuário |

## Fase 3 — Alternativas

- **Só documentar "copie as pastas".** Rejeitada: o usuário leigo não sabe o que copiar nem com o NewClaw parado.
- **Dois botões soltos (o estado atual) + um terceiro para `skills/`.** Rejeitada: três arquivos sem relação entre si,
  fácil restaurar metade.
- **Pacote único com manifesto** (padrão do backup do Home Assistant: um arquivo, conteúdo descrito, parcial ou
  completo, senha opcional). **Escolhida.**
- **Sincronização contínua entre instalações.** Fora de escopo: conflitos permanentes, exige servidor; a importação
  manual mesclada resolve o caso real (duas máquinas) sem infraestrutura.

## Fase 4 — Proposta

**Formato** — um `.zip` (`newclaw-conhecimento-AAAA-MM-DD-HHMM.zip`):
- `manifesto.json`: versão do app, versão do esquema, data, sistema de origem (win32/linux/darwin), o que contém,
  contagens (nós de memória, skills, conversas) — sem nomes de máquina ou usuário;
- `data/newclaw.db` (Online Backup API), `data/validation-judge-profile.json`, `skills/**`;
- opcionais marcados na tela: `data/sessions/**`, `workspace/**`, `.env` (com aviso de segredos).

**Sprint A — backup e restauração completos (mesma instalação ou instalação nova).**
- Painel → Backup: "Salvar tudo o que o NewClaw aprendeu" e "Restaurar de um arquivo" (3 línguas, texto para leigo,
  mostrando o conteúdo do pacote antes de confirmar).
- Restaurar: valida manifesto e banco, faz cópia de segurança do estado atual, aplica após reinício (reaproveita o
  processo auxiliar existente), migra o esquema no boot.
- Esquema ganha `PRAGMA user_version` para detectar backup mais novo que o app.
- CLI equivalente (`newclaw backup` / `newclaw restore <arquivo>`) para quem usa servidor sem painel.

**Sprint B — importar mesclando (outra instalação).** Nada local é sobrescrito nem apagado; antes de importar, o estado
atual vira pacote de segurança.
- Skills em arquivo: ausente → entra (com caminho de outro sistema → `SKILL.md.revisar`); igual → ignorada; mesmo nome
  com conteúdo diferente → a local fica e a importada vai para `SKILL.md.importada`, para comparação.
- Memória (`memory_nodes`): entra o nó cujo id não existe E que não repete nome+conteúdo de um local. Ficam de fora os nós
  estruturais (identity, domain, `core_*`, `user_identity*`, `time_*` — cada instalação tem os seus). Preferência com o
  mesmo nome de uma local → a local vence (relatado). Conteúdo com caminho de outro sistema → entra com
  `lifecycle_state = 'REVISAR'`: guardado, mas FORA das buscas (as 17 consultas de recuperação só leem estado vazio ou
  `ACTIVE`) até alguém revisar. Colunas: só as que existem nos dois bancos (versões diferentes convivem).
- Arestas (`memory_edges`): entram as que ligam nós existentes depois da importação (`INSERT OR IGNORE` pela chave).
- Skills aprendidas (`auto_skills`): entram as de id ausente.
- Fica de fora: `.env` e cofre (configuração e segredos são de cada instalação) e o perfil dos juízes (mede os modelos
  DESTA instalação). Histórico e workspace: só arquivos ausentes.
- Índice de busca textual: `rebuildFtsIndex` ao final (o FTS não tem gatilhos — memorySchema.ts).
- Painel: ação "🔀 importar (mesclar)" ao lado de "restaurar", com o conteúdo mostrado antes; CLI `newclaw import <a.zip>`.
- Relatório ao final: o que entrou, o que já existia, o que ficou para revisar e os conflitos (a local venceu).

## Fase 5 — Validação (critérios)

- Teste: pacote → instalação vazia → mesmo conhecimento (contagens do manifesto batem); pacote com `../` recusado; banco
  corrompido recusado; backup de versão nova recusado com mensagem; segredos ausentes por padrão.
- Etapa 4 (real): backup no Windows, restauração numa instância isolada no Linux; importação mesclada entre as duas
  instalações da mantenedora, conferindo que nenhum conhecimento local foi perdido.

**Riscos que ficam.** Cifra do pacote depende de escolher biblioteca (sem dependência nativa nova); a mesclagem de
memória por "nome+conteúdo" pode deixar duplicatas parecidas — mitigado pelo `memory_admin duplicates` existente.
