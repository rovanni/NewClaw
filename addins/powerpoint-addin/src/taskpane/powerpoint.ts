/* global document, localStorage, crypto, fetch, Office, PowerPoint */

interface ChatAttachment {
  type: string;
  fileName: string;
  mimeType: string;
  data: string; // base64
}

interface ChatApiResponse {
  success: boolean;
  response?: string;
  sessionId?: string;
  attachments?: ChatAttachment[];
  error?: string;
}

const STORAGE_KEY_SERVER = "newclaw_server_url";
const STORAGE_KEY_TOKEN = "newclaw_token";
const STORAGE_KEY_SESSION = "newclaw_session_id";
const DEFAULT_SERVER_URL = "http://127.0.0.1:3090";

function getServerUrl(): string {
  return (localStorage.getItem(STORAGE_KEY_SERVER) || DEFAULT_SERVER_URL).replace(/\/+$/, "");
}

function getToken(): string {
  return localStorage.getItem(STORAGE_KEY_TOKEN) || "";
}

function getSessionId(): string {
  let id = localStorage.getItem(STORAGE_KEY_SESSION);
  if (!id) {
    id = `powerpoint-addin-${crypto.randomUUID()}`;
    localStorage.setItem(STORAGE_KEY_SESSION, id);
  }
  return id;
}

/**
 * Captura o contexto do slide ativo usando a API Office.js.
 * Retorna informacoes sobre o slide atual (numero, total, textos) para
 * que o agente saiba sobre o que o usuario esta trabalhando.
 * Falhas sao silenciadas — o chat funciona normalmente sem contexto.
 */
async function getSlideContext(): Promise<Record<string, unknown> | null> {
  try {
    return await PowerPoint.run(async (context) => {
      const slides = context.presentation.slides;
      slides.load("items/id");
      await context.sync();

      const totalSlides = slides.items.length;

      // Identifica o slide ativo
      const activeSlide = context.presentation.getSelectedSlides();
      activeSlide.load("items/id");
      await context.sync();

      let currentSlideNumber = 1;
      if (activeSlide.items.length > 0) {
        const activeId = activeSlide.items[0].id;
        for (let i = 0; i < slides.items.length; i++) {
          if (slides.items[i].id === activeId) {
            currentSlideNumber = i + 1;
            break;
          }
        }
      }

      // Captura textos do slide ativo
      const slideTexts: string[] = [];
      if (activeSlide.items.length > 0) {
        const slide = activeSlide.items[0];
        const shapes = slide.shapes;
        shapes.load("items/name,items/textFrame/textRange/text,items/textFrame/hasText");
        await context.sync();

        for (const shape of shapes.items) {
          try {
            if (shape.textFrame && shape.textFrame.hasText) {
              const text = shape.textFrame.textRange.text.trim();
              if (text) {
                slideTexts.push(text);
              }
            }
          } catch {
            // Shapes sem textFrame (imagens, graficos) — ignora silenciosamente
          }
        }
      }

      // Captura o nome do arquivo da apresentacao via Office Common API (se disponivel/salvo)
      let presentationTitle: string | undefined;
      try {
        presentationTitle = await new Promise<string | undefined>((resolve) => {
          if (Office && Office.context && Office.context.document && Office.context.document.getFilePropertiesAsync) {
            Office.context.document.getFilePropertiesAsync((asyncResult) => {
              if (asyncResult.status === Office.AsyncResultStatus.Succeeded && asyncResult.value.url) {
                const url = asyncResult.value.url;
                // Extrai apenas o nome do arquivo no final da URL/Caminho
                const fileName = url.substring(url.lastIndexOf('/') + 1).substring(url.lastIndexOf('\\') + 1);
                resolve(fileName || undefined);
              } else {
                resolve(undefined);
              }
            });
          } else {
            resolve(undefined);
          }
        });
      } catch {
        // Ignora erros na captura do nome do arquivo
      }

      return {
        presentationTitle,
        currentSlide: currentSlideNumber,
        totalSlides,
        slideTexts: slideTexts.length > 0 ? slideTexts : undefined,
      };
    });
  } catch {
    // API indisponivel ou erro de permissao — nao bloqueia o chat
    return null;
  }
}

/**
 * Carrega servidor/token gerados pelo install.ps1 (config.local.json, servido junto do
 * bundle) na primeira execução. localStorage sempre tem prioridade — isso só preenche o
 * que o usuário ainda não configurou manualmente pelo painel de configurações.
 */
async function bootstrapFromInstaller(): Promise<void> {
  if (localStorage.getItem(STORAGE_KEY_SERVER) && localStorage.getItem(STORAGE_KEY_TOKEN)) return;
  try {
    const res = await fetch("config.local.json", { cache: "no-store" });
    if (!res.ok) return;
    const cfg = (await res.json()) as { serverUrl?: string; token?: string };
    if (cfg.serverUrl && !localStorage.getItem(STORAGE_KEY_SERVER)) {
      localStorage.setItem(STORAGE_KEY_SERVER, cfg.serverUrl);
    }
    if (cfg.token && !localStorage.getItem(STORAGE_KEY_TOKEN)) {
      localStorage.setItem(STORAGE_KEY_TOKEN, cfg.token);
    }
  } catch {
    // config.local.json não existe (instalação manual, sem install.ps1) — segue com os padrões
  }
}

Office.onReady(async (info) => {
  if (info.host !== Office.HostType.PowerPoint) return;

  await bootstrapFromInstaller();
  startCommandPolling();

  document.getElementById("sideload-msg")!.style.display = "none";
  document.getElementById("app-body")!.style.display = "flex";

  (document.getElementById("server-url") as HTMLInputElement).value = getServerUrl();
  (document.getElementById("server-token") as HTMLInputElement).value = getToken();

  document.getElementById("settings-toggle")!.onclick = toggleSettings;
  document.getElementById("save-settings")!.onclick = saveSettings;
  document.getElementById("send-button")!.onclick = () => void sendMessage();
  document.getElementById("message-input")!.addEventListener("keydown", (evt) => {
    const event = evt as KeyboardEvent;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  });
});

function toggleSettings(): void {
  const panel = document.getElementById("settings-panel")!;
  panel.style.display = panel.style.display === "none" ? "flex" : "none";
}

function saveSettings(): void {
  const url = (document.getElementById("server-url") as HTMLInputElement).value.trim();
  const token = (document.getElementById("server-token") as HTMLInputElement).value.trim();
  if (url) localStorage.setItem(STORAGE_KEY_SERVER, url);
  if (token) localStorage.setItem(STORAGE_KEY_TOKEN, token);
  else localStorage.removeItem(STORAGE_KEY_TOKEN);
  toggleSettings();
}

function addMessage(role: "user" | "assistant" | "status" | "error", text: string): HTMLElement {
  const log = document.getElementById("chat-log")!;
  const bubble = document.createElement("div");
  bubble.className = `msg msg--${role}`;
  bubble.textContent = text;
  log.appendChild(bubble);
  log.scrollTop = log.scrollHeight;
  return bubble;
}

async function sendMessage(): Promise<void> {
  const input = document.getElementById("message-input") as HTMLTextAreaElement;
  const message = input.value.trim();
  if (!message) return;

  const sendButton = document.getElementById("send-button") as HTMLButtonElement;
  addMessage("user", message);
  input.value = "";
  sendButton.disabled = true;
  const statusBubble = addMessage("status", "newclaw está processando…");

  try {
    const serverUrl = getServerUrl();
    const token = getToken();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const slideContext = await getSlideContext();

    const res = await fetch(`${serverUrl}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        message,
        sessionId: getSessionId(),
        slideContext: slideContext || undefined,
      }),
    });

    const data = (await res.json()) as ChatApiResponse;
    statusBubble.remove();

    if (!res.ok || !data.success) {
      addMessage("error", data.error || `Erro ${res.status} ao falar com o newclaw.`);
      return;
    }

    if (data.response) addMessage("assistant", data.response);

    const attachments = data.attachments || [];
    const pptxAttachment = attachments.find((a) => a.fileName?.toLowerCase().endsWith(".pptx"));

    if (pptxAttachment) {
      await insertSlidesFromAttachment(pptxAttachment);
    }

    for (const att of attachments) {
      if (att === pptxAttachment) continue;
      addMessage("status", `Anexo recebido (não inserido automaticamente): ${att.fileName}`);
    }
  } catch (err) {
    statusBubble.remove();
    const detail = err instanceof Error ? err.message : String(err);
    addMessage("error", `Falha de conexão com ${getServerUrl()}: ${detail}`);
  } finally {
    sendButton.disabled = false;
    input.focus();
  }
}

async function insertSlidesFromAttachment(attachment: ChatAttachment): Promise<void> {
  const statusBubble = addMessage("status", `Inserindo "${attachment.fileName}" na apresentação…`);
  try {
    await PowerPoint.run(async (context) => {
      const slides = context.presentation.slides;
      slides.load("items/id");
      await context.sync();

      const options: PowerPoint.InsertSlideOptions = {
        formatting: PowerPoint.InsertSlideFormatting.useDestinationTheme,
      };
      // Sem targetSlideId a inserção cai no início da apresentação — usamos o
      // último slide existente como alvo para anexar ao final.
      if (slides.items.length > 0) {
        options.targetSlideId = slides.items[slides.items.length - 1].id;
      }

      context.presentation.insertSlidesFromBase64(attachment.data, options);
      await context.sync();
    });
    statusBubble.textContent = `"${attachment.fileName}" inserido na apresentação.`;
    statusBubble.classList.add("msg--success");
  } catch (err) {
    statusBubble.remove();
    const detail = err instanceof Error ? err.message : String(err);
    addMessage(
      "error",
      `Não foi possível inserir os slides automaticamente (${detail}). O arquivo "${attachment.fileName}" foi gerado pelo newclaw — insira manualmente via Inserir > Reutilizar Slides, se necessário.`
    );
  }
}

let isPolling = false;
async function startCommandPolling(): Promise<void> {
  setInterval(async () => {
    if (isPolling) return;
    isPolling = true;
    try {
      const serverUrl = getServerUrl();
      const token = getToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const res = await fetch(`${serverUrl}/api/integrations/powerpoint/commands?sessionId=${getSessionId()}`, { headers });
      if (!res.ok) return;

      const data = await res.json();
      const commands = data.commands || [];

      for (const cmd of commands) {
        if (cmd.action === 'addTextBox') {
          let status = 'failed';
          let errorMsg = '';
          try {
            await PowerPoint.run(async (context) => {
              const slides = context.presentation.slides;
              const activeSlides = context.presentation.getSelectedSlides();
              activeSlides.load("items/id");
              await context.sync();

              const targetSlide = activeSlides.items.length > 0 ? activeSlides.items[0] : slides.getItemAt(0);
              const shape = targetSlide.shapes.addTextBox(cmd.args.text, {
                left: cmd.args.x || 100,
                top: cmd.args.y || 100,
                width: 400,
                height: 100
              });
              await context.sync();
              status = 'executed';
            });
          } catch (err) {
            status = 'failed';
            errorMsg = err instanceof Error ? err.message : String(err);
          }

          // Send ACK
          await fetch(`${serverUrl}/api/integrations/powerpoint/commands/${cmd.commandId}/result`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              sessionId: getSessionId(),
              status,
              error: errorMsg
            })
          }).catch(console.error);
        }
      }
    } catch {
      // Ignora erros de rede no polling
    } finally {
      isPolling = false;
    }
  }, 3000);
}
