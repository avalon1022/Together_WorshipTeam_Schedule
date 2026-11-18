/**
 * 구글 캘린더 연동 (서비스 계정)
 *
 * 관리자가 자기 구글 캘린더에 '주일 예배팀 스케줄' 캘린더를 만들고,
 * Cloud Functions 서비스 계정 이메일에 '일정 변경' 권한으로 공유한 뒤, 그 캘린더 ID를 CALENDAR_ID에 넣습니다.
 * 이 모듈은 그 캘린더에 일정을 넣고, 고치고, 지웁니다.
 */
'use strict';

const API = 'https://www.googleapis.com/calendar/v3/calendars/';

function addMinutes(hhmm, mins) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = Math.min(h * 60 + m + mins, 23 * 60 + 59);
  return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
}
// 캘린더에 넣을 시간 (서울 시간)
function eventTimes(date, start, end) {
  const s = start || '09:00';
  const e = end && end > s ? end : addMinutes(s, 90);
  return {
    start: { dateTime: `${date}T${s}:00`, timeZone: 'Asia/Seoul' },
    end: { dateTime: `${date}T${e}:00`, timeZone: 'Asia/Seoul' },
  };
}

// getToken: () => Promise<액세스 토큰>, fetch: 전역 fetch
function makeCalendarClient({ calendarId, getToken, fetch }) {
  const base = API + encodeURIComponent(calendarId) + '/events';
  async function call(method, url, body) {
    const token = await getToken();
    const res = await fetch(url, {
      method,
      headers: Object.assign({ Authorization: 'Bearer ' + token }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (method === 'DELETE' && (res.status === 404 || res.status === 410)) return null; // 이미 지워진 일정
    if (method === 'PATCH' && (res.status === 404 || res.status === 410)) return { missing: true };
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      const hint = res.status === 403 || res.status === 404
        ? ' (캘린더를 서비스 계정에 "일정 변경" 권한으로 공유했는지, CALENDAR_ID가 맞는지 확인해 주세요)' : '';
      throw new Error(`구글 캘린더 오류 ${res.status}${hint}: ${txt.slice(0, 200)}`);
    }
    return method === 'DELETE' ? null : res.json();
  }
  return {
    async upsert(eventId, ev) {
      if (eventId) {
        const r = await call('PATCH', base + '/' + encodeURIComponent(eventId), ev);
        if (r && !r.missing) return r.id;
      }
      const r = await call('POST', base, ev);
      return r.id;
    },
    async remove(eventId) { await call('DELETE', base + '/' + encodeURIComponent(eventId)); },
  };
}

// 구독 링크
function calendarLinks(calendarId, icalUrl) {
  if (!calendarId) return null;
  return {
    google: 'https://calendar.google.com/calendar/u/0?cid=' + Buffer.from(calendarId).toString('base64').replace(/=+$/, ''),
    ical: icalUrl || ('https://calendar.google.com/calendar/ical/' + encodeURIComponent(calendarId) + '/public/basic.ics'),
  };
}

module.exports = { makeCalendarClient, calendarLinks, eventTimes };
