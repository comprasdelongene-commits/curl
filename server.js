'use strict';
// curl-runner — mini "Postman" self-hosted. Sem dependências externas.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY_STORE = 1024 * 1024; // 1 MB por resposta guardada
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS, 10) || 30000;

/* ---------------------------- Parser de curl ---------------------------- */

function tokenize(input) {
  // junta continuações de linha (\ + quebra de linha)
  const s = input.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ');
  const tokens = [];
  let cur = '', has = false, i = 0;
  const push = () => { if (has) tokens.push(cur); cur = ''; has = false; };
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { push(); i++; continue; }
    if (c === "'") {
      has = true; i++;
      while (i < s.length && s[i] !== "'") cur += s[i++];
      i++;
    } else if (c === '$' && s[i + 1] === "'") {
      has = true; i += 2;
      while (i < s.length && s[i] !== "'") {
        if (s[i] === '\\' && i + 1 < s.length) {
          const n = s[i + 1];
          const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', f: '\f', v: '\v' };
          if (n === 'x' && /^[0-9a-fA-F]{1,2}/.test(s.slice(i + 2, i + 4))) {
            const h = s.slice(i + 2, i + 4).match(/^[0-9a-fA-F]{1,2}/)[0];
            cur += String.fromCharCode(parseInt(h, 16)); i += 2 + h.length;
          } else if (n === 'u' && /^[0-9a-fA-F]{4}/.test(s.slice(i + 2, i + 6))) {
            cur += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16)); i += 6;
          } else if (n in map) { cur += map[n]; i += 2; }
          else { cur += n; i += 2; }
        } else cur += s[i++];
      }
      i++;
    } else if (c === '"') {
      has = true; i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) { cur += s[i + 1]; i += 2; }
        else if (s[i] === '\\' && s[i + 1] === '\n') { i += 2; }
        else cur += s[i++];
      }
      i++;
    } else if (c === '\\' && i + 1 < s.length) {
      has = true; cur += s[i + 1]; i += 2;
    } else { has = true; cur += c; i++; }
  }
  push();
  return tokens;
}

// opções que recebem valor
const LONG_WITH_VALUE = new Set([
  'request', 'header', 'data', 'data-raw', 'data-binary', 'data-ascii', 'data-urlencode', 'json',
  'user', 'url', 'user-agent', 'cookie', 'referer', 'form', 'output', 'max-time', 'connect-timeout',
  'proxy', 'cacert', 'cert', 'key', 'retry', 'write-out', 'upload-file', 'oauth2-bearer', 'resolve',
  'limit-rate', 'cookie-jar', 'range', 'max-redirs', 'proxy-user', 'dump-header', 'http-version', 'form-string',
]);
const SHORT_WITH_VALUE = new Set(['X', 'H', 'd', 'u', 'A', 'b', 'e', 'F', 'o', 'm', 'x', 'E', 'w', 'T', 'r', 'D', 'c', 'K']);
const SHORT_ALIAS = { X: 'request', H: 'header', d: 'data', u: 'user', A: 'user-agent', b: 'cookie', e: 'referer', F: 'form', G: 'get', I: 'head' };

function parseCurl(input) {
  const warnings = [];
  let tokens = tokenize(String(input || '').trim());
  if (!tokens.length) throw new Error('Cole um comando curl.');
  if (/^curl(\.exe)?$/i.test(tokens[0])) tokens.shift();
  else if (!tokens.some((t) => /^https?:\/\//i.test(t))) throw new Error('Isso não parece um comando curl.');

  let method = null, url = null, getMode = false, head = false;
  const headers = [];
  const dataParts = []; // {type, value}
  let user = null, json = false;
  const forms = [];

  const opts = [];
  const positional = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--') { positional.push(...tokens.slice(i + 1)); break; }
    if (t.startsWith('--')) {
      let name = t.slice(2), val;
      const eq = name.indexOf('=');
      if (eq >= 0) { val = name.slice(eq + 1); name = name.slice(0, eq); }
      if (LONG_WITH_VALUE.has(name) && val === undefined) val = tokens[++i];
      opts.push([name, val]);
    } else if (t.startsWith('-') && t.length > 1) {
      // flags curtas combinadas: -sSL, -XPOST, -H'x: y'
      for (let k = 1; k < t.length; k++) {
        const f = t[k];
        if (SHORT_WITH_VALUE.has(f)) {
          let val = t.slice(k + 1);
          if (!val) val = tokens[++i];
          opts.push([SHORT_ALIAS[f] || f, val]);
          break;
        } else opts.push([SHORT_ALIAS[f] || f, undefined]);
      }
    } else positional.push(t);
  }

  for (const [name, val] of opts) {
    switch (name) {
      case 'request': method = String(val || '').toUpperCase(); break;
      case 'header': {
        if (val == null) break;
        const idx = val.indexOf(':');
        if (idx > 0) headers.push({ name: val.slice(0, idx).trim(), value: val.slice(idx + 1).trim() });
        else if (val.endsWith(';')) { /* header vazio */ headers.push({ name: val.slice(0, -1).trim(), value: '' }); }
        break;
      }
      case 'data': case 'data-ascii': dataParts.push({ type: 'raw', value: (val || '').replace(/[\r\n]+/g, '') }); break;
      case 'data-raw': case 'data-binary': dataParts.push({ type: 'raw', value: val || '' }); break;
      case 'data-urlencode': {
        const v = val || '';
        const eq = v.indexOf('=');
        if (eq === 0) dataParts.push({ type: 'raw', value: encodeURIComponent(v.slice(1)) });
        else if (eq > 0) dataParts.push({ type: 'raw', value: v.slice(0, eq) + '=' + encodeURIComponent(v.slice(eq + 1)) });
        else dataParts.push({ type: 'raw', value: encodeURIComponent(v) });
        break;
      }
      case 'json': json = true; dataParts.push({ type: 'raw', value: val || '' }); break;
      case 'user': user = val; break;
      case 'url': url = val; break;
      case 'get': getMode = true; break;
      case 'head': head = true; break;
      case 'user-agent': headers.push({ name: 'User-Agent', value: val || '' }); break;
      case 'cookie': if (val && !/^[^=]*$/.test(val) ) headers.push({ name: 'Cookie', value: val }); break;
      case 'referer': headers.push({ name: 'Referer', value: val || '' }); break;
      case 'oauth2-bearer': headers.push({ name: 'Authorization', value: 'Bearer ' + val }); break;
      case 'form': case 'form-string': forms.push(val); break;
      case 'compressed': case 'silent': case 's': case 'S': case 'show-error': case 'L': case 'location':
      case 'v': case 'verbose': case 'i': case 'include': case 'k': case 'insecure': case 'fail': case 'f':
      case 'globoff': case 'g': case 'http1.1': case 'http2': case 'no-keepalive': case 'location-trusted':
        break;
      default: break;
    }
  }

  if (!url) url = positional.find((p) => p) || null;
  if (!url) throw new Error('URL não encontrada no comando curl.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = (/^localhost|^127\.|^\[::1\]/.test(url) ? 'http://' : 'https://') + url;

  let body = '';
  if (dataParts.length) body = dataParts.map((d) => d.value).join(json && dataParts.length === 1 ? '' : '&');
  if (forms.length) warnings.push('Upload multipart (-F) não é suportado; o campo foi ignorado.');

  const hasH = (n) => headers.some((h) => h.name.toLowerCase() === n);
  if (json) {
    if (!hasH('content-type')) headers.push({ name: 'Content-Type', value: 'application/json' });
    if (!hasH('accept')) headers.push({ name: 'Accept', value: 'application/json' });
  }
  if (user != null) {
    if (!hasH('authorization')) headers.push({ name: 'Authorization', value: 'Basic ' + Buffer.from(user.includes(':') ? user : user + ':').toString('base64') });
  }
  if (body && !hasH('content-type') && !getMode) headers.push({ name: 'Content-Type', value: 'application/x-www-form-urlencoded' });

  if (getMode && body) {
    url += (url.includes('?') ? '&' : '?') + body;
    body = '';
  }
  if (!method) method = head ? 'HEAD' : (body ? 'POST' : 'GET');
  if ((method === 'GET' || method === 'HEAD') && body) warnings.push(`O método ${method} não aceita corpo; o corpo será ignorado ao enviar.`);
  return { method, url, headers, body, warnings };
}

/* ------------------------------ Execução ------------------------------- */

async function executeRequest(req) {
  const method = String(req.method || 'GET').toUpperCase();
  let url;
  try { url = new URL(req.url); } catch { throw new Error('URL inválida: ' + req.url); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Apenas http e https são suportados.');
  const headers = new Headers();
  for (const h of req.headers || []) {
    if (!h.name || /^(content-length|host|connection|transfer-encoding)$/i.test(h.name)) continue;
    try { headers.append(h.name, h.value ?? ''); } catch { /* cabeçalho inválido */ }
  }
  const init = { method, headers, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (!['GET', 'HEAD'].includes(method) && req.body) init.body = req.body;

  const start = process.hrtime.bigint();
  let res, buf;
  try {
    res = await fetch(url, init);
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    const ms = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
    const cause = e && e.cause && (e.cause.code || e.cause.message);
    const msg = e.name === 'TimeoutError' ? `Tempo limite excedido (${TIMEOUT_MS / 1000}s).` : `Falha na requisição: ${cause || e.message}`;
    return { error: msg, status: 0, statusText: '', timeMs: ms, headers: [], body: '', size: 0 };
  }
  const timeMs = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
  const rh = [];
  res.headers.forEach((v, k) => rh.push({ name: k, value: v }));
  const ct = res.headers.get('content-type') || '';
  const isText = /text|json|xml|javascript|html|x-www-form|yaml|csv|svg/i.test(ct) || !ct || !buf.includes(0);
  let body = '', binary = false, truncated = false;
  if (!isText) {
    binary = true;
    body = `[conteúdo binário — ${buf.length} bytes, ${ct}]`;
  } else {
    let slice = buf;
    if (buf.length > MAX_BODY_STORE) { slice = buf.subarray(0, MAX_BODY_STORE); truncated = true; }
    body = slice.toString('utf8');
    if (/json/i.test(ct) || /^\s*[\[{]/.test(body)) {
      try { if (!truncated) body = JSON.stringify(JSON.parse(body), null, 2); } catch { /* mantém original */ }
    }
  }
  return { status: res.status, statusText: res.statusText, timeMs, headers: rh, body, size: buf.length, contentType: ct, binary, truncated, finalUrl: res.url };
}

/* ------------------------------ Autenticação ---------------------------- */

const PASSWORD = process.env.CURL_RUNNER_PASSWORD || '';
const SESSION_TTL = 7 * 24 * 3600 * 1000; // 7 dias
const SECRET = crypto.createHash('sha256').update('curl-runner|' + PASSWORD).digest();
const sha = (x) => crypto.createHash('sha256').update(String(x)).digest();
const checkPassword = (given) => crypto.timingSafeEqual(sha(given), sha(PASSWORD)); // tempo constante

function signSession(exp) {
  const nonce = crypto.randomBytes(8).toString('hex');
  const data = exp + '.' + nonce;
  return data + '.' + crypto.createHmac('sha256', SECRET).update(data).digest('hex');
}
function validSession(tok) {
  if (!tok) return false;
  const parts = tok.split('.');
  if (parts.length !== 3) return false;
  const data = parts[0] + '.' + parts[1];
  const mac = crypto.createHmac('sha256', SECRET).update(data).digest();
  let given; try { given = Buffer.from(parts[2], 'hex'); } catch { return false; }
  if (given.length !== mac.length || !crypto.timingSafeEqual(given, mac)) return false;
  return Number(parts[0]) > Date.now();
}
function getCookie(req, name) {
  const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}
const isAuthed = (req) => validSession(getCookie(req, 'cr_session'));
const clientIp = (req) => {
  const ra = req.socket.remoteAddress || '';
  const loop = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
    void loop; // atrás do proxy da Render: confia em X-Forwarded-For / CF-Connecting-IP
  return req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || ra;
};

// limitação de tentativas de login: por IP (5 falhas → bloqueio crescente) e global
const fails = new Map(); // ip -> {n, until, strikes}
const globalFails = [];
const LIMIT_PER_IP = 5, GLOBAL_LIMIT = 30, WINDOW = 15 * 60 * 1000;
function lockedFor(ip) {
  const now = Date.now();
  while (globalFails.length && globalFails[0] < now - WINDOW) globalFails.shift();
  if (globalFails.length >= GLOBAL_LIMIT) return Math.ceil((globalFails[0] + WINDOW - now) / 1000);
  const f = fails.get(ip);
  return f && f.until > now ? Math.ceil((f.until - now) / 1000) : 0;
}
function registerFail(ip) {
  const f = fails.get(ip) || { n: 0, until: 0, strikes: 0 };
  f.n++; globalFails.push(Date.now());
  if (f.n >= LIMIT_PER_IP) { f.strikes++; f.n = 0; f.until = Date.now() + Math.min(WINDOW * 2 ** (f.strikes - 1), 24 * 3600 * 1000); }
  fails.set(ip, f);
}
setInterval(() => { const now = Date.now(); for (const [k, v] of fails) if (v.until < now && v.n === 0 && v.strikes === 0) fails.delete(k); }, 600000).unref();

function loginPage(msg) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>curl-runner — Entrar</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d1117;color:#e6edf3;font:16px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px}
form{background:#161b22;border:1px solid #2a3340;border-radius:14px;padding:26px;width:100%;max-width:360px}h1{margin:0 0 4px;font-size:20px}h1 span{color:#4f9cff}p{color:#8b98a8;margin:0 0 18px;font-size:14px}
input{width:100%;background:#0b0f14;color:#e6edf3;border:1px solid #2a3340;border-radius:10px;padding:13px;font-size:16px;outline:none}input:focus{border-color:#4f9cff}
button{width:100%;margin-top:12px;background:#2f6fd0;color:#fff;border:0;border-radius:10px;padding:13px;font-size:16px;font-weight:600}.e{background:#2d1517;border:1px solid #6b2226;color:#ff8b85;border-radius:8px;padding:8px 12px;margin-bottom:12px;font-size:14px}</style></head>
<body><form method="POST" action="/login"><h1>curl<span>-runner</span></h1><p>Digite a senha para continuar.</p>${msg ? '<div class="e">' + msg + '</div>' : ''}
<input type="password" name="password" placeholder="Senha" autocomplete="current-password" autofocus required><button type="submit">Entrar</button></form></body></html>`;
}
function readForm(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 4096) { reject(new Error('grande')); req.destroy(); } });
    req.on('end', () => resolve(new URLSearchParams(d)));
    req.on('error', reject);
  });
}
async function handleAuthRoutes(req, res, p) {
  const secure = (req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
  if (p === '/login' && req.method === 'GET') {
    if (isAuthed(req)) { res.writeHead(302, { Location: '/' }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(loginPage(''));
  }
  if (p === '/login' && req.method === 'POST') {
    const ip = clientIp(req);
    const wait = lockedFor(ip);
    const page = (code, m) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(loginPage(m)); };
    if (wait) { res.setHeader('Retry-After', wait); return page(429, 'Muitas tentativas. Tente novamente em ' + Math.ceil(wait / 60) + ' min.'); }
    const form = await readForm(req);
    if (checkPassword(form.get('password') || '')) {
      fails.delete(ip);
      res.writeHead(302, { Location: '/', 'Set-Cookie': `cr_session=${signSession(Date.now() + SESSION_TTL)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}${secure}`, 'Cache-Control': 'no-store' });
      return res.end();
    }
    registerFail(ip);
    await new Promise((r) => setTimeout(r, 800)); // atrasa tentativas erradas
    return page(401, 'Senha incorreta.');
  }
  if (p === '/logout') {
    res.writeHead(302, { Location: '/login', 'Set-Cookie': `cr_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}` });
    return res.end();
  }
  return false;
}

/* --------------------------------- HTTP --------------------------------- */

const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(b); };
function readJson(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 10 * 1024 * 1024) { reject(new Error('Corpo muito grande')); req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { reject(new Error('JSON inválido')); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (p === '/login' || p === '/logout') { if ((await handleAuthRoutes(req, res, p)) !== false) return; }
    if (!isAuthed(req)) {
      if (p.startsWith('/api/')) return send(res, 401, { error: 'Não autenticado.' });
      res.writeHead(302, { Location: '/login' }); return res.end();
    }
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
    }
    if (p.startsWith('/api/')) {
      if (req.method === 'POST' && p === '/api/parse') {
        const { curl } = await readJson(req);
        try { return send(res, 200, parseCurl(curl)); } catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (req.method === 'POST' && p === '/api/send') {
        const { request } = await readJson(req);
        if (!request || !request.url) return send(res, 400, { error: 'Requisição inválida.' });
        return send(res, 200, { response: await executeRequest(request) });
      }
      return send(res, 404, { error: 'Rota não encontrada.' });
    }
    res.writeHead(404); res.end('Não encontrado');
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
});

if (require.main === module) {
  if (!PASSWORD) { console.error('Defina a variável de ambiente CURL_RUNNER_PASSWORD antes de iniciar.'); process.exit(1); }
  server.listen(PORT, HOST, () => console.log(`curl-runner rodando em ${HOST}:${PORT}`));
}
module.exports = { parseCurl, tokenize };
