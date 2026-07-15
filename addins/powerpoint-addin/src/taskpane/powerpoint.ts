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

      // Carrega os títulos dos slides em lote (batch load)
      for (const slide of slides.items) {
        slide.shapes.load("items/name,items/textFrame/textRange/text,items/textFrame/hasText");
      }
      await context.sync();

      const slideTitles = slides.items.map((slide, idx) => {
        for (const shape of slide.shapes.items) {
          if (shape.textFrame && shape.textFrame.hasText) {
            const text = shape.textFrame.textRange.text.trim();
            if (text) {
              return text.length > 30 ? text.slice(0, 30) + "..." : text;
            }
          }
        }
        return `Slide ${idx + 1}`;
      });

      return {
        presentationTitle,
        totalSlides,
        activeSlideIndex: currentSlideNumber,
        slideTitles: slideTitles.slice(0, 50),
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
        } else if (cmd.action === 'getPresentation') {
          let status = 'failed';
          let errorMsg = '';
          let responseData: any = null;

          try {
            if (!Office.context.requirements.isSetSupported('PowerPointApi', '1.1')) {
              status = 'unsupported';
              errorMsg = 'PowerPointApi 1.1 não é suportada neste ambiente.';
            } else {
              await PowerPoint.run(async (context) => {
                const slides = context.presentation.slides;
                slides.load("items/id");
                await context.sync();

                for (const slide of slides.items) {
                  slide.shapes.load("items/name,items/textFrame/textRange/text,items/textFrame/hasText");
                }
                await context.sync();

                const mappedSlides = slides.items.map((slide, idx) => {
                  let title = `Slide ${idx + 1}`;
                  for (const shape of slide.shapes.items) {
                    if (shape.textFrame && shape.textFrame.hasText) {
                      const text = shape.textFrame.textRange.text.trim();
                      if (text) {
                        title = text.length > 50 ? text.slice(0, 50) + "..." : text;
                        break;
                      }
                    }
                  }
                  return {
                    slideId: slide.id,
                    index: idx + 1,
                    title
                  };
                });

                responseData = { slides: mappedSlides };
                status = 'executed';
              });
            }
          } catch (err) {
            status = 'failed';
            errorMsg = err instanceof Error ? err.message : String(err);
          }

          await fetch(`${serverUrl}/api/integrations/powerpoint/commands/${cmd.commandId}/result`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              sessionId: getSessionId(),
              status,
              error: errorMsg,
              data: responseData
            })
          }).catch(console.error);
        } else if (cmd.action === 'getSlide') {
          let status = 'failed';
          let errorMsg = '';
          let responseData: any = null;

          try {
            if (!Office.context.requirements.isSetSupported('PowerPointApi', '1.1')) {
              status = 'unsupported';
              errorMsg = 'PowerPointApi 1.1 não é suportada neste ambiente.';
            } else {
              await PowerPoint.run(async (context) => {
                const slides = context.presentation.slides;
                let targetSlide: PowerPoint.Slide;

                if (cmd.args.id) {
                  targetSlide = slides.getItem(cmd.args.id);
                } else if (typeof cmd.args.index === 'number') {
                  targetSlide = slides.getItemAt(cmd.args.index - 1);
                } else {
                  const activeSlides = context.presentation.getSelectedSlides();
                  activeSlides.load("items/id");
                  await context.sync();
                  targetSlide = activeSlides.items.length > 0 ? activeSlides.items[0] : slides.getItemAt(0);
                }

                targetSlide.load("id");
                const shapes = targetSlide.shapes;
                shapes.load("items/id,items/name,items/type");
                await context.sync();

                const slideId = targetSlide.id;
                slides.load("items/id");
                await context.sync();
                let slideIndex = 1;
                for (let i = 0; i < slides.items.length; i++) {
                  if (slides.items[i].id === slideId) {
                    slideIndex = i + 1;
                    break;
                  }
                }

                const tables: { shape: PowerPoint.Shape; table: PowerPoint.Table }[] = [];
                const textShapes: PowerPoint.Shape[] = [];

                for (const shape of shapes.items) {
                  if (shape.type === 'Table') {
                    const tbl = shape.getTable();
                    tbl.load("rowCount,columnCount");
                    tables.push({ shape, table: tbl });
                  } else {
                    try {
                      shape.textFrame.load("hasText");
                      textShapes.push(shape);
                    } catch {
                      // Ignora shapes que não suportam textFrame
                    }
                  }
                }
                await context.sync();

                const cellQueries: { cell: PowerPoint.TableCell; row: number; col: number; shapeId: string }[] = [];
                for (const item of tables) {
                  const tbl = item.table;
                  const rowCount = tbl.rowCount;
                  const colCount = tbl.columnCount;
                  for (let r = 0; r < rowCount; r++) {
                    for (let c = 0; c < colCount; c++) {
                      const cell = tbl.getCell(r, c);
                      cell.load("text");
                      cellQueries.push({ cell, row: r, col: c, shapeId: item.shape.id });
                    }
                  }
                }

                for (const shape of textShapes) {
                  if (shape.textFrame.hasText) {
                    shape.textFrame.textRange.load("text");
                  }
                }
                await context.sync();

                const mappedShapes = shapes.items.map((shape) => {
                  const typeLower = (shape.type || '').toLowerCase();
                  const isPlaceholder = typeLower === 'placeholder';

                  if (shape.type === 'Table') {
                    const tblItem = tables.find(t => t.shape.id === shape.id);
                    const rowCount = tblItem ? tblItem.table.rowCount : 0;
                    const colCount = tblItem ? tblItem.table.columnCount : 0;
                    
                    const cells: string[][] = [];
                    for (let r = 0; r < rowCount; r++) {
                      cells[r] = [];
                      for (let c = 0; c < colCount; c++) {
                        const cellQuery = cellQueries.find(q => q.shapeId === shape.id && q.row === r && q.col === c);
                        const cellText = cellQuery ? cellQuery.cell.text : '';
                        cells[r][c] = cellText.length > 1000 ? cellText.slice(0, 1000) + "..." : cellText;
                      }
                    }

                    return {
                      shapeId: shape.id,
                      name: shape.name,
                      type: 'table',
                      placeholder: false,
                      cells
                    };
                  } else if (shape.type === 'Image') {
                    return {
                      shapeId: shape.id,
                      name: shape.name,
                      type: 'picture',
                      placeholder: isPlaceholder
                    };
                  } else {
                    const hasText = textShapes.find(s => s.id === shape.id)?.textFrame.hasText;
                    let text = '';
                    if (hasText) {
                      const shapeText = textShapes.find(s => s.id === shape.id)?.textFrame.textRange.text || '';
                      text = shapeText.length > 1000 ? shapeText.slice(0, 1000) + "..." : shapeText;
                    }

                    return {
                      shapeId: shape.id,
                      name: shape.name,
                      type: text ? 'text' : 'other',
                      placeholder: isPlaceholder,
                      text: text || undefined
                    };
                  }
                });

                responseData = {
                  slideId,
                  slideIndex,
                  layoutName: 'Normal',
                  shapes: mappedShapes
                };
                status = 'executed';
              });
            }
          } catch (err) {
            status = 'failed';
            errorMsg = err instanceof Error ? err.message : String(err);
          }

          await fetch(`${serverUrl}/api/integrations/powerpoint/commands/${cmd.commandId}/result`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              sessionId: getSessionId(),
              status,
              error: errorMsg,
              data: responseData
            })
          }).catch(console.error);
        } else if (cmd.action === 'insertDocument') {
          // Entrega assíncrona: goal terminou depois que a requisição HTTP original que o
          // pediu já tinha sido resolvida (ex.: ACK de "conversa ocupada"). Sem ack pendente
          // no broker para esse tipo de comando — só inserimos o que chegou.
          const fileName: string = cmd.args.fileName || 'documento.pptx';
          if (fileName.toLowerCase().endsWith('.pptx')) {
            await insertSlidesFromAttachment({
              type: 'document',
              fileName,
              mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              data: cmd.args.data,
            });
          } else {
            addMessage('status', `Anexo recebido (não inserido automaticamente): ${fileName}`);
          }
        }
      }
    } catch {
      // Ignora erros de rede no polling
    } finally {
      isPolling = false;
    }
  }, 3000);
}
