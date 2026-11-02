# curl-runner (versão Render)

Mini "Postman": cole um comando `curl`, edite, envie pelo servidor (sem CORS) e veja a resposta.

Nesta versão o **histórico fica no `localStorage` do navegador** (máx. 500 itens; o servidor não guarda nada), por isso funciona bem no plano gratuito da Render, que tem disco efêmero. O servidor só faz **autenticação + proxy**. O histórico é por navegador/dispositivo.

## Variáveis de ambiente

| Variável | Descrição |
|---|---|
| `CURL_RUNNER_PASSWORD` | **Obrigatória.** Senha de acesso. O servidor não inicia sem ela. |
| `PORT` | Porta (a Render define automaticamente). Padrão 3000. |
| `HOST` | Padrão `0.0.0.0`. |
| `TIMEOUT_MS` | Tempo limite de cada requisição (padrão 30000). |

## Rodar localmente

```bash
CURL_RUNNER_PASSWORD='sua-senha-forte' PORT=3000 node server.js
```

## Deploy na Render

1. Suba este repositório para um Git (GitHub/GitLab/Bitbucket) ou use a opção de repositório público.
2. Na Render: **New → Blueprint** (usa `render.yaml`) ou **New → Web Service** com build `npm install` e start `npm start`.
3. Defina `CURL_RUNNER_PASSWORD` em *Environment*. Use uma senha longa.
4. Acesse a URL `https://<nome>.onrender.com` e faça login.

No plano gratuito o serviço "dorme" após ~15 min sem uso e leva alguns segundos para acordar.

## Segurança

- Todas as rotas (página e API) exigem login; cookie `httpOnly`, `SameSite=Strict`, `Secure` via HTTPS (usa `X-Forwarded-Proto`), 7 dias. `/logout` encerra.
- Tentativas erradas limitadas: 5 por IP (bloqueio crescente) e 30 no total por 15 min. O IP vem de `X-Forwarded-For`/`CF-Connecting-IP`.
- O servidor faz requisições para qualquer URL informada (inclusive rede interna do host). Mantenha a senha forte e não compartilhe o acesso.
- `/healthz` é público (retorna `ok`) para o health check da Render.

## Arquivos

`server.js` (auth + parser + proxy), `index.html` (UI), `package.json`, `render.yaml`, `test-parser.js` (`npm test`).
