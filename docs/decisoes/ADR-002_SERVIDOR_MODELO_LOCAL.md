# ADR-002 — Ciclo de vida do servidor de modelo local

> Registro das decisões tomadas em 01-02/08/2026 ao tornar utilizáveis, pelo dashboard, os
> modelos `.gguf` que o usuário já tem no próprio computador. Documento normativo — descreve
> decisões já implementadas, não propõe mudanças.

## 1. Contexto

O NewClaw suporta endpoints OpenAI-Compatible desde 31/07/2026 (`CustomProviderConfig`,
`ProviderFactory.addCustomProvider`). Em 01/08, ao tentar usar essa capacidade com um servidor
llamafile local, o operador relatou: *"não consegui o sistema para funcionar com o llamafile, o
sistema não tem como selecionar os modelos, a interface ficou muito confusa"*.

A investigação encontrou três defeitos encadeados que tornavam **qualquer** provider custom
inalcançável, independentemente da configuração escolhida na interface:

1. `ProviderFactory.getProviderWithModel()` só tinha `case` para os 6 providers nativos; qualquer
   label custom caía no `return new OllamaProvider(...)` final. Como todo perfil do
   `ModelProfileRegistry` nasce com modelo preenchido, esse caminho é usado em toda requisição do
   provider primário — o provider custom era inalcançável na prática, mesmo corretamente
   registrado no Map (que era o que a S164 garantia).
2. `getFallbackOrder()` ignorava `defaultProvider`: a ordem começava sempre em `ollama`. O
   seletor "Provider padrão" gravava no `.env` sem efeito algum.
3. Os 6 perfis do `DEFAULT_CONFIG` traziam `provider: 'ollama'` fixo, contradizendo o contrato
   declarado na própria interface (`provider?: string; // undefined = defaultProvider`). Como o
   `AgentLoop` passa `chatProfile.provider` como `preferred`, esse valor anulava o defeito 2
   mesmo se ele fosse corrigido isoladamente.

Corrigidos os três (cobertura: `S170`), restava o degrau anterior: os arquivos `.gguf` estão em
disco, e alguém precisa carregá-los num servidor antes de existir endpoint para consumir.

## 2. Decisões

### 2.1 A pasta de modelos nunca tem valor padrão no código

`LOCAL_MODELS_DIR` nasce vazia. Sem pasta configurada, a rota devolve `configured: false` e a
interface pede a pasta — nunca tenta um caminho plausível.

**Por quê**: o projeto é OSS e roda em Windows, Linux e macOS. Um caminho embutido só funcionaria
na máquina de quem o escreveu, e vazaria o ambiente dessa pessoa para o repositório público.
Coerente com `docs/ARCHITECTURE/NUNCA_ADIVINHAR.md`: diante de dado não observado nem
configurado, reportar ausência.

`S171` falha se qualquer caminho absoluto aparecer nos arquivos envolvidos.

### 2.2 O servidor roda desacoplado do processo do NewClaw

`spawn(..., { detached: true, stdio: 'ignore' })` + `child.unref()`.

**Por quê** (incidente real, 02/08/2026): o servidor subia como processo filho. A própria
interface instrui a clicar em **"Salvar & Reiniciar"** após escolher o modelo — e esse clique
matava o NewClaw, levando o servidor junto. O sistema voltava com `DEFAULT_PROVIDER` apontando
para uma porta muda, emitindo `fetch failed` a cada ciclo de discovery, sem nenhuma pista na
tela. O fluxo se autodestruía no passo seguinte, seguindo a instrução da própria interface.

Carregar um modelo de vários GB não pode ser desfeito por reiniciar o aplicativo.

### 2.3 O NewClaw nunca religa o modelo sozinho

Ao iniciar, o dashboard **reencontra** um servidor que continue vivo (confere o PID anotado *e*
que a porta responda). Se estiver morto, **não sobe nada**: mostra o aviso e oferece o botão.

**Por quê**: um servidor de modelo local ocupa a placa de vídeo. Quem reiniciou o computador pode
estar querendo usá-la para outra coisa — jogar, renderizar. Subir vários GB de modelo sem
ninguém pedir é tomar um recurso caro por conta própria. O argumento é do operador, e é mais
forte que os inicialmente considerados (boot lento, falha silenciosa): religar automaticamente
não seria apenas inconveniente, seria **errado**.

Alternativa descartada: religar no boot. Deixaria o boot esperando minutos carregando o modelo e
falharia em silêncio se o arquivo tivesse mudado de lugar — além do problema de GPU acima.

> **Nota acrescentada em 06/08/2026.** Esta decisão diz o que **não** fazer (religar sozinho) e
> deixou em aberto o que fazer no lugar. A lacuna foi preenchida por
> `docs/decisoes/RFC-005_POLITICAS_DE_SUBSTITUICAO_DE_RECURSOS.md`: o comportamento vigente até
> então era substituir o modelo local por um de nuvem, em silêncio. A RFC-005 não reabre esta
> decisão — o NewClaw continua não religando nada por conta própria — e acrescenta que a
> indisponibilidade decorrente deve ser **comunicada**, não mascarada por substituição silenciosa.
>
> A RFC-005 também depende de §2.4 de um modo que vale registrar aqui: como o registro em
> `data/local-model-server.json` sobrevive à morte do processo, sua mera presença **não** significa
> que o servidor deveria estar de pé. O sinal correto é o que esta ADR já implementa — PID vivo *e*
> porta respondendo. Classificar por presença do registro faria de todo reinício de máquina uma
> avaria.

### 2.4 O registro do último modelo só é apagado por decisão explícita

`data/local-model-server.json` guarda `{pid, file, port}`. Processo morto **não** apaga o
registro; só o descarregamento explícito (`POST /models/local/stop`) apaga.

**Por quê**: esse registro é a única memória de qual modelo o usuário escolheu. Apagá-lo quando o
processo morre destruiria justamente a informação necessária para oferecer "carregar agora"
depois de um reinício da máquina — o cenário para o qual ele existe.

### 2.5 O nome do modelo vem do cliente; o caminho e os argumentos, não

`POST /models/local/serve` recebe apenas `file`, conferido contra a **listagem real** da pasta
configurada. Isso descarta `../`, caminhos absolutos e arquivos de fora por construção, não por
filtro de string. O executável é descoberto pelo servidor (varredura da mesma pasta por
`llamafile*`/`llama-server*`), e os argumentos são montados no servidor.

**Por quê**: a rota executa um binário da máquina. `S171` cobre seis vetores de entrada
(traversal relativo, traversal Windows, absoluto Windows, absoluto Unix, arquivo não-modelo,
nome vazio).

### 2.6 A porta é configurável

`LOCAL_SERVER_PORT`, padrão 8080 (convenção do llamafile).

**Por quê**: era fixa no código, e duas instâncias do NewClaw na mesma máquina — produção e uma
isolada de teste — disputariam a mesma porta; a segunda derrubaria o modelo da primeira. Foi
exatamente a situação encontrada ao validar esta Sprint.

### 2.7 Escolher um modelo escolhe também o provedor

A linha do catálogo já sabe de qual provedor o modelo veio (`ModelInfo.provider`). Aplicar grava
o par; trocar o provedor padrão realinha os modelos das categorias que pertenciam ao anterior.

**Por quê** (incidente real, 02/08/2026): antes, o provider era descartado no Aplicar. Voltar do
modelo local para o Ollama mantinha `MODEL_CHAT=<arquivo>.gguf` — e **continuava funcionando**,
porque o registro de perfis já estava carregado em memória. A falha só aparecia no restart
seguinte, como `Ollama API error: 404`. Falha adiada é pior que falha imediata: some a relação
entre a ação e a consequência.

## 3. Limites conhecidos

- **Validado apenas no Windows.** A detecção do executável aceita nome sem extensão para
  Linux/macOS, e `process.kill`/`detached` são multiplataforma no Node — mas nada disso foi
  exercitado fora do Windows. Escrito para funcionar nos três; verificado em um.
- **Um servidor por vez**, por instância. Trocar de modelo encerra o anterior. É deliberado (cada
  processo carrega um modelo inteiro em memória), mas impede servir dois modelos simultâneos —
  ex.: um de visão e um de texto.
- **A capacidade dos modelos locais é inferida do nome do arquivo** (`guessCapabilities`), única
  fonte disponível para um `.gguf` em disco. Heurística declarada, não detecção real: um modelo
  de visão com nome fora dos padrões conhecidos não será reconhecido como tal. Foi o caso do
  `GLM-4.6V`, corrigido acrescentando a família à heurística existente.
- **Sem jsdom no projeto**, a lógica de interface é coberta por invariantes estruturais (`S172`),
  não por execução. O comportamento foi verificado ao vivo, no dashboard, com a configuração
  conferida no `.env` depois.

## 4. Cobertura

| Teste | O que garante |
|---|---|
| `S170` | Provider custom alcançável; `defaultProvider` respeitado; perfis herdando provedor; par (modelo, provedor) |
| `S171` | Listagem contra filesystem real; validação de entrada do carregamento; processo desacoplado; memória do último modelo |
| `S172` | Estrutura única dos 10 destinos; "usar para tudo" respeitando capacidade; realinhamento ao trocar provedor |

## 5. Lição transversal

Os seis defeitos desta Sprint têm a mesma assinatura: **o estado declarado estava correto e o
comportamento era outro**. Provider registrado mas inalcançável; `defaultProvider` gravado e
ignorado; `undefined` que não limpava campo (some no `JSON.stringify`, e o merge do lado do
servidor preservava o valor antigo); `health` que o servidor mandava e o cliente descartava;
modelo carregado que morria no restart; modelos apontando para provedor trocado.

Nenhum foi encontrado por teste — todos por rodar a aplicação e clicar na interface. A `S164` é o
exemplo mais claro: provava que o provider estava *registrado*, não que era *alcançável*, e
passava verde enquanto nenhuma requisição chegava lá.

A Validação Progressiva (`DIRETRIZ_ARQUITETURA_2026-07-13.md`) exige execução real para mudanças
na pipeline de Goal/AgentLoop. Esta Sprint sugere que **o dashboard é uma fronteira igualmente
crítica** — ele escreve a configuração que o Core lê, e foi ali que os defeitos viveram.
