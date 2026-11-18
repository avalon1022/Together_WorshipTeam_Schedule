/**
 * 로컬 미리보기 서버 (설치 필요 없음): node test/devserver.js
 * - 데이터는 메모리에만 저장됩니다(끄면 사라짐).
 * - 카카오 로그인은 '가짜 카카오' 화면으로 대신합니다. 관리자 설정 코드는 SETUP-123 입니다.
 * - 브라우저에서 http://localhost:5050 을 여세요.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('../functions/config');
const { Store, MemoryAdapter } = require('../functions/src/store');
const { handle } = require('../functions/src/http');

const PORT = Number(process.env.PORT || 5050);
const users = {};
for (let i = 1; i <= 20; i++) users['c' + i] = { id: 9000 + i, nick: '테스트' + i };

const fakeFetch = async (url, opt) => {
  const R = (status, obj) => ({ ok: status < 300, status, json: async () => obj });
  if (url.includes('/oauth/token')) {
    const p = new URLSearchParams(opt.body); const u = users[p.get('code')];
    return u ? R(200, { access_token: 'AT_' + p.get('code') }) : R(400, { error_code: 'KOE320' });
  }
  const u = users[opt.headers.Authorization.replace('Bearer AT_', '')];
  return R(200, { id: u.id, kakao_account: { profile: { nickname: u.nick } } });
};
const calendarEvents = {};
let n = 0;
const env = {
  sessionSecret: 'dev-secret', sessionDays: 60, publicUrl: 'http://localhost:' + PORT, fetch: fakeFetch,
  kakao: { restKey: 'DEV', clientSecret: '', authBase: 'http://localhost:' + PORT + '/fake-kakao' },
  deps: {
    store: new Store(new MemoryAdapter()), config, kakaoReady: true, setupCode: 'SETUP-123',
    calendar: { async upsert(id, ev) { const k = id || 'ev' + (++n); calendarEvents[k] = ev; return k; }, async remove(id) { delete calendarEvents[id]; } },
    calendarLinks: { google: 'https://calendar.google.com/', ical: 'https://example.com/basic.ics' },
  },
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/fake-kakao/oauth/authorize') {
    const back = u.searchParams.get('redirect_uri'), state = u.searchParams.get('state');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(`<meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;padding:24px;background:#FEE500">
      <h2>가짜 카카오 로그인 (미리보기 전용)</h2><p>로그인할 계정을 고르세요.</p>` +
      Object.keys(users).slice(0, 8).map(c => `<p><a id="${c}" href="${back}?code=${c}&state=${encodeURIComponent(state)}">${users[c].nick}</a></p>`).join('') +
      `<p><a href="${back}?error=access_denied">취소</a></p></body>`);
  }
  if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/auth/')) {
    let raw = '';
    req.on('data', c => { raw += c; });
    await new Promise(r => req.on('end', r));
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch (e) { body = {}; }
    return handle(env, { method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, headers: req.headers }, res);
  }
  const file = path.join(__dirname, '..', 'public', u.pathname === '/' ? 'index.html' : path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(path.join(__dirname, '..', 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('없는 파일'); }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`미리보기: http://localhost:${PORT}  (관리자 설정 코드: SETUP-123)`));
