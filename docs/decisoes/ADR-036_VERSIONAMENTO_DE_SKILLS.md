# ADR-036 — Versionamento de skills: oficiais, aprendidas e promovidas

Data: 31/10/2026. Status: **aceita em 31/10/2026, revisão 3** (revisão 3: as decisões D1–D5 e o mecanismo A foram
confirmados pela operadora, que determinou seguir o parecer de 31/10/2026; a implementação segue a sequência da seção
"Decisões", em commits pequenos e independentes. Revisão 2: incorporou o parecer — procedência na promoção, original
mantido após a promoção, backup para reconstrução, testes de integridade, tabela de responsabilidades e princípio a
preservar). Seguem abertos o destino do `skills-lock.json` e a avaliação da alternativa B.

Relacionadas: `docs/ARCHITECTURE/SEPARACAO_DISTRIBUIDO_APRENDIDO.md` (a norma que esta ADR aplica às skills),
ADR-017 (skills aprendidas com o que funcionou), ADR-020 (backup do conhecimento), ADR-034 (Sync Agent) e
ADR-035 (skills portáveis), ADR-031 (experiências opcionais não impõem dependências ao núcleo),
`REUTILIZACAO_ANTES_DA_CRIACAO.md`, `NUNCA_ADIVINHAR.md`.

## Fase 1 — Compreensão

### O problema

Uma skill aprendida pelo NewClaw (ADR-017) apareceu como arquivo novo, não rastreado, na árvore de trabalho do
repositório. A pergunta da operadora: skill aprendida é código-fonte versionado, ou memória operacional do agente?

### O que já está decidido (não é decisão nova)

`SEPARACAO_DISTRIBUIDO_APRENDIDO.md` já responde a pergunta em princípio:

- Conhecimento **distribuído** vive no código-fonte, passa por PR e é igual em toda instalação (seção 3).
- Conhecimento **aprendido** vive no armazenamento local da instância e muda em runtime (seção 3).
- Um componente **não deve** promover sozinho o aprendido ao distribuído; a travessia exige decisão humana por PR
  (seções 4 e 6). Uma categoria híbrida só é permitida como decisão nomeada e documentada (seção 4).

### O que foi medido (31/10/2026)

| Fato | Evidência |
|---|---|
| O `SkillLearner` grava o `SKILL.md` aprendido em `./skills` (`exportSkillFile`, `SkillLearner.ts:204-206, 526`) | código |
| O `SkillLoader` lê a mesma pasta `./skills` (`SkillLoader.ts:39`) | código |
| A pasta é configurável: o backup a resolve por `SKILLS_DIR`, com `./skills` como padrão (`backupDoConhecimento.ts:61`) | código |
| A linha de `auto_skills` guarda o conteúdo completo da skill (`prompt`, `trigger`, `tool_sequence`, `created_at`, `reviewed_at`), então o `SKILL.md` é reconstruível a partir do banco; não há coluna de instância, de versão revisada nem de autor da aprovação | interface `Skill`, `SkillLearner.ts` |
| O pacote do ADR-020 leva o banco inteiro e os arquivos de `skills/` (`backupDoConhecimento.ts:4-5, 122-123`) | código |
| É a mesma pasta em que o repositório versiona as skills oficiais: 11 hoje (`audio_request`, `content-validator`, `dependency-curator`, `event_interaction_pattern`, `html-pdf-converter`, `interface-de-voz`, `memory_write`, `pptx-generator`, `skill-auditor`, `skill-manager`, `system-provisioner`) | `git ls-files skills` |
| Nenhuma skill `aprendida_*` está versionada | `git ls-files skills` |
| Nenhuma regra de ignore cobre `skills/aprendida_*` | `git check-ignore` sem resultado |
| A instalação de produção do Windows tem 12 pastas `aprendida_*` em `skills/` | listagem da pasta |
| A skill que sobrou na árvore de trabalho foi aprendida em 23/10/2026, ao rodar uma instância a partir da pasta do repositório | cabeçalho do próprio arquivo |
| O arquivo tem caracteres corrompidos na linha de origem e os blocos de código sem as cercas de Markdown | leitura do arquivo; causa **não investigada**, fora do escopo desta ADR |

Leitura: a fonte de verdade da skill aprendida já é a linha em `auto_skills` no SQLite da instância (ADR-017); o
`SKILL.md` é uma cópia derivada, exportada para uma pasta que o git também enxerga. A mistura física que a norma
proíbe acontece por acidente de caminho, não por decisão.

### O AgentVault

O pedido original citava o AgentVault como local inicial das skills aprendidas. O pacote de ADRs do AgentVault
(fora deste repositório) mostra que ele é uma **plataforma de backup e sincronização** para dados de agentes de IA,
em Rust, com criptografia no cliente. Todas as 23 ADRs dele estão em `Proposed`, o projeto foi adiado e o próprio
pacote diz que a análise do NewClaw como primeiro adaptador **não foi feita**. Não existe, portanto, um AgentVault
onde guardar skills hoje, e o ADR-009 dele separa Backup de Sync de Restore: ele seria **destino de cópia**, não a
casa da skill em uso. O NewClaw já tem esse papel coberto localmente: o pacote do ADR-020 inclui `skills/**`.

## Fase 2 — Crítica (motivos para NÃO decidir assim)

| Risco | Tratamento |
|---|---|
| Depender de um produto que não existe para a skill aprendida funcionar | A política não depende do AgentVault. Ele aparece só como destino futuro de backup (ADR-031: o núcleo não depende da experiência opcional). |
| Criar uma terceira categoria "híbrida" sem nome | Fica explícito abaixo: a skill aprendida é **aprendida** (local), a oficial é **distribuída** (git); a promovida é uma oficial nova. Não há híbrida. |
| Promoção automática de skill aprendida | Proibida pela norma (seção 6). A promoção é PR. |
| Skill aprendida carrega caminho de máquina e dado pessoal para o GitHub | É o motivo central para não versionar: o ADR-035 mediu 9 de 33 skills com caminho de sistema no corpo. |
| Prefixo `aprendida_` como único critério de separação é frágil | Reconhecido na alternativa A; é o motivo de a alternativa B existir. |
| Skill criada pelo agente a pedido da operadora (como `gmail-himalaya`, ADR-017) não leva o prefixo | Não é aprendida pelo `SkillLearner`; entra pelo caminho de oficial (PR), como já entrou. |

## Fase 3 — Alternativas

- **A. Regra de ignore para `skills/aprendida_*/`.** Uma linha em `.gitignore`. Reaproveita o nome que o `SkillLearner` já
  gera. Não muda o `SkillLoader`, o `SkillLearner`, o pacote do ADR-020 nem o painel. Fraqueza: depende da convenção do
  prefixo.
- **B. Pasta separada para as aprendidas** (por exemplo, na pasta de dados da instalação), com o `SkillLoader` lendo duas
  raízes. Elimina a classe de erro, mas muda o `SkillLearner`, o `SkillLoader`, o pacote do ADR-020, o Sync do ADR-034 e o
  painel, e exige migrar as pastas existentes.
- **C. Só disciplina**, sem regra. Descartada: o erro já aconteceu.
- **D. Guardar as aprendidas no AgentVault.** Descartada agora: o produto não existe (Fase 1).

## Fase 4 — Síntese (recomendação)

Três classes, aplicando a norma existente às skills:

1. **Oficial.** Pasta `skills/<nome>/`, versionada no git, entra e muda só por PR. Nome sem o prefixo `aprendida_`.
2. **Aprendida.** Nasce do `SkillLearner` (ADR-017). Fonte de verdade: a linha em `auto_skills` da instância; o
   `SKILL.md` é cópia derivada. **Nunca vai ao git.** Viaja entre instalações pelo pacote (ADR-020) e pelo Sync
   (ADR-034/035), nunca pelo repositório. Um backup externo, como o AgentVault no futuro, entra como destino de
   cópia, sem ser requisito.
3. **Promovida.** Uma aprendida que uma pessoa revisou e decidiu que generaliza. Vira uma oficial **nova**, por PR:
   copiar, renomear sem o prefixo, retirar caminhos de máquina e dados pessoais (marcadores do ADR-035), registrar no PR
   a origem. É a "exceção — travessia" da seção 6 da norma; continua sem caminho automático.

**Princípio a preservar:** *o agente pode aprender autonomamente, mas não pode transformar automaticamente tudo o que
aprende em parte do produto distribuído.* Vale mais ainda com várias instâncias, cada uma com a sua experiência.

### Quem é responsável por quê

Backup não é sincronização, e sincronização não é distribuição de código. Cada mecanismo tem uma responsabilidade só:

| Mecanismo | Responsabilidade |
|---|---|
| Git | Distribuir o código e as skills oficiais |
| SQLite da instância | Manter o conhecimento aprendido, inclusive as skills aprendidas (fonte de verdade) |
| Backup local (ADR-020) | Recuperar a instância: o banco inteiro e os arquivos de `skills/` |
| Sync (ADR-034) | Levar conhecimento aprendido de uma instalação a outra |
| AgentVault (futuro, fora deste repositório) | Proteger e sincronizar dados entre instâncias, como destino de cópia; **nunca** gerenciar código ou implantar skills |

O NewClaw continua funcionando sem o AgentVault (ADR-031).

### Procedência da promoção

A promoção (classe 3) deve preservar a procedência. As quatro perguntas, com o que existe hoje:

| Pergunta | Hoje | Como fica |
|---|---|---|
| Qual instância aprendeu? | **Não registrado.** O cabeçalho do arquivo traz só a plataforma (por exemplo `win32`); a tabela não tem coluna de instância. | O registro de promoção diz "não registrado" enquanto não houver identidade de instalação (a ADR-034 a prevê; a ADR-035 propõe `sistema_origem`, que é o sistema, não a instância). Nunca se preenche por palpite (`NUNCA_ADIVINHAR`). |
| Quando foi criada? | `created_at` na tabela e a data no cabeçalho do arquivo. | Copiada para o registro. |
| Qual versão foi revisada? | **Não registrado.** `updated_at` não identifica o conteúdo revisado. | Resumo (hash) do corpo normalizado, calculado no momento da revisão; é a mesma ideia do `validada_em` da ADR-035. |
| Quem aprovou a promoção? | `reviewed_at` registra a ativação na instância, sem autor. | O PR de promoção: autor, revisor e data. |

O **registro de procedência** vai na descrição do PR de promoção, e o corpo da skill oficial recebe uma nota de origem em
texto (o mesmo recurso que o `SkillLearner` já usa na linha "Aprendida automaticamente..."). Campo sem dado é escrito
"não registrado".

### Depois da promoção

A skill aprendida **não é apagada nem desativada automaticamente**. Permanece na instância até uma decisão explícita de
limpeza, para não perder histórico e permitir recuperação. O risco de duas skills com os mesmos gatilhos concorrendo
fica registrado e é tratado por essa decisão de limpeza, não por automação.

### Backup e reconstrução

O banco continua sendo a fonte de verdade. O backup deve permitir reconstruir a skill aprendida: hoje o pacote leva o
banco inteiro e os arquivos de `skills/`, e a linha `auto_skills` tem o conteúdo completo. Falta apenas **provar** isso
(ver critérios de validação), não criar mecanismo novo.

**Mecanismo: alternativa A agora** (incremental e reversível, uma linha), mais testes de regressão determinísticos
(abaixo). A **B fica registrada como evolução**, a decidir se o Sync do ADR-034 ou o AgentVault exigirem uma separação
física. Observação: como `SKILLS_DIR` já existe, uma instância isolada pode apontar para outra pasta, mas isso esconderia
também as skills oficiais, por isso não substitui a B.

Limitações que permanecem: o prefixo é convenção; a classe "promovida" não tem ainda uma marca no cabeçalho (isso é
assunto do cabeçalho da ADR-035, que também aguarda aprovação); o `skills-lock.json` é outro assunto (ver "Pendências").

## Fase 5 — Validação

- Baseada em evidência do projeto, não só em hipótese: sim (tabela da Fase 1).
- Estrutural ou sintoma: o sintoma (arquivo solto) tem causa estrutural (mesma pasta para duas categorias); A trata a
  parte de versionamento, B trataria a causa inteira.
- Reduz a complexidade: sim, não cria componente novo (ARCH-REUSE-001). Elimina duas fontes de verdade? A fonte já é
  única (`auto_skills`); a regra só impede que o arquivo derivado passe por fonte.
- Incremental e reversível: sim, apagar a linha de ignore desfaz.
- Critérios objetivos de sucesso (testes de regressão, estendendo os existentes em vez de criar um novo conjunto,
  conforme ARCH-REUSE-001: `S393_SkillsAprendidas_ComOQueFuncionou` e `S391_SkillLoader_BomFrontmatter`):
  1. **Versionamento:** nenhuma `skills/aprendida_*` está rastreada pelo git (`git ls-files`).
  2. **Aprendizado preservado:** o `SkillLoader` continua carregando normalmente uma skill aprendida exportada pelo
     `SkillLearner` em pasta temporária. Não queremos corrigir o versionamento e quebrar o aprendizado.
  3. **Reconstrução:** a partir de um pacote do ADR-020, numa instalação limpa, a skill aprendida volta a ser carregada
     (banco e arquivos presentes).
  4. Aprovar uma skill aprendida numa instância rodando a partir da pasta do repositório deixa `git status` limpo.

## Decisões

Resolução do parecer de 31/10/2026, **confirmada pela operadora** em 31/10/2026.

| # | Ponto | Resolução |
|---|---|---|
| D1 | AgentVault | Destino futuro de backup e sincronização, não o armazenamento atual. O NewClaw funciona sem ele (ADR-031). |
| D2 | Armazenamento | SQLite é a fonte de verdade das skills aprendidas. O backup deve conter também o necessário para reconstruí-las; provado pelo critério 3 da Fase 5. |
| D3 | Promoção | Preserva a procedência: instância, data de criação, versão revisada e quem aprovou, conforme a tabela da Fase 4. Campo sem dado: "não registrado". |
| D4 | Depois da promoção | A aprendida não é apagada nem desativada automaticamente; fica até uma decisão explícita de limpeza. |
| D5 | Integridade | Dois testes obrigatórios: nenhuma `skills/aprendida_*` rastreada pelo git, e o `SkillLoader` carregando skills aprendidas normalmente (mais a reconstrução a partir do pacote). |

**Procedência: sem novas colunas agora.** Primeiro se define o contrato de procedência (os quatro campos acima e a regra
"não registrado"); só depois se avalia como implementá-lo, inclusive se exige colunas em `auto_skills`.

### Verificação prévia ao `.gitignore` (31/10/2026)

A regra de ignore não remove o que já é versionado, então se conferiu antes: nenhuma `skills/aprendida*` está no índice
nem aparece em qualquer ramo do histórico (`git log --all`). Não há `git rm` a fazer.

### Pendências

- **Mecanismo de separação.** Confirmado: `.gitignore` agora (alternativa A), armazenamento separado (B) só depois.
- **`skills-lock.json`.** Registra a skill `security-audit`, que vive em `.claude/skills` (ferramental do Claude Code, não
  skill do NewClaw), pasta que o `.gitignore` já ignora. Recomendação anterior: não versionar e incluí-lo no `.gitignore`.
  Continua aberto.
- **A skill aprendida solta na árvore de trabalho** (`executar-script-node-windows`): permanece onde está, sem commit.
  Deve ser investigada depois do `.gitignore` e dos testes, inclusive a codificação dos caracteres e a formatação dos
  blocos de código.

### Sequência de trabalho

Sem implementar tudo de uma vez, e só depois da confirmação:

1. Revisar e consolidar esta ADR (esta revisão).
2. Confirmar D1–D5 e as pendências acima.
3. Implementar a regra de ignore (alternativa A).
4. Criar os testes de regressão (Fase 5).
5. Investigar a skill aprendida solta.
6. Só então avaliar a evolução para armazenamento separado (B).
