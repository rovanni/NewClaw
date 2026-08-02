# Política de Segurança

> **Language / Idioma:**
> 🇺🇸 [English](SECURITY.md) | 🇧🇷 **Português** | 🇪🇸 [Español](SECURITY.es.md)

## Como relatar uma vulnerabilidade

**Não abra uma issue pública para problemas de segurança.** Um relato público avisa todo mundo
que roda o NewClaw sobre a falha antes de existir correção — inclusive quem a exploraria.

Relate em privado pelo GitHub Security Advisories:

**https://github.com/rovanni/NewClaw/security/advisories/new**

Isso cria uma conversa privada, visível só para você e para quem mantém o projeto.

Se não conseguir usar esse formulário, abra uma issue dizendo apenas que tem um relato de
segurança para enviar — sem nenhum detalhe técnico — e aguarde o contato.

### O que ajuda no relato

- O que um atacante consegue fazer (ler arquivos, burlar autenticação, executar comandos…)
- Passos para reproduzir, ou uma prova de conceito mínima
- Versão afetada (`package.json` → `version`) e sistema operacional
- Sua configuração, **sem os segredos** — remova chaves de API, tokens, senhas e caminhos pessoais

### O que esperar

Este é um projeto mantido por voluntários, sem equipe paga de segurança, então não há prazo de
resposta garantido. O que se promete: os relatos são lidos, vulnerabilidades confirmadas são
corrigidas e publicadas como advisory, e o crédito vai para quem relatou — a menos que você
prefira o contrário.

## Versões com suporte

As correções entram no branch `main`. Não há suporte de longo prazo para versões antigas: a
recomendação é rodar sempre a última versão publicada.

| Versão | Com suporte |
|---|---|
| 2.x | ✅ |
| < 2.0 | ❌ |

## Onde o NewClaw lida com dados sensíveis

Útil para quem for auditar o projeto, e para quem o executa:

- **`.env`** — guarda chaves de API, tokens dos canais e a senha do dashboard. Nunca é versionado
  (está no `.gitignore`); o `.env.example` traz apenas campos vazios.
- **Dashboard web** — escuta em `127.0.0.1` por padrão. Expor na rede (`DASHBOARD_HOST=0.0.0.0`)
  **exige** definir `DASHBOARD_PASSWORD`; sem ela, `/api/*` fica aberto a quem alcançar a porta.
- **Execução de comandos** — o agente executa comandos do sistema através de suas ferramentas.
  Padrões destrutivos são bloqueados sem exceção, e ações perigosas exigem aprovação explícita no
  modo SAFE. Quem governa isso é o modo de capacidade: elevá-lo amplia o que roda sem perguntar.
- **Servidores de modelo local** — carregar um modelo pelo dashboard executa um binário
  encontrado na pasta que *você* configurou. Do navegador viaja apenas o nome do arquivo, checado
  contra a listagem real da pasta; o executável e os argumentos são resolvidos no servidor.
- **Memória de conversas** — fica num banco SQLite local (`data/`), sem criptografia. Quem tiver
  acesso ao sistema de arquivos da máquina consegue ler.

## Advisories conhecidos

Os advisories publicados ficam em
[github.com/rovanni/NewClaw/security/advisories](https://github.com/rovanni/NewClaw/security/advisories).

Cada vulnerabilidade corrigida tem um teste de regressão que falha caso a falha volte — por
exemplo `S129_DashboardAuth_GHSA_jpx8_29mp_v4hw`, que cobre o GHSA-jpx8-29mp-v4hw (tokens de
autenticação assinados com chave HMAC vazia). Verificar uma correção é rodar a suíte:

```bash
npm run test:regression
```
