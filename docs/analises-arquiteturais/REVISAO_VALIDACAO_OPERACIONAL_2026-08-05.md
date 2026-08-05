# Revisão da validação operacional — o que ficou aberto e o que priorizar

> Fecha o ciclo de validação operacional de 03-05/08/2026 (Sprint G da RFC-003, sprints de
> correção 1-6, e o teste de uso como usuário leigo). Objetivo: colocar as dívidas descobertas
> lado a lado, com custo e risco, para decidir o que entra na próxima baseline. **Documento de
> apoio à decisão — não decide nada.**

## 1. O padrão que atravessa quase tudo

Dos nove defeitos corrigidos neste ciclo, **oito apareceram na integração entre componentes**, não
dentro deles. Cada módulo estava correto isolado; o que quebrava era a política de um contradizendo
a do outro:

| Defeito | Política A | Política B (que venceu, errado) |
|---|---|---|
| Modelo local lento tratado como morto | turno podia esperar 197s | teto de 15s do provider |
| Modo SAFE sem gate no caminho de goal | "SAFE exige confirmação" | despacho direto de step |
| Gate ausente em 3 outros despachantes | ADR-005 "os dois caminhos" | eram cinco |
| Imagem nunca chegava ao modelo | formato interno `images` | API OpenAI espera em `content` |
| Identidade de conversa duplicando prefixo | servidor: `canal:usuário` | painel devolvia o id composto |
| `fixAttempt` gravando diagnóstico | "primeiro sucesso após blocker" | `where` não instala nada |
| Dois provedores no mesmo endereço | painel avisava | motor tratava como fallback real |
| Saúde do provedor nunca atualizava | UI pedia `forceRefresh` | parâmetro morria no caminho |

Nenhum deles seria encontrado por teste unitário: todos exigiram o sistema rodando de verdade. O
único achado "de dentro de um componente" foi o layout da tela de Memória.

**Consequência prática para a próxima baseline:** revisão de fronteira (quem decide o quê, com que
informação) tem rendido mais que revisão de módulo. Vale continuar por aí.

## 2. Dívidas abertas, por custo e risco

### Alta prioridade — atinge usuário real hoje

| # | Dívida | Custo | Risco de não fazer |
|---|---|---|---|
| 019 | Componentes internos com modelo de nuvem como padrão fixo | **Médio.** Decidir o padrão (herdar da categoria? usar o que o provedor serve?) + tocar 5 arquivos | Instalação só-local pede modelo inexistente e falha no meio do turno, sem erro claro. Foi o que o operador viveu por dias |
| 020 | Laço de entrega repete o comando que falha | **Baixo-médio.** Decidir limite por tentativa idêntica + o que dizer ao desistir | Usuário espera 10 min e recebe timeout genérico, com o arquivo intermediário pronto e não entregue |

### Média — degrada experiência, não impede uso

| # | Dívida | Custo | Risco de não fazer |
|---|---|---|---|
| 018 | Texto do Core só em português (~280 ocorrências) | **Alto.** Precisa mapear usuário×operador, decidir origem do idioma por camada, e testar 3 idiomas sem triplicar suíte | Projeto se anuncia em 3 idiomas e fala 1 em toda falha. Se o público é lusófono, é dívida consciente |
| — | Rótulo "extraído via vision" afirma fidelidade de algo que é geração | **Baixo.** Mudar o texto; decidir como comunicar incerteza | Usuário confia em OCR alucinado. Mitigado agora que a imagem chega ao modelo, mas não eliminado |
| 001 | Escolha inconsistente de tool pelo LLM (~2 em 10, abril) | **Alto.** Sem repro atual — é investigação, não conserto | Pode já ter sido resolvido por outras mudanças. Corrigir sem reproduzir é chute |

### Baixa — não atinge usuário

| # | Dívida | Custo | Risco |
|---|---|---|---|
| 014 | Model Registry, fatias 2-4 | Alto (design próprio) | Nenhum — funcionalidade ausente, não defeito |
| 017 | Contratos declarativos por tool | Alto | Nenhum hoje; gatilhos já definidos no próprio arquivo |
| 013 | CVEs dev-only do add-in PowerPoint | Baixo | Superfície dev-only; decisão de aceitar risco |
| — | ADR-003 §5.5 — causalidade do comando aprendido | Alto (indecidível no geral) | Conhecimento aprendido pode creditar o comando errado. ADR-004 removeu a classe observada |

### Bloqueadas por ambiente, não por trabalho

| Dívida | O que falta |
|---|---|
| Anexos em WhatsApp e Signal | Sessão real dos dois canais para validar. O código é conhecido (Baileys `downloadMediaMessage`; Signal grava o anexo em disco) |
| ADR-002 em Linux/macOS | Máquina não-Windows. Escrito para os três, verificado em um |

## 3. O que este ciclo entregou

Nove correções, todas validadas em execução real, não só em teste:

* modelo local lento deixa de ser confundido com provider morto (`S191`);
* imagem chega ao modelo em provider compatível com OpenAI — visão estava cega fora do Ollama (`S192`);
* gate de ação perigosa vale em todos os despachantes (`ADR-005` §5.1, `S188`);
* modo SAFE passa a valer no caminho de goal (`ADR-005`, `S188`);
* Dashboard aprova ação perigosa como os outros canais (`S187`);
* identidade de conversa deixa de duplicar prefixo (`S189`);
* comando de diagnóstico não vira conhecimento operacional (`ADR-004`, `S142`);
* aprendizado operacional deixa de depender do ramo de código (`ADR-003`, `S158`);
* saúde do provedor atualiza após carregar modelo; dois rótulos no mesmo endereço deixam de ser
  dois fallbacks (`S190`).

Mais higiene: suíte fecha verde em qualquer máquina (`S37` declara SKIP em vez de falhar por
ambiente), zero vulnerabilidades de dependência nos dois manifests, barrel e módulo mortos
removidos, i18n dos toasts restantes, tela de Memória sem estouro de layout.

**Suíte: 192/192.** Era 155-156/157 no início do ciclo, com duas falhas crônicas de ambiente.

## 4. Recomendação (para você decidir)

Se a próxima baseline é sobre **confiabilidade do uso local** — que é o cenário do operador —, a
ordem que faz sentido é `019` → `020`, ambas com escopo fechado e efeito imediato no que quebra
hoje. A `018` é a maior e a menos urgente: só vira prioridade quando houver usuário não-lusófono
real.

O que eu **não** recomendaria abrir agora: `001` (sem repro), `014`/`017` (funcionalidade, não
defeito) e a causalidade da `ADR-003` (problema aberto de verdade, sem solução conhecida barata).
