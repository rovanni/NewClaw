---
name: skill-manager
description: Instala, audita e gerencia skills no NewClaw. Permite buscar skills em skills.sh, instalar de repositórios GitHub, auditar segurança e ativar novas capacidades sem reiniciar o sistema.
version: "1.0"
triggers: instalar skill, adicionar skill, nova skill, skills add, skill install, buscar skill, npx skills, skills.sh, habilidade nova, capacidade nova
tools: exec_command, web_navigate, read, write, memory_write
tags: skill, install, manage, deploy, capability, extension, plugin
---

# Skill Manager

Permite que o NewClaw se auto-expanda instalando novas skills de forma segura.

## Fluxo Completo de Instalação

### Etapa 1 — Buscar skills disponíveis

Se o usuário mencionar skills.sh ou quiser explorar:

```
web_navigate action=open url=https://www.skills.sh
```

Para buscar skills por tipo:
```
web_navigate action=open url=https://www.skills.sh/?q=TERMO_DE_BUSCA
```

Para ver detalhes de uma skill específica, seguir os links da página.

### Etapa 2 — Obter o comando de instalação

O skills.sh mostra comandos no formato:
```
npx skills add <URL_DO_REPOSITORIO> --skill <nome>
```

Anotar a URL do repositório GitHub para a próxima etapa.

### Etapa 3 — Estágio e auditoria (OBRIGATÓRIO antes de ativar)

**Nunca instalar diretamente na pasta `./skills/` sem auditar antes.**

Identifique o SO do ambiente atual antes de escolher o bloco abaixo — `git clone` é o mesmo nos
três sistemas, só o restante muda.

Linux/macOS:
```bash
# Criar diretório de staging se não existir
mkdir -p /tmp/skill_staging

# Clonar o repositório
git clone "<URL_REPO>" /tmp/skill_staging/<NOME_SKILL>

# Verificar estrutura básica
ls /tmp/skill_staging/<NOME_SKILL>/
cat /tmp/skill_staging/<NOME_SKILL>/SKILL.md 2>/dev/null || echo "Sem SKILL.md"
```

Windows (PowerShell):
```powershell
# Criar diretório de staging se não existir
New-Item -ItemType Directory -Force -Path "$env:TEMP\skill_staging" | Out-Null

# Clonar o repositório
git clone "<URL_REPO>" "$env:TEMP\skill_staging\<NOME_SKILL>"

# Verificar estrutura básica
Get-ChildItem "$env:TEMP\skill_staging\<NOME_SKILL>"
if (Test-Path "$env:TEMP\skill_staging\<NOME_SKILL>\SKILL.md") { Get-Content "$env:TEMP\skill_staging\<NOME_SKILL>\SKILL.md" } else { "Sem SKILL.md" }
```

### Etapa 4 — Executar auditoria de segurança

Seguir o protocolo completo da skill **skill-auditor**. Identifique o SO do ambiente atual antes
de escolher o bloco — a lógica dos 7 padrões é a mesma, só a ferramenta de busca muda.

Linux/macOS:
```bash
SKILL_PATH="/tmp/skill_staging/<NOME_SKILL>"

# 3.1 Prompt Injection
grep -rniE "ignore (previous|all|above|prior) instructions|disregard|override (your|all)|forget (you are|your role)|new persona|act as (an? )?(unrestricted|DAN|jailbreak)|you are now|system prompt" "$SKILL_PATH" --include="*.md" --include="*.txt"

# 3.2 Acesso a arquivos sensíveis
grep -rniE "/etc/(passwd|shadow|sudoers)|~/.ssh|~/.aws|\.env|id_rsa|\.pem|authorized_keys|credentials|secret" "$SKILL_PATH"

# 3.3 Variáveis de ambiente sensíveis
grep -rniE "(API_KEY|SECRET_KEY|ACCESS_TOKEN|PASSWORD|PRIVATE_KEY|DATABASE_URL|OPENAI_API|ANTHROPIC_API|AWS_SECRET)\s*[=:]" "$SKILL_PATH"

# 3.4 Exfiltração
grep -rniE "(curl|wget|fetch)\s.*(http|https)://" "$SKILL_PATH"

# 3.5 Comandos perigosos
grep -rniE "rm\s+-rf\s+/|chmod\s+777|eval\s*\(|exec\s*\(|shell=True|\$\(.*\)" "$SKILL_PATH"

# 3.6 Downloads ocultos
grep -rniE "npm install|pip install|apt(-get)? install|wget .* -O|curl .* \|" "$SKILL_PATH"

# 3.7 Ofuscação
grep -rniE "base64|atob|btoa|eval\(atob|fromCharCode" "$SKILL_PATH"
```

Windows (PowerShell — `Select-String` é o equivalente de `grep`, `-Pattern` já é case-insensitive
por padrão):
```powershell
$SkillPath = "$env:TEMP\skill_staging\<NOME_SKILL>"

# 3.1 Prompt Injection
Get-ChildItem $SkillPath -Recurse -Include *.md,*.txt | Select-String -Pattern "ignore (previous|all|above|prior) instructions|disregard|override (your|all)|forget (you are|your role)|new persona|act as (an? )?(unrestricted|DAN|jailbreak)|you are now|system prompt"

# 3.2 Acesso a arquivos sensíveis
Get-ChildItem $SkillPath -Recurse -File | Select-String -Pattern "/etc/(passwd|shadow|sudoers)|~/.ssh|~/.aws|\.env|id_rsa|\.pem|authorized_keys|credentials|secret"

# 3.3 Variáveis de ambiente sensíveis
Get-ChildItem $SkillPath -Recurse -File | Select-String -Pattern "(API_KEY|SECRET_KEY|ACCESS_TOKEN|PASSWORD|PRIVATE_KEY|DATABASE_URL|OPENAI_API|ANTHROPIC_API|AWS_SECRET)\s*[=:]"

# 3.4 Exfiltração
Get-ChildItem $SkillPath -Recurse -File | Select-String -Pattern "(curl|wget|fetch)\s.*(http|https)://"

# 3.5 Comandos perigosos
Get-ChildItem $SkillPath -Recurse -File | Select-String -Pattern "rm\s+-rf\s+/|chmod\s+777|eval\s*\(|exec\s*\(|shell=True|\$\(.*\)"

# 3.6 Downloads ocultos
Get-ChildItem $SkillPath -Recurse -File | Select-String -Pattern "npm install|pip install|apt(-get)? install|wget .* -O|curl .* \|"

# 3.7 Ofuscação
Get-ChildItem $SkillPath -Recurse -File | Select-String -Pattern "base64|atob|btoa|eval\(atob|fromCharCode"
```

**Regra de decisão:**
- Qualquer achado nos itens 3.1, 3.2, 3.5 com rm -rf → **BLOQUEAR**, não instalar
- Achados em 3.3, 3.4, 3.6, 3.7 → avaliar contexto, perguntar ao usuário
- Sem achados → **APROVAR** e prosseguir

### Etapa 5 — Ativar a skill aprovada

Se a auditoria aprovada, mover para o diretório de skills ativo. **Atenção**: `exec_command` roda
com o workspace como diretório atual, não a raiz do NewClaw — use o caminho absoluto da instalação
(a mesma pasta onde fica `./skills/` na raiz do NewClaw), não um `./skills/` relativo.

Linux/macOS:
```bash
# Copiar skill auditada para o diretório ativo (caminho absoluto da instalação do NewClaw)
cp -r /tmp/skill_staging/<NOME_SKILL> /caminho/absoluto/do/newclaw/skills/<NOME_SKILL>

# Confirmar que SKILL.md está presente
ls /caminho/absoluto/do/newclaw/skills/<NOME_SKILL>/SKILL.md

# Limpar staging
rm -rf /tmp/skill_staging/<NOME_SKILL>
```

Windows (PowerShell):
```powershell
# Copiar skill auditada para o diretório ativo (caminho absoluto da instalação do NewClaw)
Copy-Item -Recurse "$env:TEMP\skill_staging\<NOME_SKILL>" "C:\caminho\absoluto\do\newclaw\skills\<NOME_SKILL>"

# Confirmar que SKILL.md está presente
Test-Path "C:\caminho\absoluto\do\newclaw\skills\<NOME_SKILL>\SKILL.md"

# Limpar staging
Remove-Item -Recurse -Force "$env:TEMP\skill_staging\<NOME_SKILL>"
```

A skill é **carregada automaticamente** na próxima mensagem (hot-reload do SkillLoader).

### Etapa 6 — Confirmar ativação

Linux/macOS: `ls /caminho/absoluto/do/newclaw/skills/`
Windows: `Get-ChildItem "C:\caminho\absoluto\do\newclaw\skills\"`

Reportar ao usuário quais skills estão agora disponíveis.

<!-- TASK_ONLY_START -->
## Instalação via npx skills add

O comando `npx skills add` do ecossistema skills.sh instala no diretório atual (`npx` já é o
mesmo comando nos três sistemas). Para usar com auditoria prévia:

Linux/macOS:
```bash
# 1. Criar diretório temporário e instalar lá
mkdir -p /tmp/skill_staging
cd /tmp/skill_staging
npx skills add <URL_REPO> --skill <nome>

# 2. Auditar o conteúdo instalado (ver Etapa 4)

# 3. Se aprovado, mover para skills/ (caminho absoluto da instalação do NewClaw)
cp -r /tmp/skill_staging/<nome> /caminho/absoluto/do/newclaw/skills/<nome>
```

Windows (PowerShell):
```powershell
# 1. Criar diretório temporário e instalar lá
New-Item -ItemType Directory -Force -Path "$env:TEMP\skill_staging" | Out-Null
Set-Location "$env:TEMP\skill_staging"
npx skills add <URL_REPO> --skill <nome>

# 2. Auditar o conteúdo instalado (ver Etapa 4)

# 3. Se aprovado, mover para skills/ (caminho absoluto da instalação do NewClaw)
Copy-Item -Recurse "$env:TEMP\skill_staging\<nome>" "C:\caminho\absoluto\do\newclaw\skills\<nome>"
```

## Listar skills instaladas

Linux/macOS: `ls -la /caminho/absoluto/do/newclaw/skills/`
Windows: `Get-ChildItem "C:\caminho\absoluto\do\newclaw\skills\"`

## Remover uma skill

Linux/macOS:
```bash
rm -rf /caminho/absoluto/do/newclaw/skills/<NOME_SKILL>
echo "Skill removida. Será descarregada na próxima mensagem."
```

Windows (PowerShell):
```powershell
Remove-Item -Recurse -Force "C:\caminho\absoluto\do\newclaw\skills\<NOME_SKILL>"
Write-Output "Skill removida. Será descarregada na próxima mensagem."
```

## Skills recomendadas do ecossistema

| Skill | Descrição | URL |
|-------|-----------|-----|
| pptx | Geração de PowerPoint | skills.sh |
| pdf-tools | Manipulação de PDF | skills.sh |
| diagram | Geração de diagramas | skills.sh |
| web-scraper | Extração de dados web | skills.sh |

Para mais skills: `web_navigate action=open url=https://www.skills.sh`
<!-- TASK_ONLY_END -->

## Regras de Segurança

1. **Nunca** instalar skill sem auditar primeiro
2. **Nunca** instalar de URLs não-HTTPS ou repositórios sem SKILL.md
3. Sempre informar o usuário sobre achados da auditoria antes de ativar
4. Em caso de dúvida, colocar em staging e pedir confirmação manual
5. Skills internas (dentro de `./skills/`) são confiáveis e não precisam de re-auditoria
