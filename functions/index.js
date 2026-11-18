/**
 * Firebase Cloud Functions 진입점
 * 하나의 함수(api)가 /api/** 와 /auth/** 주소를 모두 처리합니다. (firebase.json의 rewrites 참고)
 */
'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');
const admin = require('firebase-admin');
const { GoogleAuth } = require('google-auth-library');

const config = require('./config');
const { Store, FirestoreAdapter } = require('./src/store');
const { makeCalendarClient, calendarLinks } = require('./src/calendar');
const { handle } = require('./src/http');

// 비밀 값 (firebase functions:secrets:set 으로 등록)
const SESSION_SECRET = defineSecret('SESSION_SECRET');
const KAKAO_CLIENT_SECRET = defineSecret('KAKAO_CLIENT_SECRET');
const ADMIN_SETUP_CODE = defineSecret('ADMIN_SETUP_CODE');
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

exports.api = onRequest(
  { region: config.REGION, secrets: [SESSION_SECRET, KAKAO_CLIENT_SECRET, ADMIN_SETUP_CODE], maxInstances: 5, memory: '256MiB' },
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
      },
    };
    await handle(env, req, res);
  },
);
