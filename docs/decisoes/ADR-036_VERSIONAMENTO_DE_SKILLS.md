# ADR-036 — Versionamento de skills: oficiais, aprendidas e promovidas

Data: 31/10/2026. Status: **proposta**. Nada será implementado antes da aprovação da operadora.

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

**Mecanismo: alternativa A agora** (incremental e reversível, uma linha), mais um teste de regressão determinístico
("nenhum `skills/aprendida_*` está rastreado pelo git"). A **B fica registrada como evolução**, a decidir se o Sync do
ADR-034 ou o AgentVault exigirem uma separação física.

Limitações que permanecem: o prefixo é convenção; a classe "promovida" não tem ainda uma marca no cabeçalho (isso é
assunto do cabeçalho da ADR-035, que também aguarda aprovação); o `skills-lock.json` é outro assunto (ver D4).

## Fase 5 — Validação

- Baseada em evidência do projeto, não só em hipótese: sim (tabela da Fase 1).
- Estrutural ou sintoma: o sintoma (arquivo solto) tem causa estrutural (mesma pasta para duas categorias); A trata a
  parte de versionamento, B trataria a causa inteira.
- Reduz a complexidade: sim, não cria componente novo (ARCH-REUSE-001). Elimina duas fontes de verdade? A fonte já é
  única (`auto_skills`); a regra só impede que o arquivo derivado passe por fonte.
- Incremental e reversível: sim, apagar a linha de ignore desfaz.
- Critério objetivo de sucesso: aprovar uma skill aprendida numa instância rodando a partir da pasta do repositório
  deixa `git status` limpo; o teste de regressão acima passa.

## Decisões que cabem à operadora

- **D1. AgentVault.** Confirmar o entendimento: destino de backup futuro, fora do caminho crítico de uso das skills.
- **D2. Mecanismo.** A agora e B depois (recomendado), ou B já.
- **D3. Promoção.** Aprovar o roteiro da classe 3 (copiar, renomear, limpar, PR). E o que fazer com a aprendida original
  depois de promovida: manter ativa, desativar ou apagar (duas skills com os mesmos gatilhos podem concorrer).
- **D4. `skills-lock.json`.** Registra a skill `security-audit`, que vive em `.claude/skills` (ferramental do Claude Code,
  não skill do NewClaw) e a pasta `.claude/` já é ignorada pelo git. Recomendação: não versionar; incluir no `.gitignore`.
- **D5. A skill aprendida solta hoje na árvore de trabalho** (`executar-script-node-windows`): mantida onde está, não
  commitada, até a D2.
