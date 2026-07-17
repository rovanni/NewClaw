# 🔍 3 falhas de regressão na primeira validação Linux real (VPS) — nenhuma era bug de produto

## Contexto

Sprint `2026-07-S08` (ARCH-002, docs/MASTER_EXECUTION_PLAN.md) foi a primeira deste programa a
executar a etapa 4 (ambiente real) da Validação Progressiva de verdade — não só Windows local. A
suíte de regressão rodou numa VPS Ubuntu 24.04 real (isolada, sem tocar a instância de produção
que já rodava lá via PM2) e voltou **116/119**, com 3 falhas: `S112`, `S13`, `S37`.

Este documento existe porque a primeira análise (registrada inicialmente no card da Sprint) foi
rasa demais: concluiu "gap de ambiente pré-existente da VPS" sem investigar a causa raiz de cada
falha individualmente. Ao ser questionado se as falhas estavam sendo documentadas de verdade, a
investigação foi refeita — as 3 causas reais são bem mais específicas, e uma delas era um bug de
teste real (corrigido).

## Achado 1 — `S37_SendAudio_EdgeTtsPathResolution` — **falso positivo, causa: gap no meu setup**

**Sintoma:** `MP3 real gerado com sucesso via -m edge_tts` falhava (`fileExists: false, fileSize: 0`).

**Causa raiz:** o teste usa `process.env.WORKSPACE_DIR` (com fallback pra um path Windows,
`D:/IA/newclaw/workspace`, se a variável não estiver setada) para decidir onde escrever o MP3 de
teste. Minha primeira validação na VPS nunca setou `WORKSPACE_DIR` nem criou um `.env` — o teste
caiu no fallback Windows, que não faz sentido nenhum em Linux, e o MP3 nunca foi escrito no lugar
certo. **`edge-tts` funcionava perfeitamente o tempo todo** — o teste só procurava o arquivo no
lugar errado.

**Resolução:** rodando com `WORKSPACE_DIR=/home/venus/verify-arch002-v2/workspace` setado
explicitamente, **9/9 passou**. Nenhuma mudança de código necessária.

## Achado 2 — `S13_ExecCommand_ResolvePath_Redirect` — **majoritariamente o mesmo gap; 1 falha residual é fragilidade real do teste**

**Sintoma:** 3 dos 8 asserts falhavam, incluindo `spawn /bin/sh ENOENT`.

**Causa raiz (7 dos 8 asserts):** mesmo gap do Achado 1 — sem `WORKSPACE_DIR` setado, o `workspaceDir`
calculado pelo teste (`path.resolve(process.env.WORKSPACE_DIR!)`) não correspondia a nenhum
diretório real, e os comandos que dependiam dele falhavam de formas diferentes (incluindo o
`ENOENT` de spawn, provavelmente por um `cwd` inexistente passado ao `exec_command`).

**Resolução parcial:** com `WORKSPACE_DIR` setado, 7/8 passou.

**Causa raiz do assert residual (1 de 8) — fragilidade real, não corrigida:** o teste usa
`/home/venus/newclaw/workspace/sanitize_memory.py` como exemplo *fictício* de "path de outra
instalação" (para provar que `exec_command` redireciona paths estrangeiros pro workspace local em
vez de vazar o path original). A asserção detecta vazamento checando se a string de erro final
ainda contém a substring `/home/venus`. Isso funciona em qualquer máquina onde o path fictício e o
workspace real não compartilham prefixo — mas quebra quando o workspace de validação real *também*
fica sob `/home/venus/...` (que é exatamente o que acontece ao validar numa cópia isolada dentro do
próprio home do usuário `venus` nesta VPS, convenção real de instalação do projeto — `~/newclaw`).
A asserção não consegue distinguir "o path fictício vazou" de "o path local resolvido, que
por coincidência também começa com `/home/venus`, apareceu no erro". **Não é um bug de
`resolvePath()`/`exec_command` — é uma asserção de teste com substring ampla demais para esse
cenário específico de validação.** Deixado como está (não é claro que valha a complexidade de uma
asserção mais precisa para um cenário de teste, não de produção); documentado aqui para não ser
reinvestigado do zero na próxima vez que aparecer.

## Achado 3 — `S112_ArtifactContract_ToolLevelFixes` — **bug de teste real, corrigido**

**Sintoma:** `artifactPaths populado normalmente para declaração dentro do sandbox` falhava,
mesmo com `WORKSPACE_DIR` setado corretamente (não é o mesmo gap dos outros dois — este teste usa
seu próprio diretório temporário auto-gerado, independente de `WORKSPACE_DIR`).

**Causa raiz:** o comando de teste (branch Linux) usava `printf '...%.0sx' {1..220}` —
`{1..220}` é **expansão de chaves do bash**, não suportada por POSIX `sh`. `exec_command.ts`
spawna comandos via `child_process.exec()` do Node, que no Linux invoca `/bin/sh` — no Debian/Ubuntu
(incluindo esta VPS), `/bin/sh` é um symlink pra `dash`, que **não expande `{1..220}`**. O token
ficava literal, o `printf` produzia uma saída muito mais curta que os ~270 bytes esperados, e o
arquivo gerado (`tmp/dentro.txt`) provavelmente ficava abaixo de `MIN_DELIVERABLE_SIZE` (200 bytes)
— exatamente o comportamento que o resto da suite prova estar correto (arquivos pequenos demais
não contam como artefato), só que aqui era um artefato *involuntariamente* pequeno por causa do
bashismo não expandido, não o cenário que o teste queria provar.

**Isto não é um bug do produto** — `exec_command` spawnar via `/bin/sh` é o comportamento
documentado e correto (ver `src/tools/exec_command.ts`); é o comando do teste que assumia bash.

**Resolução:** commit `36036de` — trocado `{1..220}` por um loop `awk` (POSIX, sem bashismos),
produzindo o mesmo conteúdo (~270 bytes). Confirmado **7/7** rodando de verdade contra `dash` na
mesma VPS Ubuntu 24.04.

## Resultado final (após as correções acima)

| Teste | Antes (setup incompleto) | Depois (causa raiz corrigida) |
|---|---|---|
| S37 | 8/9 (1 falso positivo) | **9/9** — nenhuma mudança de código, só `WORKSPACE_DIR` correto |
| S13 | 5/8 (3 falsos positivos) | **7/8** — 1 residual é fragilidade de asserção documentada acima, não corrigida |
| S112 | 6/7 (1 bug de teste real) | **7/7** — corrigido no commit `36036de` |

## Lições para o processo deste programa

1. **A skill `verify` (`.claude/skills/verify/`) já documentava a necessidade de um `.env` com
   `WORKSPACE_DIR` explícito** — a primeira validação da S08 pulou esse passo ao adaptar o
   procedimento (pensado originalmente pra local Windows) pra uma VPS remota via SSH. Da próxima
   vez que uma Sprint exigir ambiente real numa VPS, replicar o `.env` completo da skill, não só
   `npm install && npm run build && rodar a suíte`.
2. **"A suíte não deu 100% numa máquina nova" não é o mesmo que "regressão"** — comparar contra o
   commit anterior NA MESMA máquina (o que a Sprint S08 já fez) é necessário mas não suficiente;
   também é preciso entender a causa raiz de cada falha antes de arquivar como "ambiente", porque
   pode ser um bug de teste real escondido atrás de uma diferença de ambiente genuína (como foi o
   caso do S112).
3. `exec_command.ts` spawna via `/bin/sh`, não `/bin/bash`, em produção — qualquer teste (ou
   comando gerado por LLM) que assuma sintaxe bash-only vai falhar silenciosamente em qualquer
   distro onde `/bin/sh` seja `dash` (Debian, Ubuntu — mas não todas: Fedora/RHEL usam bash como
   `/bin/sh`). Vale ter esse fato em mente ao escrever qualquer novo teste que gere comandos
   shell multiplataforma.

## Severidade
- **Severidade:** Baixa — nenhum dos 3 achados afeta comportamento real de usuário; são gaps de
  processo de validação (2) e um bug de teste isolado já corrigido (1).
- **Impacto:** Nenhum em produção. Impacto era só na confiabilidade do sinal "ambiente real" desta
  e de futuras Sprints, se a causa raiz não fosse investigada.
