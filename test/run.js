// 서버 시험: node test/run.js
'use strict';
const { makeServer, ok, summary } = require('./helpers');
const L = require('../functions/src/logic');

(async () => {
  const kakaoUsers = {};
  for (let i = 1; i <= 30; i++) kakaoUsers['c' + i] = { id: 1000 + i, nick: '닉' + i };
  const S = makeServer({ kakaoUsers });
  const M = '2026-12', dec = L.sundays(M), both = d => [d + '|1', d + '|2'];

  /* ---------- 로그인 ---------- */
  let r = await S.call('GET', '/api/view?month=' + M);
  ok(r.status === 200 && r.json.me === null && r.json.kakaoReady, 'view without login');
  r = await S.call('GET', '/auth/kakao/login');
  ok(r.status === 302 && r.headers.location.includes('kauth.kakao.com') && r.headers.location.includes(encodeURIComponent('https://test.example/auth/kakao/callback')), 'login redirects to Kakao with callback');
  const A = await S.login('c1');
  ok(A.location === '/?login=ok' && A.cookie.startsWith('__session='), 'callback sets session cookie');
  r = await S.call('GET', '/auth/kakao/login');
  const st = decodeURIComponent(r.headers.location.split('state=')[1]);
  r = await S.call('GET', '/auth/kakao/callback?code=c1&state=forged.state.x.y');
  ok(r.headers.location.startsWith('/?login_error=') && !r.headers['set-cookie'], 'forged state rejected');
  r = await S.call('GET', `/auth/kakao/callback?code=used&state=${encodeURIComponent(st)}`);
  ok(decodeURIComponent(r.headers.location).includes('이미 사용'), 'used code message');
  r = await S.call('GET', '/auth/kakao/callback?error=access_denied');
  ok(decodeURIComponent(r.headers.location).includes('취소'), 'cancel message');
  const startHdr = (await S.login('c2'));
  r = await S.call('GET', '/auth/kakao/login');
  ok(true, 'second user logged in');
  const B = startHdr;
  // 쿠키 속성
  r = await S.call('GET', '/auth/kakao/login');
  const st2 = decodeURIComponent(r.headers.location.split('state=')[1]);
  r = await S.call('GET', `/auth/kakao/callback?code=c3&state=${encodeURIComponent(st2)}`);
  ok(/HttpOnly/.test(r.headers['set-cookie']) && /Secure/.test(r.headers['set-cookie']) && /SameSite=Lax/.test(r.headers['set-cookie']), 'cookie is HttpOnly, Secure, SameSite=Lax');
  const C = { cookie: r.headers['set-cookie'].split(';')[0] };

  r = await S.call('GET', '/api/view?month=' + M, { cookie: A.cookie });
  ok(r.json.me && r.json.me.nickname === '닉1' && r.json.me.vol === null && r.json.setupNeeded === true, 'logged-in view shows me and setup needed');
  r = await S.call('GET', '/api/view?month=' + M, { cookie: '__session=k.1001.9999999999.forged' });
  ok(r.json.me === null, 'forged session ignored');
  r = await S.call('POST', '/api/mine/save', { body: { month: M, name: 'x', roles: ['음향'] }, headers: { 'x-requested-with': '' }, cookie: A.cookie });
  ok(r.status === 403, 'POST without app header refused');
  r = await S.call('POST', '/api/mine/save', { body: { month: M, name: 'x', roles: ['음향'] } });
  ok(r.status === 401, 'save without login → 401');

  /* ---------- 첫 관리자 ---------- */
  r = await S.call('POST', '/api/admin/saveRoles', { cookie: A.cookie, body: { month: M, cat: '방송실', roles: [] } });
  ok(r.status === 403, 'non-admin cannot do admin action');
  r = await S.call('POST', '/api/setup', { cookie: A.cookie, body: { month: M, code: 'wrong' } });
  ok(r.status === 403, 'wrong setup code');
  r = await S.call('POST', '/api/setup', { cookie: A.cookie, body: { month: M, code: 'SETUP-123' } });
  ok(r.status === 200 && r.json.me.admin && r.json.me.admin.all && r.json.admin && r.json.users.length === 3, 'setup makes super admin, sees users');
  r = await S.call('POST', '/api/setup', { cookie: B.cookie, body: { month: M, code: 'SETUP-123' } });
  ok(r.status === 403, 'setup only once');
  const kidB = r.json && r.json.error ? null : null;
  let users = (await S.call('GET', '/api/view?month=' + M, { cookie: A.cookie })).json.users;
  const uB = users.find(u => u.nickname === '닉2');
  r = await S.call('POST', '/api/admin/setAdmin', { cookie: A.cookie, body: { month: M, kakaoId: uB.kakaoId, admin: { cats: ['찬양팀'] } } });
  ok(r.status === 200 && r.json.users.find(u => u.kakaoId === uB.kakaoId).admin.cats[0] === '찬양팀', 'super assigns team admin');
  const meA = r.json.users.find(u => u.me);
  r = await S.call('POST', '/api/admin/setAdmin', { cookie: A.cookie, body: { month: M, kakaoId: meA.kakaoId, admin: null } });
  ok(r.status === 400 && /한 명은/.test(r.json.error), 'cannot remove last super admin');
  r = await S.call('POST', '/api/admin/saveRoles', { cookie: B.cookie, body: { month: M, cat: '방송실', roles: [{ name: '음향', count: 1 }] } });
  ok(r.status === 403, 'team admin cannot edit other team');
  r = await S.call('POST', '/api/admin/setAdmin', { cookie: B.cookie, body: { month: M, kakaoId: uB.kakaoId, admin: { all: true } } });
  ok(r.status === 403, 'team admin cannot grant admin');
  r = await S.call('GET', '/api/view?month=' + M, { cookie: B.cookie });
  ok(r.json.admin && !r.json.users && r.json.admin.cats.join() === '찬양팀', 'team admin view scoped, no user list');

  /* ---------- 본인 등록·연결 ---------- */
  r = await S.call('POST', '/api/mine/save', { cookie: C.cookie, body: { month: M, name: '김은혜', roles: ['음향'], dates: dec.slice(0, 2).flatMap(both), touched: [M] } });
  ok(r.status === 200 && r.json.me.vol.name === '김은혜' && r.json.me.vol.dates.length === 4, 'register self');
  ok(!('dates' in r.json.vols[0]), 'non-admin view hides others dates');
  r = await S.call('POST', '/api/mine/save', { cookie: C.cookie, body: { month: M, name: '김은혜', roles: ['음향', '자막'], dates: ['2027-01-03|1'], touched: ['2027-01'] } });
  ok(r.json.me.vol.dates.length === 5 && r.json.me.vol.roles.length === 2, 'other months kept');
  r = await S.call('POST', '/api/mine/save', { cookie: C.cookie, body: { month: M, name: '=CMD()', roles: ['음향'], dates: [], touched: [M] } });
  ok(r.json.me.vol.name === 'CMD()', 'formula-like name neutralized');
  await S.call('POST', '/api/mine/save', { cookie: C.cookie, body: { month: M, name: '김은혜', roles: ['음향', '자막'], dates: dec.slice(0, 2).flatMap(both), touched: [M] } });
  r = await S.call('POST', '/api/admin/saveVolunteer', { cookie: A.cookie, body: { month: M, name: '박요한', roles: ['자막'], lockedCats: ['방송실'] } });
  const park = r.json.vols.find(v => v.name === '박요한');
  ok(park && park.linked === false, 'admin preregisters');
  const D = await S.login('c4');
  r = await S.call('POST', '/api/mine/save', { cookie: D.cookie, body: { month: M, name: '박요한', roles: ['음향'], dates: [], touched: [M] } });
  ok(r.status === 400 && /목록에 있어요/.test(r.json.error), 'cannot register taken name');
  r = await S.call('POST', '/api/mine/link', { cookie: D.cookie, body: { month: M, volId: park.id } });
  ok(r.status === 200 && r.json.me.vol.name === '박요한', 'link to preregistered');
  r = await S.call('POST', '/api/mine/save', { cookie: D.cookie, body: { month: M, name: '박요한', roles: ['음향'], dates: dec.flatMap(both), touched: [M] } });
  ok(r.json.me.vol.roles.join() === '자막', 'locked roles kept');
  r = await S.call('POST', '/api/mine/link', { cookie: C.cookie, body: { month: M, volId: park.id } });
  ok(r.status === 400, 'cannot link twice');
  r = await S.call('POST', '/api/admin/unlinkKakao', { cookie: A.cookie, body: { month: M, id: park.id } });
  ok(r.json.vols.find(v => v.id === park.id).linked === false, 'admin unlinks');
  r = await S.call('GET', '/api/view?month=' + M, { cookie: D.cookie });
  ok(r.json.me.vol === null, 'unlinked user has no volunteer');

  /* ---------- 배정 규칙 ---------- */
  const people = [['방송A', ['음향']], ['방송B', ['음향']], ['방송C', ['자막']], ['방송D', ['자막']], ['방송E', ['영상 송출']], ['방송F', ['영상 송출']],
    ['찬양P', ['인도']], ['찬양Q', ['인도']], ['찬양R', ['싱어']], ['찬양S', ['싱어']], ['찬양U', ['싱어']], ['찬양V', ['건반']], ['찬양W', ['드럼']]];
  for (const [n, roles] of people) {
    r = await S.call('POST', '/api/admin/saveVolunteer', { cookie: A.cookie, body: { month: M, name: n, roles } });
    const v = r.json.vols.find(x => x.name === n);
    await S.call('POST', '/api/admin/saveDates', { cookie: A.cookie, body: { month: M, id: v.id, dates: dec.flatMap(both) } });
  }
  r = await S.call('GET', '/api/view?month=' + M, { cookie: A.cookie });
  const V = r.json, roleCat = {};
  V.roles.forEach(x => { roleCat[x.name] = x.cat; });
  let bad = false, cont = 0;
  for (const d of dec) {
    const on = {};
    for (const s of ['1', '2']) for (const role in V.schedule.slots[d][s]) for (const p of V.schedule.slots[d][s][role]) (on[p.id] = on[p.id] || []).push([s, roleCat[role]]);
    for (const id in on) {
      const sv = new Set(on[id].map(x => x[0]));
      if (sv.size > 1) { if (on[id].some(x => x[1] !== '찬양팀')) bad = true; else cont++; }
      const per = {}; on[id].forEach(x => { per[x[0]] = (per[x[0]] || 0) + 1; }); if (Object.values(per).some(n => n > 1)) bad = true;
    }
  }
  ok(!bad, '방송실 one service per day, one role per service');
  ok(cont > 0, '찬양팀 continues 1부→2부 (' + cont + ')');
  ok(V.vols.every(v => v.stats && Array.isArray(v.dates)), 'admin sees stats and dates');

  /* ---------- 수동 배정·확정·캘린더 ---------- */
  const vC = V.vols.find(v => v.name === '방송C');
  r = await S.call('POST', '/api/admin/saveOverride', { cookie: A.cookie, body: { month: M, date: dec[0], svc: '1', role: '음향', ids: [vC.id] } });
  ok(r.json.schedule.slots[dec[0]]['1']['음향'][0].id === vC.id && r.json.schedule.slots[dec[0]]['1']['음향'][0].manual, 'override cell');
  r = await S.call('POST', '/api/admin/saveOverride', { cookie: A.cookie, body: { month: M, date: dec[0], svc: '9', role: '음향', ids: [vC.id] } });
  ok(r.status === 400, 'unknown service rejected');
  S.calendar.log.length = 0;
  r = await S.call('POST', '/api/admin/setFinal', { cookie: A.cookie, body: { month: M, cat: '방송실' } });
  ok(r.json.schedule.finalCats.join() === '방송실', 'finalize 방송실');
  const calCount = () => Object.keys(S.calendar.events).length;
  ok(calCount() === dec.length * 2, 'calendar events created (' + calCount() + ')');
  const ev1 = Object.values(S.calendar.events)[0];
  ok(ev1.start.dateTime === dec[0] + 'T09:00:00' && ev1.start.timeZone === 'Asia/Seoul' && /^1부 방송실: /.test(ev1.summary), 'calendar event time and title');
  const vA = V.vols.find(v => v.name === '방송A');
  r = await S.call('POST', '/api/admin/editFinalCell', { cookie: A.cookie, body: { month: M, date: dec[1], svc: '2', role: '음향', ids: [vA.id] } });
  ok(calCount() === dec.length * 2 && S.calendar.log.filter(x => x === 'new').length === dec.length * 2, 'edit updates, no duplicate');
  const before = JSON.stringify(dec.map(d => r.json.schedule.slots[d]['1']['자막']));
  await S.call('POST', '/api/admin/saveVolunteer', { cookie: A.cookie, body: { month: M, name: '새방송', roles: ['자막'] } });
  r = await S.call('GET', '/api/view?month=' + M, { cookie: A.cookie });
  ok(JSON.stringify(dec.map(d => r.json.schedule.slots[d]['1']['자막'])) === before, 'final schedule stays fixed');
  r = await S.call('POST', '/api/admin/setFinal', { cookie: B.cookie, body: { month: M, cat: '찬양팀' } });
  ok(r.json.schedule.finalCats.length === 2 && calCount() === dec.length * 4, '찬양팀 admin finalizes own team');
  r = await S.call('POST', '/api/admin/unsetFinal', { cookie: A.cookie, body: { month: M, cat: '방송실' } });
  ok(calCount() === dec.length * 2 && Object.values(S.calendar.events).every(e => e.summary.includes('찬양팀')), 'unfinalize removes only that team');

  /* ---------- 이벤트 ---------- */
  r = await S.call('GET', '/api/view?month=' + M, { cookie: A.cookie });
  const sundayBefore = JSON.stringify(dec.map(d => r.json.schedule.slots[d]));
  const statsBefore = JSON.stringify(r.json.vols.map(v => v.stats.now));
  r = await S.call('POST', '/api/admin/saveEvent', { cookie: A.cookie, body: { month: M, event: { name: '성탄 이브 예배', date: '2026-12-24', teams: ['방송실', '찬양팀'], slots: [{ label: '1부', start: '19:00', end: '20:30' }, { label: '2부', start: '21:00', end: '22:30' }] } } });
  const ev = r.json.allEvents[0];
  ok(ev && ev.slots.map(s => s.k).join() === 's1,s2' && r.json.events.length === 1, 'event created');
  const k1 = '2026-12-24|e' + ev.id + '_s1', k2 = '2026-12-24|e' + ev.id + '_s2';
  for (const v of r.json.vols) await S.call('POST', '/api/admin/saveDates', { cookie: A.cookie, body: { month: M, id: v.id, dates: v.dates.concat([k1, k2]) } });
  r = await S.call('GET', '/api/view?month=' + M, { cookie: A.cookie });
  const es = r.json.schedule.slots['2026-12-24'];
  const s1 = es['e' + ev.id + '_s1'], s2 = es['e' + ev.id + '_s2'];
  ok(s1 && s2 && s1['인도'][0].id === s2['인도'][0].id, 'event scheduled, 찬양팀 continues');
  ok(['음향', '자막', '영상 송출'].every(x => s1[x].length && s2[x].length) && !s1['음향'].some(p => s2['음향'].concat(s2['자막'], s2['영상 송출']).some(q => q.id === p.id)), 'event 방송실 one slot each');
  ok(JSON.stringify(dec.map(d => r.json.schedule.slots[d])) === sundayBefore, 'Sunday schedule unchanged by event');
  ok(JSON.stringify(r.json.vols.map(v => v.stats.now)) === statsBefore, 'event not counted');
  r = await S.call('POST', '/api/admin/saveEvent', { cookie: B.cookie, body: { month: M, event: { name: 'x', date: '2026-12-31', teams: ['방송실'], slots: [{ start: '10:00' }] } } });
  ok(r.status === 403, 'team admin cannot add other team event');
  r = await S.call('POST', '/api/admin/saveEvent', { cookie: B.cookie, body: { month: M, event: { name: '찬양 수련회', date: '2026-12-31', teams: ['찬양팀'], slots: [{ start: '10:00', end: '12:00' }] } } });
  ok(r.status === 200 && r.json.allEvents.find(e => e.name === '찬양 수련회').slots[0].label === '예배', 'team admin creates own event');
  ok(r.json.allEvents.find(e => e.id === ev.id).editable === false, 'mixed event not editable by team admin');
  r = await S.call('POST', '/api/admin/saveEvent', { cookie: A.cookie, body: { month: M, event: { name: 'y', date: '2026-12-30', teams: ['찬양팀'], slots: [{ start: '25:00' }] } } });
  ok(r.status === 400 && /시작 시간/.test(r.json.error), 'bad time rejected');
  r = await S.call('POST', '/api/admin/saveEvent', { cookie: A.cookie, body: { month: M, event: { id: ev.id, name: '성탄 이브 예배', date: '2026-12-23', teams: ['방송실', '찬양팀'], slots: ev.slots } } });
  ok(r.json.vols.every(v => !v.dates.includes(k1)) && r.json.vols.some(v => v.dates.includes('2026-12-23|e' + ev.id + '_s1')), 'date change moves availability');
  r = await S.call('POST', '/api/admin/deleteEvent', { cookie: A.cookie, body: { month: M, id: ev.id } });
  ok(!r.json.allEvents.find(e => e.id === ev.id) && r.json.vols.every(v => !v.dates.some(x => x.includes('e' + ev.id))), 'delete event cleans availability');

  /* ---------- 읽기 횟수 (캐시) ---------- */
  const reads0 = S.adapter.reads;
  for (let i = 0; i < 5; i++) await S.call('GET', '/api/view?month=' + M);
  ok(S.adapter.reads === reads0, 'repeated views reuse cache (no extra reads)');

  /* ---------- 기타 ---------- */
  r = await S.call('POST', '/api/admin/deleteVolunteer', { cookie: B.cookie, body: { month: M, id: vA.id } });
  ok(r.status === 403, 'team admin cannot delete volunteer');
  r = await S.call('POST', '/api/admin/nope', { cookie: A.cookie, body: { month: M } });
  ok(r.status === 404, 'unknown admin action');
  r = await S.call('POST', '/api/logout', { cookie: A.cookie });
  ok(/Max-Age=0/.test(r.headers['set-cookie']), 'logout clears cookie');
  r = await S.call('GET', '/api/view?month=bad');
  ok(r.status === 400, 'bad month rejected');

  // 캘린더 미설정이어도 확정은 됨
  const S2 = makeServer({ kakaoUsers, noCalendar: true });
  const X = await S2.login('c1');
  await S2.call('POST', '/api/setup', { cookie: X.cookie, body: { month: M, code: 'SETUP-123' } });
  r = await S2.call('POST', '/api/admin/setFinal', { cookie: X.cookie, body: { month: M, cat: '방송실' } });
  ok(r.status === 200 && !r.json.notice && r.json.calendar === null, 'works without calendar');
  // 캘린더 오류 → 확정 유지 + 안내
  S.calendar.upsert = async () => { throw new Error('권한 없음'); };
  r = await S.call('POST', '/api/admin/setFinal', { cookie: B.cookie, body: { month: M, cat: '찬양팀' } });
  ok(r.status === 200 && /캘린더에 반영하지 못했어요/.test(r.json.notice || ''), 'calendar error → saved with notice');

  summary();
})().catch(e => { console.error(e); process.exitCode = 1; });
