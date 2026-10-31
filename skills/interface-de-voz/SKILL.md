---
name: interface-de-voz
description: Orienta a pessoa a instalar, ligar e usar a interface de voz do NewClaw (integração opcional newclaw-ivox). Use quando perguntarem como falar com o NewClaw por voz, como ligar ou instalar a interface de voz, qual senha usar na janela de voz ou por que o microfone capta som de TV, vídeo ou música e vira pedido.
version: "1.0"
triggers: interface de voz, falar com o newclaw por voz, conversar por voz, ivox, janela de voz, mãos livres, segurar espaço, senha da voz, ligar a voz, instalar a voz
tags: voice, microphone, speech, integration, install, guide, password
---

# Interface de voz

A interface de voz é a integração opcional **newclaw-ivox** (https://github.com/rovanni/newclaw-ivox). Esta skill só **orienta**: não instale nada, não rode comandos e não aceite licenças pela pessoa. A instalação e o aceite das licenças de terceiros são dela, feitos no painel.

## Como instalar

1. No painel: **Configurações → Integrações → cartão "Interface de voz" → Configurar**.
2. Escolher as opções (motor de transcrição, modelo, idioma...).
3. Ler as licenças de terceiros, marcar **"Li e aceito"** e clicar em **Instalar**.

Requisito: **Python 3.10 ou mais novo**. Se faltar, o próprio cartão mostra o que falta e como instalar.

## Como ligar e abrir

Depois de instalada, o cartão mostra **Abrir**, **Ligar/Desligar** e **Desinstalar**. A janela de voz abre em http://127.0.0.1:7860 e só funciona na própria máquina.

## Senha

A janela de voz usa a **mesma senha do painel** do NewClaw; não existe uma senha separada para a voz.

- Criar ou trocar: **Configurações → Segurança → "Senha do Dashboard"**.
- Esqueceu: no computador onde o NewClaw roda, executar `newclaw passwd`.
- Painel sem senha: a janela entra direto.
- O login fica lembrado por 30 dias.

## Como usar

- **Mãos livres**: microfone aberto; a interface percebe quando a pessoa termina de falar.
- **Segurar espaço**: só ouve enquanto a pessoa segura Espaço ou o botão do microfone.
- A voz que responde é escolhida na lista **"Voz"** da janela. A tecla **F** liga o modo foco.

## Som ambiente (TV, vídeo, música)

No modo mãos livres o microfone capta o som ambiente e o transforma em pedidos. Se houver TV, vídeo ou música tocando, recomende **Segurar espaço**.

## Regras

- Responder em pt-BR, com passos curtos, na ordem do painel.
- Não inventar opções que não estão acima; se a pessoa perguntar algo fora disto, dizer que não sabe e sugerir o repositório newclaw-ivox.
