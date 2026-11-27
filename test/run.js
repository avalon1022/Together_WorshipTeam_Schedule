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
  r = await S.call('POST', '/api/admin/saveRoles', { cookie: A.cookie, body: { month: M, cat: '방송팀', roles: [] } });
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
  r = await S.call('POST', '/api/admin/saveRoles', { cookie: B.cookie, body: { month: M, cat: '방송팀', roles: [{ name: '음향', count: 1 }] } });
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
  r = await S.call('POST', '/api/admin/saveVolunteer', { cookie: A.cookie, body: { month: M, name: '박요한', roles: ['자막'], lockedCats: ['방송팀'] } });
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
  ok(!bad, '방송팀 one service per day, one role per service');
  ok(cont > 0, '찬양팀 continues 1부→2부 (' + cont + ')');
  ok(V.vols.every(v => v.stats && Array.isArray(v.dates)), 'admin sees stats and dates');

  /* ---------- 수동 배정·확정·캘린더 ---------- */
  const vC = V.vols.find(v => v.name === '방송C');
  r = await S.call('POST', '/api/admin/saveOverride', { cookie: A.cookie, body: { month: M, date: dec[0], svc: '1', role: '음향', ids: [vC.id] } });
  ok(r.json.schedule.slots[dec[0]]['1']['음향'][0].id === vC.id && r.json.schedule.slots[dec[0]]['1']['음향'][0].manual, 'override cell');
  r = await S.call('POST', '/api/admin/saveOverride', { cookie: A.cookie, body: { month: M, date: dec[0], svc: '9', role: '음향', ids: [vC.id] } });
  ok(r.status === 400, 'unknown service rejected');
  S.calendar.log.length = 0;
  r = await S.call('POST', '/api/admin/setFinal', { cookie: A.cookie, body: { month: M, cat: '방송팀' } });
  ok(r.json.schedule.finalCats.join() === '방송팀', 'finalize 방송팀');
  const calCount = () => Object.keys(S.calendar.events).length;
  ok(calCount() === dec.length * 2, 'calendar events created (' + calCount() + ')');
  const ev1 = Object.values(S.calendar.events)[0];
  ok(ev1.start.dateTime === dec[0] + 'T11:00:00' && ev1.start.timeZone === 'Asia/Seoul' && /^1부 방송팀: /.test(ev1.summary), 'calendar event time and title');
  const vA = V.vols.find(v => v.name === '방송A');
  r = await S.call('POST', '/api/admin/editFinalCell', { cookie: A.cookie, body: { month: M, date: dec[1], svc: '2', role: '음향', ids: [vA.id] } });
  ok(calCount() === dec.length * 2 && S.calendar.log.filter(x => x === 'new').length === dec.length * 2, 'edit updates, no duplicate');
  const before = JSON.stringify(dec.map(d => r.json.schedule.slots[d]['1']['자막']));
  await S.call('POST', '/api/admin/saveVolunteer', { cookie: A.cookie, body: { month: M, name: '새방송', roles: ['자막'] } });
  r = await S.call('GET', '/api/view?month=' + M, { cookie: A.cookie });
  ok(JSON.stringify(dec.map(d => r.json.schedule.slots[d]['1']['자막'])) === before, 'final schedule stays fixed');
  r = await S.call('POST', '/api/admin/setFinal', { cookie: B.cookie, body: { month: M, cat: '찬양팀' } });
  ok(r.json.schedule.finalCats.length === 2 && calCount() === dec.length * 4, '찬양팀 admin finalizes own team');
  r = await S.call('POST', '/api/admin/unsetFinal', { cookie: A.cookie, body: { month: M, cat: '방송팀' } });
  ok(calCount() === dec.length * 2 && Object.values(S.calendar.events).every(e => e.summary.includes('찬양팀')), 'unfinalize removes only that team');
  // 캘린더에서 일정을 지운 뒤 다시 반영
  Object.keys(S.calendar.events).forEach(k => delete S.calendar.events[k]);
  r = await S.call('POST', '/api/admin/syncCalendar', { cookie: B.cookie, body: { month: M } });
  ok(r.status === 200 && !r.json.notice && calCount() === dec.length * 2, 'resync recreates confirmed team events');
  r = await S.call('POST', '/api/admin/syncCalendar', { cookie: A.cookie, body: { month: '2027-03' } });
  ok(r.status === 400, 'resync with nothing confirmed explains');

  /* ---------- 이벤트 ---------- */
  r = await S.call('GET', '/api/view?month=' + M, { cookie: A.cookie });
  const sundayBefore = JSON.stringify(dec.map(d => r.json.schedule.slots[d]));
  const statsBefore = JSON.stringify(r.json.vols.map(v => v.stats.now));
  r = await S.call('POST', '/api/admin/saveEvent', { cookie: A.cookie, body: { month: M, event: { name: '성탄 이브 예배', date: '2026-12-24', teams: ['방송팀', '찬양팀'], slots: [{ label: '1부', start: '19:00', end: '20:30' }, { label: '2부', start: '21:00', end: '22:30' }] } } });
  const ev = r.json.allEvents[0];
  ok(ev && ev.slots.map(s => s.k).join() === 's1,s2' && r.json.events.length === 1, 'event created');
  const k1 = '2026-12-24|e' + ev.id + '_s1', k2 = '2026-12-24|e' + ev.id + '_s2';
  for (const v of r.json.vols) await S.call('POST', '/api/admin/saveDates', { cookie: A.cookie, body: { month: M, id: v.id, dates: v.dates.concat([k1, k2]) } });
  r = await S.call('GET', '/api/view?month=' + M, { cookie: A.cookie });
  const es = r.json.schedule.slots['2026-12-24'];
  const s1 = es['e' + ev.id + '_s1'], s2 = es['e' + ev.id + '_s2'];
  ok(s1 && s2 && s1['인도'][0].id === s2['인도'][0].id, 'event scheduled, 찬양팀 continues');
  ok(['음향', '자막', '영상 송출'].every(x => s1[x].length && s2[x].length) && !s1['음향'].some(p => s2['음향'].concat(s2['자막'], s2['영상 송출']).some(q => q.id === p.id)), 'event 방송팀 one slot each');
  ok(JSON.stringify(dec.map(d => r.json.schedule.slots[d])) === sundayBefore, 'Sunday schedule unchanged by event');
  ok(JSON.stringify(r.json.vols.map(v => v.stats.now)) === statsBefore, 'event not counted');
  r = await S.call('POST', '/api/admin/saveEvent', { cookie: B.cookie, body: { month: M, event: { name: 'x', date: '2026-12-31', teams: ['방송팀'], slots: [{ start: '10:00' }] } } });
  ok(r.status === 403, 'team admin cannot add other team event');
  r = await S.call('POST', '/api/admin/saveEvent', { cookie: B.cookie, body: { month: M, event: { name: '찬양 수련회', date: '2026-12-31', teams: ['찬양팀'], slots: [{ start: '10:00', end: '12:00' }] } } });
  ok(r.status === 200 && r.json.allEvents.find(e => e.name === '찬양 수련회').slots[0].label === '예배', 'team admin creates own event');
  ok(r.json.allEvents.find(e => e.id === ev.id).editable === false, 'mixed event not editable by team admin');
  r = await S.call('POST', '/api/admin/saveEvent', { cookie: A.cookie, body: { month: M, event: { name: 'y', date: '2026-12-30', teams: ['찬양팀'], slots: [{ start: '25:00' }] } } });
  ok(r.status === 400 && /시작 시간/.test(r.json.error), 'bad time rejected');
  r = await S.call('POST', '/api/admin/saveEvent', { cookie: A.cookie, body: { month: M, event: { id: ev.id, name: '성탄 이브 예배', date: '2026-12-23', teams: ['방송팀', '찬양팀'], slots: ev.slots } } });
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
  r = await S2.call('POST', '/api/admin/setFinal', { cookie: X.cookie, body: { month: M, cat: '방송팀' } });
  ok(r.status === 200 && !r.json.notice && r.json.calendar === null, 'works without calendar');
  // 캘린더 오류 → 확정 유지 + 안내
  S.calendar.upsert = async () => { throw new Error('권한 없음'); };
  r = await S.call('POST', '/api/admin/setFinal', { cookie: B.cookie, body: { month: M, cat: '찬양팀' } });
  ok(r.status === 200 && /캘린더에 반영하지 못했어요/.test(r.json.notice || ''), 'calendar error → saved with notice');

  /* ---------- 찬양팀 배정 우선순위 ---------- */
  {
    const S3 = makeServer({ kakaoUsers });
    const P = await S3.login('c1'), T = await S3.login('c2'), U = await S3.login('c3');
    await S3.call('POST', '/api/setup', { cookie: P.cookie, body: { month: M, code: 'SETUP-123' } });
    await S3.call('POST', '/api/admin/setAdmin', { cookie: P.cookie, body: { month: M, kakaoId: '1002', admin: { cats: ['방송팀'] } } });
    for (const n of ['높음', '낮음']) await S3.call('POST', '/api/admin/saveVolunteer', { cookie: P.cookie, body: { month: M, name: n, roles: ['인도'] } });
    let v = (await S3.call('GET', '/api/view?month=' + M, { cookie: P.cookie })).json;
    const id = n => v.vols.find(x => x.name === n).id;
    for (const n of ['높음', '낮음']) await S3.call('POST', '/api/admin/saveDates', { cookie: P.cookie, body: { month: M, id: id(n), dates: dec.flatMap(both) } });
    const leads = vw => { const c = {}; dec.forEach(d => (vw.schedule.slots[d]['1']['인도'] || []).forEach(p => { c[p.name] = (c[p.name] || 0) + 1; })); return c; };
    v = (await S3.call('GET', '/api/view?month=' + M, { cookie: P.cookie })).json;
    let c = leads(v);
    ok(c['높음'] === 2 && c['낮음'] === 2, 'no priority → even split');
    ok(v.cats.find(x => x.name === '찬양팀').usePriority && !v.cats.find(x => x.name === '방송팀').usePriority, 'only 찬양팀 uses priority');
    let r = await S3.call('POST', '/api/admin/saveVolunteer', { cookie: P.cookie, body: { month: M, id: id('높음'), name: '높음', roles: ['인도'], prio: { 찬양팀: 'high', 방송팀: 'high' } } });
    await S3.call('POST', '/api/admin/saveVolunteer', { cookie: P.cookie, body: { month: M, id: id('낮음'), name: '낮음', roles: ['인도'], prio: { 찬양팀: 'low' } } });
    v = (await S3.call('GET', '/api/view?month=' + M, { cookie: P.cookie })).json;
    c = leads(v);
    ok(c['높음'] >= 3 && c['낮음'] >= 1, 'high priority gets more, low still gets some');
    ok(JSON.stringify(v.vols.find(x => x.name === '높음').prio) === '{"찬양팀":"high"}', 'admin sees priority, 방송팀 ignored');
    // 2부도 같은 사람이 이어서
    ok(dec.every(d => (v.schedule.slots[d]['2']['인도'][0] || {}).name === (v.schedule.slots[d]['1']['인도'][0] || {}).name), '찬양팀 same leader both services');
    // 일반 사용자와 비로그인에는 안 보임
    const pub = (await S3.call('GET', '/api/view?month=' + M)).json;
    ok(pub.vols.every(x => x.prio === undefined), 'public view hides priority');
    const tv = (await S3.call('GET', '/api/view?month=' + M, { cookie: T.cookie })).json;
    ok(tv.vols.every(x => !x.prio || !x.prio['찬양팀']), '방송팀 admin cannot see 찬양팀 priority');
    // 방송팀 담당자가 저장해도 찬양팀 우선순위는 그대로
    await S3.call('POST', '/api/admin/saveVolunteer', { cookie: T.cookie, body: { month: M, id: id('높음'), name: '높음', roles: [], prio: { 찬양팀: 'low' } } });
    v = (await S3.call('GET', '/api/view?month=' + M, { cookie: P.cookie })).json;
    ok(v.vols.find(x => x.name === '높음').prio['찬양팀'] === 'high', 'other team admin cannot change priority');
    // prio를 안 보내면 기존 값 유지
    await S3.call('POST', '/api/admin/saveVolunteer', { cookie: P.cookie, body: { month: M, id: id('높음'), name: '높음', roles: ['인도'] } });
    v = (await S3.call('GET', '/api/view?month=' + M, { cookie: P.cookie })).json;
    ok(v.vols.find(x => x.name === '높음').prio['찬양팀'] === 'high', 'omitted prio keeps value');
    await S3.call('POST', '/api/admin/saveVolunteer', { cookie: P.cookie, body: { month: M, id: id('높음'), name: '높음', roles: ['인도'], prio: {} } });
    v = (await S3.call('GET', '/api/view?month=' + M, { cookie: P.cookie })).json;
    ok(!v.vols.find(x => x.name === '높음').prio['찬양팀'], 'normal clears priority');
    void U;
  }

  /* ---------- 팀 이름 변경 (방송실 → 방송팀) ---------- */
  {
    const S4 = makeServer({ kakaoUsers });
    Object.assign(S4.adapter.docs, {
      'config/main': { roles: [{ cat: '방송실', name: '음향', count: 2 }, { cat: '찬양팀', name: '인도', count: 1 }] },
      'volunteers/v1': { name: '옛방송', roles: ['음향'], dates: [dec[0] + '|1'], lockedCats: ['방송실'], svcLock: { 방송실: '1' }, kakaoId: '' },
      'volunteers/v2': { name: '찬양만', roles: ['인도'], dates: [], lockedCats: [], svcLock: {}, kakaoId: '' },
      'events/e1': { name: '이브', date: '2026-12-24', teams: ['방송실', '찬양팀'], slots: [{ k: 's1', label: '예배', start: '19:00', end: '20:00' }] },
      'months/2026-12': { overrides: {}, finals: { 방송실: { [dec[0]]: { 1: { 음향: [{ id: 'v1', name: '옛방송' }] } } } } },
      'users/1001': { nickname: '닉1', admin: { cats: ['방송실'] } },
      'calendar/2026-12|방송실': { map: { [dec[0] + '|1']: 'ev1' } },
    });
    S4.adapter.v = 1;
    const X = await S4.login('c1');
    const r = await S4.call('GET', '/api/view?month=' + M, { cookie: X.cookie });
    const D = S4.adapter.docs;
    ok(!JSON.stringify(D).includes('방송실'), 'old team name removed from all data');
    ok(D['config/main'].roles[0].cat === '방송팀' && D['volunteers/v1'].svcLock['방송팀'] === '1' && D['volunteers/v1'].lockedCats[0] === '방송팀', 'roles and volunteer settings renamed');
    ok(D['events/e1'].teams.join() === '방송팀,찬양팀' && D['months/2026-12'].finals['방송팀'] && D['calendar/2026-12|방송팀'].map[dec[0] + '|1'] === 'ev1' && !D['calendar/2026-12|방송실'], 'events, finals, calendar renamed');
    ok(D['users/1001'].admin.cats[0] === '방송팀' && r.json.me.admin.cats[0] === '방송팀', 'team admin keeps permission');
    ok(JSON.stringify(D['volunteers/v2']) === JSON.stringify({ name: '찬양만', roles: ['인도'], dates: [], lockedCats: [], svcLock: {}, kakaoId: '' }), 'unrelated volunteer untouched');
    ok(r.json.schedule.finalCats.includes('방송팀') && r.json.schedule.slots[dec[0]]['1']['음향'][0].name === '옛방송', 'confirmed schedule still shown');
    const v0 = S4.adapter.v;
    await S4.call('GET', '/api/view?month=' + M);
    ok(S4.adapter.v === v0, 'migration runs once, no extra writes');
  }

  {
    const S6 = makeServer({ kakaoUsers, noCalendar: true });
    const X = await S6.login('c1');
    await S6.call('POST', '/api/setup', { cookie: X.cookie, body: { month: M, code: 'SETUP-123' } });
    const r6 = await S6.call('POST', '/api/admin/saveRoles', { cookie: X.cookie, body: { month: M, cat: '방송팀', roles: [{ name: '자막', count: 1 }, { name: '영상 송출', count: 1 }, { name: '음향', count: 2 }] } });
    ok(r6.json.roles.map(x => x.name).join() === '자막,영상 송출,음향,인도,싱어,건반,드럼', 'role reorder keeps team order');
    ok(Object.keys(r6.json.schedule.slots[dec[0]]['1']).slice(0, 3).join() === '자막,영상 송출,음향', 'schedule follows role order');
  }
  {
    const S5 = makeServer({ kakaoUsers, noCalendar: true });
    const X = await S5.login('c1');
    await S5.call('POST', '/api/setup', { cookie: X.cookie, body: { month: M, code: 'SETUP-123' } });
    const r5 = await S5.call('POST', '/api/admin/syncCalendar', { cookie: X.cookie, body: { month: M } });
    ok(r5.status === 400 && /CALENDAR_ID/.test(r5.json.error), 'resync without calendar explains');
  }

  /* ---------- 관리자 푸시 알림 ---------- */
  {
    const S7 = makeServer({ kakaoUsers });
    const su = await S7.login('c1'), su2 = await S7.login('c2'), team = await S7.login('c3'), vol = await S7.login('c4');
    const SUB = n => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/dev' + n, keys: { p256dh: 'P' + n, auth: 'A' + n } });
    const post = (who, path, body) => S7.call('POST', path, { cookie: who.cookie, body: Object.assign({ month: M }, body) });
    await post(su, '/api/setup', { code: 'SETUP-123' });
    await post(su, '/api/admin/setAdmin', { kakaoId: '1002', admin: { all: true } });
    await post(su, '/api/admin/setAdmin', { kakaoId: '1003', admin: { cats: ['찬양팀'] } });
    const stranger = await S7.login('c9');
    let r = await post(stranger, '/api/push/subscribe', { subscription: SUB(9) });
    ok(r.status === 403 && /이름을 먼저 연결/.test(r.json.error), 'unlinked non-admin cannot subscribe');
    r = await post(su, '/api/push/subscribe', { subscription: { endpoint: 'https://evil.example/x', keys: { p256dh: 'a', auth: 'b' } } });
    ok(r.status === 400, 'unknown push host rejected');
    r = await post(su, '/api/push/subscribe', { subscription: SUB(1), ua: 'iPhone' });
    ok(r.status === 200 && r.json.push.devices === 1 && r.json.push.publicKey === 'TEST-PUBLIC-KEY', 'super admin subscribes');
    await post(su, '/api/push/subscribe', { subscription: SUB(1) });
    await post(su2, '/api/push/subscribe', { subscription: SUB(2) });
    ok(Object.keys(S7.adapter.docs).filter(k => k.startsWith('push/')).length === 2, 'same device not duplicated');
    const tv7 = (await S7.call('GET', '/api/view?month=' + M, { cookie: team.cookie })).json;
    ok(tv7.push && tv7.push.canSubscribe && tv7.push.devices === 0, 'team admin can turn on push');

    r = await post(su, '/api/push/test', {});
    ok(r.json.sent === 1 && S7.push.sent.length === 1 && S7.push.sent[0].endpoint.endsWith('dev1'), 'test push goes to own device only');
    S7.push.sent.length = 0;

    // 새 봉사자 가입 → 전체 관리자 둘 다
    await post(vol, '/api/mine/save', { name: '새가족', roles: ['드럼'], dates: both(dec[0]), touched: [M] });
    ok(S7.push.sent.length === 2 && S7.push.sent.every(x => x.title === '새 봉사자 가입' && /새가족님이 가입했어요 \(찬양팀\)\. 12월 가능 예배 2회/.test(x.body)), 'new volunteer notifies super admins');
    S7.push.sent.length = 0;
    // 같은 사람이 곧바로 다시 저장 → 첫 수정 알림 1번, 그다음은 10분 동안 묶음
    await post(vol, '/api/mine/save', { name: '새가족', roles: ['드럼'], dates: both(dec[1]), touched: [M] });
    await post(vol, '/api/mine/save', { name: '새가족', roles: ['드럼'], dates: both(dec[2]), touched: [M] });
    ok(S7.push.sent.length === 2 && S7.push.sent[0].title === '봉사 일정 입력' && S7.push.sent[0].url === '/?tab=settings&month=' + M, 'date edits notify once, then throttled');
    S7.push.sent.length = 0;
    // 관리자 본인이 저장하면 본인에게는 안 감
    await post(su, '/api/mine/save', { name: '관리자본인', roles: ['인도'], dates: both(dec[0]), touched: [M] });
    ok(S7.push.sent.length === 1 && S7.push.sent[0].endpoint.endsWith('dev2'), 'actor is not notified');
    S7.push.sent.length = 0;
    // 팀 담당자 확정 → 전체 관리자 둘 다
    await post(team, '/api/admin/setFinal', { cat: '찬양팀' });
    ok(S7.push.sent.length === 2 && S7.push.sent[0].title === '스케줄 확정' && S7.push.sent[0].body.includes('12월 찬양팀') && S7.push.sent[0].url === '/?tab=schedule&month=' + M, 'finalize notifies super admins');
    S7.push.sent.length = 0;
    await post(su, '/api/admin/unsetFinal', { cat: '찬양팀' });
    ok(S7.push.sent.length === 1 && S7.push.sent[0].title === '스케줄 확정 해제' && S7.push.sent[0].body.startsWith('관리자본인님'), 'unfinalize notifies other super admin');
    S7.push.sent.length = 0;
    // 알림을 끈 기기(410)는 자동 정리
    S7.push.gone.add(SUB(2).endpoint);
    await post(team, '/api/admin/setFinal', { cat: '찬양팀' });
    ok(!S7.adapter.docs['push/' + require('../functions/src/push').subId(SUB(2).endpoint)], 'gone device removed');
    // 끄기
    r = await post(su, '/api/push/unsubscribe', { endpoint: SUB(1).endpoint });
    ok(r.json.push.devices === 0, 'unsubscribe');
    r = await post(su, '/api/push/test', {});
    ok(r.status === 400, 'test without device explains');

    // 미입력자 알림 (11월 20일 → 12월 확인)
    await post(su, '/api/push/subscribe', { subscription: SUB(1) });
    await post(su, '/api/admin/saveVolunteer', { name: '안넣음', roles: ['음향'] });
    await post(su, '/api/admin/saveVolunteer', { name: '못감', roles: ['자막'] });
    let v7 = (await S7.call('GET', '/api/view?month=' + M, { cookie: su.cookie })).json;
    await post(su, '/api/admin/saveDates', { id: v7.vols.find(x => x.name === '못감').id, dates: [] }); // 0회로 저장 = 입력한 것
    S7.push.sent.length = 0;
    const rm = await require('../functions/src/service').remindInput(S7.env.deps, new Date('2026-12-03T05:00:00Z')); // 12/3(목) 14시
    ok(rm.kind === 'reminder' && rm.month === M && rm.missing.join() === '안넣음' && S7.push.sent.length === 1 && S7.push.sent[0].title === '12월 일정 미입력 1명', 'Thursday: admin gets list of volunteers who never saved next month');
  }
  {
    const S8 = makeServer({ kakaoUsers, noPush: true });
    const X = await S8.login('c1');
    await S8.call('POST', '/api/setup', { cookie: X.cookie, body: { month: M, code: 'SETUP-123' } });
    const v8 = (await S8.call('GET', '/api/view?month=' + M, { cookie: X.cookie })).json;
    const r8 = await S8.call('POST', '/api/push/subscribe', { cookie: X.cookie, body: { month: M, subscription: { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'a', auth: 'b' } } } });
    ok(v8.push === null && r8.status === 400, 'push off when not configured');
  }

  /* ---------- 주일 예배 변경 ---------- */
  {
    const S9 = makeServer({ kakaoUsers });
    const su = await S9.login('c1'), team = await S9.login('c3');
    const post = (who, path, body) => S9.call('POST', path, { cookie: who.cookie, body: Object.assign({ month: M }, body) });
    await post(su, '/api/setup', { code: 'SETUP-123' });
    await post(su, '/api/admin/setAdmin', { kakaoId: '1003', admin: { cats: ['찬양팀'] } });
    for (const n of ['음향A', '음향B']) await post(su, '/api/admin/saveVolunteer', { name: n, roles: ['음향'] });
    await post(su, '/api/admin/saveVolunteer', { name: '인도C', roles: ['인도'] });
    let v = (await S9.call('GET', '/api/view?month=' + M, { cookie: su.cookie })).json;
    const A = v.vols.find(x => x.name === '음향A').id, B = v.vols.find(x => x.name === '음향B').id, C = v.vols.find(x => x.name === '인도C').id;
    // 미리 연합예배 이벤트 만들어 두고 가능 체크
    let r = await post(su, '/api/admin/saveEvent', { event: { name: '연합예배', date: dec[2], teams: ['방송팀', '찬양팀'], slots: [{ label: '예배', start: '11:00', end: '12:30' }] } });
    const ev = r.json.events.find(e => e.name === '연합예배');
    for (const id of [A, B, C]) await post(su, '/api/admin/saveDates', { id, dates: dec.flatMap(both).concat([dec[2] + '|e' + ev.id + '_s1']) });
    await post(su, '/api/admin/setFinal', { cat: '방송팀' });
    const calKeys = () => Object.keys(S9.adapter.docs['calendar/' + M + '|방송팀'].map).sort();
    ok(calKeys().includes(dec[1] + '|2'), 'calendar has 2부 before change');

    r = await post(team, '/api/admin/setSunMode', { date: dec[1], mode: 'only1' });
    ok(r.status === 403, 'team admin cannot change Sunday services');
    r = await post(su, '/api/admin/setSunMode', { date: '2026-12-08', mode: 'only1' });
    ok(r.status === 400, 'non-Sunday date rejected');
    r = await post(su, '/api/admin/setSunMode', { date: dec[1], mode: 'only1' });
    ok(r.status === 200 && r.json.sunMode[dec[1]] === 'only1' && Object.keys(r.json.schedule.slots[dec[1]]).join() === '1', 'only1 removes 2부');
    ok(/확정된 방송팀/.test(r.json.notice || ''), 'warns that confirmed team keeps old assignment');
    ok(!calKeys().includes(dec[1] + '|2') && calKeys().includes(dec[1] + '|1'), 'calendar 2부 removed after change');
    r = await post(su, '/api/admin/setSunMode', { date: dec[3], mode: 'only2' });
    ok(Object.keys(r.json.schedule.slots[dec[3]]).join() === '2', 'only2 keeps 2부');

    // 주일 대체
    r = await post(team, '/api/admin/saveEvent', { event: { name: '찬양집회', date: dec[0], teams: ['찬양팀'], replaces: true, slots: [{ start: '11:00' }] } });
    ok(r.status === 403, 'team admin cannot create replacing event');
    r = await post(su, '/api/admin/saveEvent', { event: { name: '목요집회', date: '2026-12-10', teams: ['찬양팀'], replaces: true, slots: [{ start: '19:00' }] } });
    ok(r.status === 400, 'replacing event must be on Sunday');
    r = await post(su, '/api/admin/saveEvent', { event: Object.assign({}, ev, { replaces: true }) });
    v = r.json;
    ok(v.sunMode[dec[2]] === 'replaced' && !v.schedule.slots[dec[2]]['1'] && v.schedule.slots[dec[2]]['e' + ev.id + '_s1'], 'replacing event removes Sunday services');
    ok(v.events.find(e => e.id === ev.id).replaces === true, 'event marked as replacing');
    ok(v.vols.find(x => x.id === C).stats.now === 4, 'replacing event counts as Sunday');
    ok(v.schedule.slots[dec[2]]['e' + ev.id + '_s1']['인도'][0].id === C, 'replacing event is assigned');
    ok(!calKeys().some(k => k.startsWith(dec[2] + '|') && !k.includes('|e')), 'calendar Sunday entries removed for replaced day');
    // 팀 담당자는 대체 일정을 지우거나 대체를 풀 수 없음
    r = await post(team, '/api/admin/deleteEvent', { id: ev.id });
    ok(r.status === 403, 'team admin cannot delete replacing event');
    // 대체 해제 → 주일 복원, 가능 체크도 그대로 살아남
    r = await post(su, '/api/admin/saveEvent', { event: Object.assign({}, ev, { replaces: false }) });
    ok(!r.json.sunMode[dec[2]] && r.json.schedule.slots[dec[2]]['1'] && r.json.vols.find(x => x.id === C).stats.now === 4, 'unreplace restores Sunday');
    r = await post(su, '/api/admin/setSunMode', { date: dec[1], mode: '' });
    ok(!r.json.sunMode[dec[1]] && r.json.schedule.slots[dec[1]]['2'], 'back to both services');
  }

  /* ---------- 공지 · 봉사자 알림 · 전날 알림 ---------- */
  {
    const S10 = makeServer({ kakaoUsers });
    const su = await S10.login('c1'), team = await S10.login('c3'), va = await S10.login('c4'), vb = await S10.login('c5'), anon = null;
    const post = (who, path, body) => S10.call('POST', path, { cookie: who.cookie, body: Object.assign({ month: M }, body) });
    const get = who => S10.call('GET', '/api/view?month=' + M, who ? { cookie: who.cookie } : {}).then(r => r.json);
    const SUB = n => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/n' + n, keys: { p256dh: 'P' + n, auth: 'A' + n } });
    await post(su, '/api/setup', { code: 'SETUP-123' });
    await post(su, '/api/admin/setAdmin', { kakaoId: '1003', admin: { cats: ['찬양팀'] } });
    await post(va, '/api/mine/save', { name: '방송A', roles: ['음향'], dates: dec.flatMap(both), touched: [M] });
    await post(vb, '/api/mine/save', { name: '찬양B', roles: ['인도'], dates: dec.flatMap(both), touched: [M] });
    for (const [w, n] of [[su, 1], [team, 3], [va, 4], [vb, 5]]) await post(w, '/api/push/subscribe', { subscription: SUB(n) });
    S10.push.sent.length = 0;
    const to = () => S10.push.sent.map(x => x.endpoint.slice(-2)).sort().join();

    // 공지 권한
    let r = await post(team, '/api/admin/saveNotice', { notice: { title: '전체', target: 'all' } });
    ok(r.status === 403, 'team admin cannot post to all');
    r = await post(team, '/api/admin/saveNotice', { notice: { title: '방송', target: '방송팀' } });
    ok(r.status === 403, 'team admin cannot post to other team');
    r = await post(su, '/api/admin/saveNotice', { notice: { title: '', target: 'all' } });
    ok(r.status === 400, 'notice needs title');
    // 팀 공지 → 그 팀 봉사자 + 전체 관리자 (쓴 사람 제외)
    r = await post(team, '/api/admin/saveNotice', { notice: { title: '찬양팀 연습', body: '토요일\n7시', target: '찬양팀' } });
    ok(r.status === 200 && r.json.pushed === 2 && to() === 'n1,n5', 'team notice pushes to team members and super admin');
    ok(S10.push.sent[0].title === '찬양팀 공지 · 찬양팀 연습' && S10.push.sent[0].body === '토요일 7시', 'notice push text');
    const nid = r.json.noticesAdmin[0].id;
    S10.push.sent.length = 0;
    ok((await get(va)).notices.length === 0 && (await get(vb)).notices[0].body === '토요일\n7시', 'team notice visible only to team');
    ok((await get(anon)).notices === undefined, 'not shown when logged out');
    // 수정은 기본으로 알림 안 감
    r = await post(team, '/api/admin/saveNotice', { notice: { id: nid, title: '찬양팀 연습(변경)', target: '찬양팀', pinned: true } });
    ok(r.json.pushed === undefined && S10.push.sent.length === 0 && r.json.notices[0].pinned, 'edit does not push by default');
    // 전체 공지 + 공지 알림 끈 사람 제외
    await post(vb, '/api/push/prefs', { prefs: { notice: false } });
    r = await post(su, '/api/admin/saveNotice', { notice: { title: '성탄 준비', target: 'all', pinned: false } });
    ok(to() === 'n3,n4', 'all notice respects notice pref and skips author');
    S10.push.sent.length = 0;
    const gv = await get(va);
    ok(gv.notices.map(n => n.title).join() === '성탄 준비' && gv.push.prefs.notice === true, 'volunteer sees all notice');
    ok((await get(vb)).notices[0].title === '찬양팀 연습(변경)', 'pinned first');
    // 기간 지난 공지 숨김, 관리 목록엔 남음
    r = await post(su, '/api/admin/saveNotice', { notice: { title: '지난 공지', target: 'all', until: '2020-01-01', push: false } });
    ok(!(await get(va)).notices.some(n => n.title === '지난 공지') && r.json.noticesAdmin.find(n => n.title === '지난 공지').expired, 'expired hidden for users');
    ok((await get(team)).noticesAdmin.every(n => n.target === '찬양팀'), 'team admin manages own team notices only');
    r = await post(team, '/api/admin/deleteNotice', { id: r.json.noticesAdmin.find(n => n.title === '성탄 준비').id });
    ok(r.status === 403, 'team admin cannot delete all notice');
    r = await post(team, '/api/admin/deleteNotice', { id: nid });
    ok(r.status === 200 && !(await get(vb)).notices.some(n => n.id === nid), 'delete notice');

    // 관리자 소식 끄기
    await post(su, '/api/push/prefs', { prefs: { admin: false } });
    S10.push.sent.length = 0;
    await post(team, '/api/admin/setFinal', { cat: '찬양팀' });
    ok(S10.push.sent.length === 0, 'admin pref off stops admin notices');

    // 알림 켠 봉사자 수
    let sv = await get(su);
    ok(sv.pushStats.on === 2 && sv.pushStats.total === 2, 'push stats count duty-enabled volunteers');
    ok((await get(team)).pushStats.total === 1, 'team admin stats limited to team');

    // 전날 알림: 확정된 찬양팀만 → 찬양B에게만 (12/5 20시 실행)
    const SS = require('../functions/src/service');
    S10.push.sent.length = 0;
    let rd = await SS.remindDuty(S10.env.deps, new Date('2026-12-05T11:00:00Z'));
    ok(rd.date === dec[0] && rd.assigned === 1 && to() === 'n5', 'duty reminder only for confirmed team');
    ok(S10.push.sent[0].title === '내일 봉사 안내 · 12월 6일(일)' && /찬양B님, 내일 1부 인도 · 11:00, 2부 인도 · 14:00 봉사가 있어요/.test(S10.push.sent[0].body), 'duty reminder text');
    await post(su, '/api/admin/setFinal', { cat: '방송팀' });
    await post(va, '/api/push/prefs', { prefs: { duty: false } });
    S10.push.sent.length = 0;
    rd = await SS.remindDuty(S10.env.deps, new Date('2026-12-05T11:00:00Z'));
    ok(rd.assigned === 2 && rd.people === 1 && to() === 'n5', 'duty pref off respected');
    rd = await SS.remindDuty(S10.env.deps, new Date('2026-12-06T11:00:00Z'));
    ok(rd.assigned === 0 && rd.sent === 0, 'no duty on Monday');
  }

  /* ---------- 홈 화면 앱 설치 표시 ---------- */
  {
    const S11 = makeServer({ kakaoUsers });
    const su = await S11.login('c1'), va = await S11.login('c4'), vb = await S11.login('c5');
    const post = (who, path, body) => S11.call('POST', path, { cookie: who.cookie, body: Object.assign({ month: M }, body) });
    await post(su, '/api/setup', { code: 'SETUP-123' });
    await post(va, '/api/mine/save', { name: '앱씀', roles: ['음향'], dates: [], touched: [M] });
    await post(vb, '/api/mine/save', { name: '앱안씀', roles: ['인도'], dates: [], touched: [M] });
    let r = await S11.call('POST', '/api/mine/app', { body: {} });
    ok(r.status === 401, 'app mark needs login');
    r = await post(va, '/api/mine/app', {});
    const v0 = S11.adapter.v;
    await post(va, '/api/mine/app', {});
    ok(r.status === 200 && S11.adapter.v === v0, 'app mark once per day');
    const sv = (await S11.call('GET', '/api/view?month=' + M, { cookie: su.cookie })).json;
    ok(sv.pushStats.app === 1 && sv.pushStats.total === 2 && sv.vols.find(x => x.name === '앱씀').app === true && sv.vols.find(x => x.name === '앱안씀').app === false, 'admin sees who installed the app');
    const pv = (await S11.call('GET', '/api/view?month=' + M, { cookie: vb.cookie })).json;
    ok(pv.vols.every(x => x.app === undefined), 'install info hidden from volunteers');
  }

  /* ---------- 다음 달 일정 입력 알림 (마지막 주 월요일 · 목요일) ---------- */
  {
    const SS = require('../functions/src/service');
    const P = d => JSON.stringify(SS.inputPlan(d));
    ok(P('2026-11-30') === JSON.stringify({ kind: 'notice', month: '2026-12', due: '2026-12-03' }), 'last Monday of Nov → notice for Dec, due Thu 12/3');
    ok(P('2026-12-03') === JSON.stringify({ kind: 'reminder', month: '2026-12', due: '2026-12-03' }), 'Thursday after last Monday (next month) → reminder for Dec');
    ok(P('2026-11-23') === 'null' && P('2026-11-26') === 'null' && P('2026-12-01') === 'null', 'other days do nothing');
    ok(SS.inputPlan('2026-12-28').kind === 'notice' && SS.inputPlan('2026-12-28').month === '2027-01' && SS.inputPlan('2026-12-31').kind === 'reminder', 'December → January across the year');

    const S12 = makeServer({ kakaoUsers });
    const su = await S12.login('c1'), va = await S12.login('c4'), vb = await S12.login('c5'), vc = await S12.login('c6');
    const post = (who, path, body) => S12.call('POST', path, { cookie: who.cookie, body: Object.assign({ month: M }, body) });
    const SUB = n => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/i' + n, keys: { p256dh: 'P' + n, auth: 'A' + n } });
    await post(su, '/api/setup', { code: 'SETUP-123' });
    // 11월에 가입해서 12월은 아직 안 넣은 상태
    for (const [w, n, r] of [[va, '가', '음향'], [vb, '나', '인도'], [vc, '다', '드럼']]) await post(w, '/api/mine/save', { month: '2026-11', name: n, roles: [r], dates: [], touched: ['2026-11'] });
    for (const [w, n] of [[su, 1], [va, 4], [vb, 5], [vc, 6]]) await post(w, '/api/push/subscribe', { subscription: SUB(n) });
    await post(vc, '/api/push/prefs', { prefs: { input: false } });
    S12.push.sent.length = 0;
    let r = await SS.remindInput(S12.env.deps, new Date('2026-11-30T05:00:00Z')); // 11/30(월) 14시
    ok(r.kind === 'notice' && r.month === M && r.sent === 2 && S12.push.sent.map(x => x.endpoint.slice(-2)).sort().join() === 'i4,i5', 'Monday notice to volunteers (pref respected), not admins');
    ok(S12.push.sent[0].title === '12월 봉사 일정 입력 안내' && S12.push.sent[0].body.includes('목요일(12/3)까지') && S12.push.sent[0].url === '/?tab=input&month=' + M, 'notice text');
    // '가'는 수요일에 입력, '나'는 안 함
    await post(va, '/api/mine/save', { name: '가', roles: ['음향'], dates: both(dec[0]), touched: [M] });
    S12.push.sent.length = 0;
    r = await SS.remindInput(S12.env.deps, new Date('2026-12-03T05:00:00Z'));
    const ends = S12.push.sent.map(x => x.endpoint.slice(-2) + ':' + x.title);
    ok(r.kind === 'reminder' && r.missing.join() === '나,다' && ends.includes('i5:12월 봉사 일정을 기다리고 있어요') && ends.includes('i1:12월 일정 미입력 2명') && ends.length === 2, 'Thursday reminder only to those still missing, plus admin list');
    S12.push.sent.length = 0;
    r = await SS.remindInput(S12.env.deps, new Date('2026-12-02T05:00:00Z'));
    ok(r.kind === null && S12.push.sent.length === 0, 'Wednesday sends nothing');
    const pv = (await S12.call('GET', '/api/view?month=' + M, { cookie: vb.cookie })).json;
    ok(pv.push.prefs.input === true && pv.push.inputHour === 14, 'input pref and hour in view');
  }

  summary();
})().catch(e => { console.error(e); process.exitCode = 1; });
