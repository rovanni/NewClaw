---
name: system-provisioner
description: Instala dependências e configura o ambiente (pip, npm, apt, etc.)
version: "1.0"
triggers: instalar, install, configurar, setup, dependência, pip, npm, apt
tools: exec_command
---

# System Provisioner Skill

Quando o usuário pedir para instalar algo:

1. Verifique se já está instalado:
   ```bash
   which COMANDO || pip3 show PACOTE || npm list -g PACOTE
   ```
2. Se não estiver, instale:
   - Python: `pip3 install PACOTE`
   - Node.js: `npm install -g PACOTE`
   - Sistema: `sudo apt-get install -y PACOTE` (pedir confirmação)
3. Verifique a instalação:
   ```bash
   COMANDO --version || pip3 show PACOTE
   ```
4. Reporte o resultado

**Regras:**
- Sempre verificar se já está instalado antes de instalar
- Usar `pip3` para Python, `npm` para Node.js
- Para pacotes do sistema (apt), pedir confirmação antes
- Se falhar, tentar alternativa (ex: pip3 → pip)