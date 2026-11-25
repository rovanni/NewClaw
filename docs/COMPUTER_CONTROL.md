# computer_control — controlar ESTE computador

Tool que dá ao NewClaw mãos e olhos na máquina onde ele está rodando. Não usa VPS, nem agente
HTTP remoto, nem porta aberta: roda em processo, na sua sessão gráfica.

## O que faz

**Desktop (Windows)**
| ação | o que faz |
|---|---|
| `screen_size` | tamanho da tela primária |
| `cursor_pos` | posição atual do cursor |
| `screenshot` | captura a tela → `workspace/artifacts/computer/screen-<ts>.png` |
| `move` / `click` | move o cursor, clica (`left`/`right`/`middle`) |
| `type` | digita texto na janela em foco |
| `key` | tecla/combinação: `enter`, `tab`, `esc`, `ctrl+s`, `alt+f4`, `f5`… |

Implementação: PowerShell + user32 (SetCursorPos/mouse_event) e `System.Windows.Forms.SendKeys`.
Zero dependência nativa, sem `node-gyp`.

**Navegador (Playwright, Chromium próprio e isolado do seu Chrome)**
| ação | o que faz |
|---|---|
| `browser_open` | abre URL (headless por padrão) |
| `browser_click` | clica por seletor CSS |
| `browser_type` | preenche campo (opcional `submit` = Enter) |
| `browser_text` | extrai texto da página (delimitado como **não confiável**) |
| `browser_screenshot` | screenshot da página → artefato |
| `browser_status` / `browser_close` | estado da sessão / fecha |

## Instalação no PC

```powershell
cd <pasta-do-newclaw>
git pull
npm install                 # instala playwright (optionalDependency)
npx playwright install chromium
npm run build
```

Se preferir não usar navegador, nada disso é obrigatório: a tool carrega Playwright só quando
uma ação `browser_*` é chamada, e devolve uma mensagem clara se ele não estiver instalado.

## Segurança

- Registrada como **`dangerous: true`** — em modo SAFE, cada chamada pede aprovação, igual
  `exec_command` e `ssh_exec`. Clicar e digitar pode apagar, comprar ou enviar.
- Texto digitado **nunca** volta no resultado (só a contagem de caracteres); com `secret: true`
  nem a contagem. Senha não entra em log nem no transcript.
- Conteúdo de página volta embrulhado em `<conteudo_nao_confiavel>`: é **dado**, não instrução.
- Nenhuma porta é aberta. Nenhum serviço escuta. O controle morre com o processo do NewClaw.

## Exemplos de uso (linguagem natural)

- "Tira um screenshot da tela e me diz o que está aberto."
- "Abre o site do banco, faz login e baixa o extrato de novembro." (pedirá aprovação em SAFE)
- "Abre o `nuvem.marte.local`, clica em Arquivos e me diz quantos arquivos tem na pasta Aulas."

## Limites conhecidos

- **Windows-only** para o desktop (Linux/macOS devolvem erro explícito, não fingem sucesso).
- `type` usa `SendKeys`: caracteres reservados (`+ ^ % ~ ( ) { } [ ]`) são escapados
  automaticamente, mas **acentos** dependem do layout do teclado ativo.
- A sessão do navegador é única e persiste entre chamadas até `browser_close`.
- Sem verificação visual automática ainda: a screenshot é o artefato de prova, mas comparar
  antes/depois (diff) é evolução planejada.
