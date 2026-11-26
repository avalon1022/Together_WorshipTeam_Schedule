/**
 * 주소별 처리 (Firebase Functions와 로컬 미리보기 서버가 함께 씁니다)
 *
 *   GET  /auth/kakao/login            카카오 로그인 페이지로 이동
 *   GET  /auth/kakao/callback         카카오가 돌려보내는 주소 → 로그인 쿠키 발급
 *   GET  /api/view?month=YYYY-MM      화면 데이터 (로그인했으면 내 정보·관리자 정보 포함)
 *   POST /api/logout
 *   POST /api/mine/save | /api/mine/link
 *   POST /api/setup                   첫 전체 관리자 설정
 *   POST /api/push/subscribe | unsubscribe | test | prefs   푸시 알림
 *   POST /api/admin/<작업>
 *
 * env = { deps, sessionSecret, kakao: { restKey, clientSecret }, fetch, publicUrl, sessionDays }
 */
'use strict';

const A = require('./auth');
const S = require('./service');
const { UserError } = require('./logic');

const STATUS = { bad_request: 400, login_required: 401, forbidden: 403, not_found: 404 };

function baseUrl(env, req) {
  if (env.publicUrl) return env.publicUrl.replace(/\/+$/, '');
  const h = req.headers || {};
  const host = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim();
  const proto = String(h['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return proto + '://' + host;
}

function send(res, status, obj, extraHeaders) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  Object.entries(extraHeaders || {}).forEach(([k, v]) => res.setHeader(k, v));
  res.end(JSON.stringify(obj));
}
function redirect(res, url, extraHeaders) {
  res.statusCode = 302;
  res.setHeader('Location', url);
  res.setHeader('Cache-Control', 'private, no-store');
  Object.entries(extraHeaders || {}).forEach(([k, v]) => res.setHeader(k, v));
  res.end();
}

async function handle(env, req, res) {
  const path = (req.path || req.url || '/').split('?')[0];
  const method = req.method || 'GET';
  const query = req.query || {};
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const secure = baseUrl(env, req).startsWith('https://');
  const auth = A.readSession(env.sessionSecret, (req.headers || {}).cookie);
  const { deps } = env;

  try {
    await S.migrate(deps);
    // ---------- 카카오 로그인 ----------
    if (method === 'GET' && path === '/auth/kakao/login') {
      if (!env.kakao.restKey) return redirect(res, '/?login_error=' + encodeURIComponent('카카오 로그인이 아직 설정되지 않았어요.'));
      return redirect(res, A.kakaoAuthUrl({
        restKey: env.kakao.restKey, redirectUri: baseUrl(env, req) + '/auth/kakao/callback', state: A.makeState(env.sessionSecret), base: env.kakao.authBase,
      }));
    }
    if (method === 'GET' && path === '/auth/kakao/callback') {
      try {
        if (query.error) throw new UserError(query.error === 'access_denied' ? '카카오 로그인을 취소했어요.' : '카카오 로그인에 실패했어요: ' + (query.error_description || query.error));
        A.checkState(env.sessionSecret, query.state);
        const who = await A.kakaoExchange({
          fetch: env.fetch, restKey: env.kakao.restKey, clientSecret: env.kakao.clientSecret,
          redirectUri: baseUrl(env, req) + '/auth/kakao/callback', code: query.code,
        });
        await S.recordLogin(deps, who.kakaoId, who.nickname);
        const token = A.makeSession(env.sessionSecret, who.kakaoId, env.sessionDays);
        return redirect(res, '/?login=ok', { 'Set-Cookie': A.sessionCookie(token, env.sessionDays, secure) });
      } catch (e) {
        const msg = e instanceof UserError ? e.message : '카카오 로그인 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.';
        if (!(e instanceof UserError)) console.error(e);
        return redirect(res, '/?login_error=' + encodeURIComponent(msg));
      }
    }

    // ---------- 화면 데이터 ----------
    if (method === 'GET' && path === '/api/view') return send(res, 200, await S.view(deps, auth, query));

    if (method !== 'POST' || !path.startsWith('/api/')) return send(res, 404, { error: '없는 주소예요.' });
    // 다른 사이트에서 몰래 보내는 요청을 막기 위해, 이 앱의 화면만 붙이는 머리글을 확인합니다.
    if ((req.headers || {})['x-requested-with'] !== 'fetch') return send(res, 403, { error: '허용되지 않은 요청이에요.' });

    if (path === '/api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': A.clearCookie(secure) });
    if (path === '/api/mine/save') return send(res, 200, await S.saveMine(deps, auth, body));
    if (path === '/api/mine/link') return send(res, 200, await S.linkMine(deps, auth, body));
    if (path === '/api/mine/app') return send(res, 200, await S.markApp(deps, auth));
    if (path === '/api/setup') return send(res, 200, await S.setup(deps, auth, body));
    if (path === '/api/push/subscribe') return send(res, 200, await S.pushSubscribe(deps, auth, body));
    if (path === '/api/push/unsubscribe') return send(res, 200, await S.pushUnsubscribe(deps, auth, body));
    if (path === '/api/push/test') return send(res, 200, await S.pushTest(deps, auth, body));
    if (path === '/api/push/prefs') return send(res, 200, await S.pushPrefs(deps, auth, body));
    const m = path.match(/^\/api\/admin\/([A-Za-z]+)$/);
    if (m) return send(res, 200, await S.adminAction(deps, auth, m[1], body));
    return send(res, 404, { error: '없는 주소예요.' });
  } catch (e) {
    if (e instanceof UserError) return send(res, STATUS[e.code] || 400, { error: e.message, code: e.code });
    console.error(e);
    return send(res, 500, { error: '서버에서 문제가 생겼어요. 잠시 후 다시 시도해 주세요.' });
  }
}

module.exports = { handle };
