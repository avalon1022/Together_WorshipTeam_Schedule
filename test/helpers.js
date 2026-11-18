// 시험용: 메모리 저장소 + 가짜 카카오 + 가짜 구글 캘린더로 서버를 띄웁니다.
'use strict';
const config = require('../functions/config');
const { Store, MemoryAdapter } = require('../functions/src/store');
const { handle } = require('../functions/src/http');

function fakeKakao(users) {
  return async (url, opt) => {
    const R = (status, obj) => ({ ok: status < 300, status, json: async () => obj });
    if (url.includes('/oauth/token')) {
      const p = new URLSearchParams(opt.body);
      const u = users[p.get('code')];
      if (!u) return R(400, { error: 'invalid_grant', error_code: 'KOE320' });
      if (!p.get('redirect_uri').endsWith('/auth/kakao/callback')) return R(400, { error_code: 'KOE006' });
      return R(200, { access_token: 'AT_' + p.get('code') });
    }
    if (url.includes('/v2/user/me')) {
      const u = users[opt.headers.Authorization.replace('Bearer AT_', '')];
      return R(200, { id: u.id, kakao_account: { profile: { nickname: u.nick } } });
    }
    return R(404, {});
  };
}

function fakeCalendar() {
  const events = {}; let n = 0; const log = [];
  return {
    events, log,
    async upsert(id, ev) { if (id && events[id]) { events[id] = ev; log.push('upd'); return id; } const k = 'ev' + (++n); events[k] = ev; log.push('new'); return k; },
    async remove(id) { delete events[id]; log.push('del'); },
  };
}

function makeServer(opts) {
  opts = opts || {};
  const adapter = new MemoryAdapter();
  const store = new Store(adapter);
  const calendar = opts.noCalendar ? null : fakeCalendar();
  const env = {
    sessionSecret: 'test-secret', sessionDays: 60, publicUrl: opts.publicUrl || 'https://test.example',
    fetch: fakeKakao(opts.kakaoUsers || {}),
    kakao: { restKey: 'RESTKEY', clientSecret: 'CS' },
    deps: { store, config, kakaoReady: true, setupCode: 'SETUP-123', calendar,
      calendarLinks: calendar ? { google: 'https://calendar.google.com/x', ical: 'https://x/ical' } : null },
  };
  async function call(method, path, { body, cookie, headers } = {}) {
    const [p, qs] = path.split('?');
    const req = { method, path: p, query: Object.fromEntries(new URLSearchParams(qs || '')), body: body || {},
      headers: Object.assign({ cookie: cookie || '', 'x-requested-with': 'fetch' }, headers || {}) };
    const out = { headers: {} };
    const res = { statusCode: 200, setHeader(k, v) { out.headers[k.toLowerCase()] = v; }, end(b) { out.body = b; } };
    await handle(env, req, res);
    out.status = res.statusCode;
    try { out.json = JSON.parse(out.body || 'null'); } catch (e) { out.json = null; }
    return out;
  }
  // 카카오 로그인 전체 흐름 → 쿠키
  async function login(code) {
    const start = await call('GET', '/auth/kakao/login');
    const state = decodeURIComponent(start.headers.location.split('state=')[1]);
    const cb = await call('GET', `/auth/kakao/callback?code=${code}&state=${encodeURIComponent(state)}`);
    const sc = cb.headers['set-cookie'] || '';
    return { cookie: sc.split(';')[0], location: cb.headers.location };
  }
  return { env, store, adapter, calendar, call, login };
}

let failed = 0, passed = 0;
function ok(c, m) { if (c) { passed++; console.log('ok  ', m); } else { failed++; console.log('FAIL', m); } }
function summary() { console.log(`\n${passed} passed, ${failed} failed`); if (failed) process.exitCode = 1; }
module.exports = { makeServer, ok, summary };
