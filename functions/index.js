/**
 * Firebase Cloud Functions 진입점
 * 하나의 함수(api)가 /api/** 와 /auth/** 주소를 모두 처리합니다. (firebase.json의 rewrites 참고)
 */
'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret, defineString } = require('firebase-functions/params');
const admin = require('firebase-admin');
const { GoogleAuth } = require('google-auth-library');

const config = require('./config');
const { Store, FirestoreAdapter } = require('./src/store');
const { makeCalendarClient, calendarLinks } = require('./src/calendar');
const { handle } = require('./src/http');
const S = require('./src/service');
const { publicKeyFrom } = require('./src/push');

// 비밀 값 (firebase functions:secrets:set 으로 등록)
const SESSION_SECRET = defineSecret('SESSION_SECRET');
const KAKAO_CLIENT_SECRET = defineSecret('KAKAO_CLIENT_SECRET');
const ADMIN_SETUP_CODE = defineSecret('ADMIN_SETUP_CODE');
const VAPID_PRIVATE_KEY = defineSecret('VAPID_PRIVATE_KEY'); // 관리자 푸시 알림
// 일반 설정 값 (functions/.env 파일)
const KAKAO_REST_API_KEY = defineString('KAKAO_REST_API_KEY', { default: '' });
const PUBLIC_URL = defineString('PUBLIC_URL', { default: '' });
const CALENDAR_ID = defineString('CALENDAR_ID', { default: '' });
const CALENDAR_ICAL_URL = defineString('CALENDAR_ICAL_URL', { default: '' });

admin.initializeApp();
const store = new Store(new FirestoreAdapter(admin.firestore()));

let googleAuth = null;
async function calendarToken() {
  googleAuth = googleAuth || new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/calendar.events'] });
  const client = await googleAuth.getClient();
  const t = await client.getAccessToken();
  return t.token || t;
}

// 푸시 알림 발송기 (VAPID 개인 키가 없으면 알림 기능을 끕니다)
let pushClient;
function getPush() {
  if (pushClient !== undefined) return pushClient;
  const priv = (VAPID_PRIVATE_KEY.value() || '').trim();
  if (!priv) return (pushClient = null);
  try {
    const webpush = require('web-push');
    const publicKey = publicKeyFrom(priv);
    const url = PUBLIC_URL.value().trim();
    webpush.setVapidDetails(/^https:\/\//.test(url) ? url : 'mailto:noreply@example.com', publicKey, priv);
    pushClient = { publicKey, recent: new Map(), send: (sub, payload) => webpush.sendNotification(sub, payload, { TTL: 86400 }) };
  } catch (e) {
    console.error('푸시 알림 설정 오류 (VAPID_PRIVATE_KEY 확인)', e.message);
    pushClient = null;
  }
  return pushClient;
}

exports.api = onRequest(
  { region: config.REGION, secrets: [SESSION_SECRET, KAKAO_CLIENT_SECRET, ADMIN_SETUP_CODE, VAPID_PRIVATE_KEY], maxInstances: 5, memory: '256MiB' },
  async (req, res) => {
    const calendarId = CALENDAR_ID.value().trim();
    const env = {
      sessionSecret: SESSION_SECRET.value(),
      sessionDays: config.SESSION_DAYS,
      publicUrl: PUBLIC_URL.value().trim(),
      fetch,
      kakao: { restKey: KAKAO_REST_API_KEY.value().trim(), clientSecret: (KAKAO_CLIENT_SECRET.value() || '').trim() },
      deps: {
        store,
        config,
        kakaoReady: !!KAKAO_REST_API_KEY.value().trim(),
        setupCode: (ADMIN_SETUP_CODE.value() || '').trim(),
        calendar: calendarId ? makeCalendarClient({ calendarId, getToken: calendarToken, fetch }) : null,
        calendarLinks: calendarLinks(calendarId, CALENDAR_ICAL_URL.value().trim()),
        push: getPush(),
      },
    };
    await handle(env, req, res);
  },
);

// 봉사 전날 알림: 매일 config.DUTY_REMIND 시각(서울)에 실행
exports.remindDuty = onSchedule(
  { schedule: `0 ${config.DUTY_REMIND.hour} * * *`, timeZone: 'Asia/Seoul', region: config.REGION, secrets: [VAPID_PRIVATE_KEY], memory: '256MiB' },
  async () => {
    const r = await S.remindDuty({ store, config, push: getPush() });
    console.log('봉사 전날 알림', r.date, '배정 ' + r.assigned + '명', '알림 대상 ' + r.people + '명', r.sent + '대 발송');
  },
);

// 다음 달 일정 입력 알림: 매일 config.INPUT_REMIND 시각(서울)에 실행하고, 마지막 주 월요일·목요일에만 보냅니다.
// (함수 이름은 예전 그대로 둡니다. 이름을 바꾸면 배포 때 옛 함수 삭제 확인이 필요해요.)
exports.remindMissing = onSchedule(
  { schedule: `0 ${config.INPUT_REMIND.hour} * * *`, timeZone: 'Asia/Seoul', region: config.REGION, secrets: [VAPID_PRIVATE_KEY], memory: '256MiB' },
  async () => {
    const r = await S.remindInput({ store, config, push: getPush() });
    if (r.kind) console.log('일정 입력 알림', r.kind, r.month, '미입력 ' + r.missing.length + '명', r.sent + '대 발송');
  },
);
