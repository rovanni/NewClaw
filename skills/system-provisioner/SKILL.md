---
name: system-provisioner
description: Instala dependências e configura o ambiente (pip, npm, apt, etc.)
version: "1.0"
triggers: instalar, install, configurar, setup, dependência, pip, npm, apt
tools: exec_command
tags: install, setup, environment, dependency, package, configure, provision
---

# System Provisioner Skill

Quando o usuário pedir para instalar algo, primeiro identifique o sistema operacional do ambiente
atual (Windows/Linux/macOS) e use o comando correspondente — nunca assuma Linux por padrão.

1. Verifique se já está instalado:
   - Windows: `where COMANDO` (ou `python -m pip show PACOTE` / `npm list -g PACOTE`)
   - Linux/macOS: `which COMANDO || pip3 show PACOTE || npm list -g PACOTE`
2. Se não estiver, instale:
   - Python — Windows: `python -m pip install PACOTE` (ou `py -m pip install PACOTE`) | Linux/macOS: `python3 -m pip install PACOTE` (ou `pip3 install PACOTE`)
   - Node.js: `npm install -g PACOTE` (mesmo comando nos três sistemas)
   - Pacote de sistema — Windows: `winget install PACOTE` | Linux: `sudo apt-get install -y PACOTE` | macOS: `brew install PACOTE` (pedir confirmação antes, em qualquer SO)
3. Verifique a instalação:
   - Windows: `COMANDO --version` (ou `python -m pip show PACOTE`)
   - Linux/macOS: `COMANDO --version || pip3 show PACOTE`
4. Reporte o resultado

**Regras:**
- Sempre verificar se já está instalado antes de instalar
- Usar o comando de Python correto por SO: `python -m pip`/`py -m pip` no Windows (não existe `pip3` nativo lá), `pip3`/`python3 -m pip` no Linux/macOS
- Para pacotes de sistema, pedir confirmação antes — `winget` no Windows, `apt-get` no Linux, `brew` no macOS
- Se falhar, tentar alternativa (ex: no Windows, `python -m pip` → `py -m pip`; no Linux/macOS, `pip3` → `pip`)
- **TTS com gTTS:** SEMPRE especificar `lang='pt'` — nunca usar sem parâmetro de idioma. Exemplo correto: `gTTS(text=conteudo, lang='pt', slow=False)`