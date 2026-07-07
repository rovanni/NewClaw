# Suplemento newclaw para PowerPoint

Painel de tarefas (task pane) que conversa com o newclaw (mesma pipeline usada por
Telegram/Discord/dashboard, via `POST /api/chat`) e insere automaticamente na
apresentação aberta qualquer `.pptx` que o agente gerar (via
`presentation.insertSlidesFromBase64`).

## Pré-requisitos

- PowerPoint desktop (Microsoft 365) instalado.
- O newclaw rodando localmente com o dashboard ativo na porta padrão `3090`
  (já é o caso se você roda `newclaw` via PM2 — confira com `pm2 list`).
- Node.js (o mesmo usado no projeto principal).

## Instalação automática (recomendado)

```powershell
cd addins\powerpoint-addin
.\install.ps1
```

Faz tudo sozinho: `npm install`, build de produção, confia no certificado de
desenvolvimento, registra o suplemento no PowerPoint (sem precisar de "Upload
My Add-in"), pede a senha do dashboard uma vez (ou nada, se o dashboard não
tiver senha) para gerar e salvar o token localmente, e sobe o servidor via
PM2 — assim o suplemento continua funcionando mesmo sem nenhum terminal
aberto. Depois é só (re)abrir o PowerPoint; o botão **newclaw** já aparece na
guia HOME.

Opções: `.\install.ps1 -ServerUrl "http://outro-host:3090"` /
`.\install.ps1 -NoPm2` (não sobe via PM2, use `npm run serve` manualmente) /
`.\install.ps1 -Help`.

Gerenciar depois: `pm2 logs newclaw-pptx-addin`, `pm2 restart newclaw-pptx-addin`.

## Setup manual (desenvolvimento / depuração)

```bash
npm install
npm run dev-server
```

Na primeira execução, o Windows vai pedir para confiar no certificado de
desenvolvimento ("Developer CA for Microsoft Office Add-ins") — aceite o
prompt. Isso só acontece uma vez por máquina.

Com o servidor rodando em `https://localhost:3000`, sideload o suplemento:

- **Automático:** `npm start` (fecha com `npm stop`) abre o PowerPoint e
  carrega o suplemento sozinho.
- **Manual:** no PowerPoint, aba **Inserir → Suplementos → Meus Suplementos →
  Carregar Meu Suplemento**, e selecione o arquivo `manifest.xml` desta pasta
  (siga o mesmo passo do [quickstart oficial](https://learn.microsoft.com/office/dev/add-ins/quickstarts/powerpoint-quickstart-yo)).

## Uso

1. Clique no botão **newclaw** na guia HOME para abrir o painel.
2. Se o `install.ps1` não foi usado (ou o token expirou/mudou), clique na
   engrenagem, informe a URL do servidor (padrão `http://127.0.0.1:3090`) e
   um token — gere um fazendo login no dashboard web (`/config` → login) e
   copiando o token da sessão, ou peça um via `POST /api/auth/login`. Sem
   senha configurada no dashboard, deixe o token em branco.
3. Digite o pedido (ex.: "crie 3 slides sobre X") e envie.
4. Se a resposta incluir um `.pptx`, os slides são inseridos automaticamente
   no final da apresentação aberta. Outros tipos de anexo apenas são
   sinalizados no chat (não há inserção automática).

## Limitações conhecidas

- `insertSlidesFromBase64` exige o requirement set `PowerPointApi 1.2`
  (presente em qualquer PowerPoint desktop/web razoavelmente atual). Se a
  chamada falhar, o painel mostra o erro e avisa que o arquivo ainda foi
  gerado no newclaw — pode ser inserido manualmente via **Inserir →
  Reutilizar Slides**.
- A comunicação com o dashboard usa `http://127.0.0.1` a partir de uma página
  `https://localhost:3000`; navegadores baseados em Chromium (inclusive o
  WebView2 usado pelo Office) tratam `localhost`/`127.0.0.1` como contexto
  seguro e não bloqueiam isso como conteúdo misto — mas se você apontar o
  servidor para um host remoto, sirva-o também via HTTPS.
