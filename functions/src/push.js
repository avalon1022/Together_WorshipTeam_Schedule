/**
 * 관리자 푸시 알림 (표준 웹 푸시, VAPID)
 * - 비밀 값은 VAPID 개인 키 하나만 등록하고, 공개 키는 여기서 계산합니다.
 * - 실제 발송은 index.js에서 web-push 라이브러리로 하고, 시험에서는 가짜 발송기를 씁니다.
 */
'use strict';

const crypto = require('crypto');

// 개인 키(base64url, 32바이트) → 공개 키(base64url, 65바이트)
function publicKeyFrom(privateKey) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(String(privateKey).trim(), 'base64url'));
  return ecdh.getPublicKey('base64url', 'uncompressed');
}

// 브라우저가 알려 준 알림 주소가 알려진 푸시 서비스인지 확인 (다른 서버로 요청을 보내지 않도록)
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^([a-z0-9-]+\.)*push\.apple\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)*notify\.windows\.com$/,
];
function validEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 1000) return false;
  let u;
  try { u = new URL(endpoint); } catch (e) { return false; }
  return u.protocol === 'https:' && PUSH_HOSTS.some(re => re.test(u.hostname));
}

const subId = endpoint => crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 40);

function withTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('시간 초과')), ms); })]).finally(() => clearTimeout(t));
}

module.exports = { publicKeyFrom, validEndpoint, subId, withTimeout };
