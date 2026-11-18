/**
 * 로그인 표(세션)와 카카오 로그인
 * - 세션은 서명된 문자열을 __session 쿠키(HttpOnly)에 담습니다. Firebase Hosting은 이 이름의 쿠키만 함수로 넘겨줍니다.
 * - 카카오 토큰은 저장하지 않고, 회원번호만 확인합니다.
 */
'use strict';

const crypto = require('crypto');
const { UserError } = require('./logic');

const COOKIE = '__session';
const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sign = (secret, text) => b64url(crypto.createHmac('sha256', secret).update(text).digest());
const nowSec = () => Math.floor(Date.now() / 1000);
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function makeSession(secret, kakaoId, days) {
  const t = 'k.' + kakaoId + '.' + (nowSec() + days * 86400);
  return t + '.' + sign(secret, t);
}
// 쿠키 → 카카오 회원번호 (없거나 잘못되면 null)
function readSession(secret, cookieHeader) {
  const m = String(cookieHeader || '').split(/;\s*/).find(c => c.startsWith(COOKIE + '='));
  if (!m) return null;
  const token = decodeURIComponent(m.slice(COOKIE.length + 1));
  const p = token.split('.');
  if (p.length !== 4 || p[0] !== 'k' || !/^\d{1,20}$/.test(p[1])) return null;
  if (!safeEq(sign(secret, p.slice(0, 3).join('.')), p[3]) || Number(p[2]) < nowSec()) return null;
  return { kakaoId: p[1] };
}
function sessionCookie(token, days, secure) {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${days * 86400}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}
function clearCookie(secure) { return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`; }

function makeState(secret) { const t = 's.' + nowSec() + '.' + crypto.randomBytes(6).toString('hex'); return t + '.' + sign(secret, t); }
function checkState(secret, state) {
  const p = String(state || '').split('.');
  if (p.length !== 4 || !safeEq(sign(secret, p.slice(0, 3).join('.')), p[3])) throw new UserError('로그인 요청이 올바르지 않아요. 다시 시도해 주세요.');
  if (nowSec() - Number(p[1]) > 1800) throw new UserError('로그인 시간이 지났어요. 다시 시도해 주세요.');
}

function kakaoAuthUrl({ restKey, redirectUri, state, base }) {
  return (base || 'https://kauth.kakao.com') + '/oauth/authorize?response_type=code' +
    '&client_id=' + encodeURIComponent(restKey) + '&redirect_uri=' + encodeURIComponent(redirectUri) +
    '&state=' + encodeURIComponent(state);
}

// 인가 코드 → { kakaoId, nickname }
async function kakaoExchange({ fetch, restKey, clientSecret, redirectUri, code }) {
  const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: restKey, redirect_uri: redirectUri, code: String(code) });
  if (clientSecret) body.set('client_secret', clientSecret);
  const res = await fetch('https://kauth.kakao.com/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' }, body: body.toString(),
  });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.access_token) {
    const why = tok.error_code === 'KOE320' ? '로그인 코드가 이미 사용됐어요. 다시 로그인해 주세요.'
      : tok.error_code === 'KOE006' ? 'Redirect URI가 카카오 앱 설정과 달라요. 관리자에게 알려 주세요.'
      : tok.error_code === 'KOE010' ? '카카오 Client Secret 설정이 맞지 않아요. 관리자에게 알려 주세요.'
      : (tok.error_description || tok.error || '응답 오류');
    throw new UserError('카카오 로그인에 실패했어요: ' + why);
  }
  const me = await fetch('https://kapi.kakao.com/v2/user/me', { headers: { Authorization: 'Bearer ' + tok.access_token } });
  const info = await me.json().catch(() => ({}));
  if (!me.ok || !info.id) throw new UserError('카카오 회원 정보를 가져오지 못했어요.');
  const nick = ((info.kakao_account || {}).profile || {}).nickname || (info.properties || {}).nickname || '';
  return { kakaoId: String(info.id), nickname: String(nick).slice(0, 20) };
}

module.exports = { COOKIE, makeSession, readSession, sessionCookie, clearCookie, makeState, checkState, kakaoAuthUrl, kakaoExchange, safeEq };
