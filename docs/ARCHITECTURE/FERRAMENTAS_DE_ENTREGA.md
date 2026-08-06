# Ferramentas de Entrega

> Documento normativo. Define o contrato de saída de toda ferramenta cujo propósito é **entregar
> conteúdo ao usuário**, existente ou futura.

## 1. Princípio

> **Uma ferramenta de entrega devolve o conteúdo entregue. Diagnóstico operacional pertence ao log
> e à telemetria, nunca à resposta final.**

Ferramenta de entrega é aquela cujo objetivo é fazer algo chegar ao usuário: `send_audio`,
`send_document`, `send_image`, `send_video` e qualquer outra que venha a existir (`send_email`,
`send_sms`, publicação em um canal externo). O critério não é o nome, é o propósito: se o sucesso da
ferramenta significa "o usuário recebeu algo", ela é uma ferramenta de entrega.

## 2. Por que isso importa

O `output` de uma ferramenta tem dois consumidores, e é fácil esquecer o segundo:

1. **A camada de raciocínio** — o resultado entra no contexto do LLM para o próximo passo.
2. **O usuário** — quando a ferramenta é o último passo do objetivo, aquele `output` **é** a
   resposta que chega ao canal.

Uma string de status serve mal aos dois. Para o LLM, "enviado com sucesso" não diz o que foi
enviado. Para o usuário, é um recibo em vez de uma resposta.

## 3. Evidência que originou este princípio

Execução real, 05/08/2026: pedido "Poderia explicar cada projeto?" com três imagens. O agente
analisou as três, produziu a explicação e a entregou **por áudio**. O que chegou ao usuário:

```text
attachments: [voice.ogg, 450 KB]
response:    "🔊 Áudio já enviado nesta execução do objetivo — reenvio evitado."  (73 caracteres)
```

A resposta textual era a mensagem interna do mecanismo de deduplicação. Quem não pudesse ouvir o
áudio — canal sem reprodução, ambiente inadequado, deficiência auditiva — ficaria sem resposta
nenhuma, apesar de o sistema ter feito todo o trabalho corretamente.

A investigação mostrou que **não era um caso isolado do dedup**: os três caminhos do `send_audio`
devolviam recibo, incluindo o caminho de sucesso.

| Caminho | `output` antes | `output` agora |
|---|---|---|
| Sucesso | `🔊 Áudio enviado com sucesso!` | o texto falado |
| Debounce por tempo | `🔊 Áudio já enviado recentemente.` | o texto falado |
| Dedup dentro do objetivo | `🔊 Áudio já enviado nesta execução do objetivo — reenvio evitado.` | o texto falado |

Note que o caminho feliz tinha exatamente o mesmo defeito — o caso do dedup só foi mais visível
porque a mensagem era mais estranha.

## 4. Regra prática

Ao escrever ou revisar uma ferramenta de entrega:

* **`output` = conteúdo.** O texto que foi falado, o resumo do documento enviado, a descrição do que
  foi publicado. Se a ferramenta recebeu o conteúdo como argumento, é esse conteúdo que volta.
* **Status vai para o log.** "Enviado", "pulado por debounce", "reenvio evitado", tempo de upload,
  tamanho do arquivo — tudo isso é telemetria.
* **Caminho alternativo não muda o contrato.** Um envio pulado por deduplicação devolve o mesmo
  conteúdo que um envio realizado: do ponto de vista do usuário, o conteúdo foi entregue (por outro
  caminho), e é isso que a resposta deve refletir.
* **Falha é falha.** Este princípio não afeta o caminho de erro: quando a entrega não acontece,
  `success: false` com `error` descritivo continua sendo o correto.

## 5. Relação com o idioma

Recibos fixos como "Áudio enviado com sucesso!" são texto em português embutido no Core, que não
possui sistema de tradução (ver `docs/ARCHITECTURE.md`, "Gaps conhecidos"): saíam iguais para
usuários en-US e es-ES. O conteúdo, ao contrário, foi produzido pelo próprio LLM sob a diretiva de
idioma — devolver o conteúdo em vez do recibo **remove** texto fixo do caminho do usuário em vez de
acrescentar.

É o mesmo movimento adotado pela `RFC-004` na camada de ingestão: reduzir o texto que o Core emite
diretamente, em lugar de construir um sistema de tradução para ele.

## 6. Cobertura

`S201` verifica que os três caminhos do `send_audio` devolvem o conteúdo, e que nenhum deles
devolve recibo.
