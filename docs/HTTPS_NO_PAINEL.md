# HTTPS no painel

## Por quê

O navegador só libera o microfone (o ditado do chat) e outras APIs em **página segura**: HTTPS ou `localhost`. Aberto
pela rede em `http://<ip>:3090`, o ditado recebe `not-allowed`.

## Como funciona

Com as duas variáveis abaixo no `.env`, o painel atende a rede em **HTTPS** na `DASHBOARD_HTTPS_PORT` (padrão `3443`).
O HTTP da `DASHBOARD_PORT` passa a escutar **só em `127.0.0.1`**, porque as ferramentas locais (`newclaw update`,
`newclaw doctor`, troca de senha pelo CLI) usam esse endereço. Pela rede, só existe HTTPS.

```ini
DASHBOARD_HOST=0.0.0.0
DASHBOARD_TLS_CERT=/caminho/painel.crt
DASHBOARD_TLS_KEY=/caminho/painel.key
DASHBOARD_HTTPS_PORT=3443
```

Sem as duas variáveis, nada muda. Se faltar uma delas, ou se o arquivo não puder ser lido, o boot para com o motivo. O
cookie de sessão ganha `Secure` quando o login vem pelo HTTPS.

## Certificado para uma rede de casa (autoridade local)

Um certificado de uma autoridade pública exige um domínio. Numa rede local, o caminho é criar uma **autoridade local**,
emitir com ela o certificado do servidor e instalar a autoridade (só o `.crt`, nunca a chave) em cada aparelho que for
abrir o painel.

Com `openssl` (vem com o Git no Windows e com o Linux e o macOS). Troque `192.0.2.10` pelo IP do seu servidor:

```bash
# 1. Autoridade local (guarde autoridade-local.key em lugar privado: quem a tem emite certificados aceitos pelos seus aparelhos)
openssl req -x509 -newkey rsa:3072 -sha256 -days 3650 -nodes -keyout autoridade-local.key -out autoridade-local.crt \
  -subj "/CN=Autoridade local" -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign"

# 2. Certificado do servidor, válido para o IP dele (825 dias: o limite que o macOS e o iOS aceitam)
openssl req -newkey rsa:2048 -sha256 -nodes -keyout painel.key -out painel.csr -subj "/CN=192.0.2.10"
printf "basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:192.0.2.10,IP:127.0.0.1,DNS:localhost\n" > painel.ext
openssl x509 -req -in painel.csr -CA autoridade-local.crt -CAkey autoridade-local.key -CAcreateserial -out painel.crt -days 825 -sha256 -extfile painel.ext
```

No Windows (Git Bash), comece cada comando com `MSYS_NO_PATHCONV=1`. Sem isso, o `-subj "/CN=…"` vira um caminho de
arquivo.

Copie `painel.crt` e `painel.key` para o servidor, aponte as variáveis para eles e reinicie o NewClaw.

## Instalar a autoridade nos aparelhos

Cada pessoa instala no próprio aparelho, e só o `autoridade-local.crt`:

| Aparelho | Como |
|---|---|
| Windows (Chrome, Edge) | dois cliques no `autoridade-local.crt` → **Instalar certificado** → **Usuário atual** → **Colocar todos os certificados no repositório a seguir** → **Autoridades de Certificação Raiz Confiáveis** → concluir; reabra o navegador |
| Firefox | Configurações → Privacidade e Segurança → Certificados → **Ver certificados** → Autoridades → **Importar** → marcar "Confiar para identificar sites" |
| Android | Configurações → Segurança → Criptografia e credenciais → **Instalar um certificado** → Certificado de CA |
| iPhone / iPad | abrir o `.crt` (AirDrop ou e-mail) → Ajustes → Perfil baixado → Instalar; depois Ajustes → Geral → Sobre → **Confiança de Certificados** → ligar a autoridade |
| Linux | `sudo cp autoridade-local.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates` (o Chrome no Linux usa o próprio repositório: Configurações → Privacidade → Gerenciar certificados → Autoridades → Importar) |

Depois, abra o painel em `https://<ip>:3443`. O cadeado aparece e o microfone volta a funcionar.

## Limitações

- O certificado vale para os nomes e IPs listados em `subjectAltName`. Se o IP do servidor mudar, emita outro com a mesma
  autoridade.
- Ele vence em 825 dias. Renovar é repetir o passo 2 e reiniciar; a autoridade (10 anos) continua instalada.
- `curl` no Windows (Schannel) tenta consultar a revogação do certificado e falha com autoridade local. Para testar pela
  linha de comando no Windows, use `curl --ssl-no-revoke --cacert autoridade-local.crt …`.
