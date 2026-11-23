/**
 * 배정 계산과 화면 데이터 만들기 (저장소와 무관한 순수 로직)
 *
 * ctx = {
 *   cats:      [{ name, bothServices, usePriority }],
 *   roles:     [{ cat, name, count }],
 *   vols:      [{ id, name, roles, dates, lockedCats, svcLock, prio, kakaoId }],
 *              prio: { 팀: 'high' | 'low' }  관리자 배정 우선순위 (usePriority 팀만, 관리자에게만 보임)
 *   events:    [{ id, name, date, teams, slots: [{ k, label, start, end }] }],
 *   confirmed: { 'YYYY-MM|팀': slots },
 *   overrides: { 'YYYY-MM': { 날짜: { 시간대: { 역할: [봉사자ID] } } } },
 *   serviceTimes: { '1': ['09:00','10:30'], '2': [...] },
 * }
 * slots 구조: slots[날짜][시간대][역할] = [{ id, name, manual? }]
 *   시간대는 주일 '1','2' 또는 이벤트 'e<이벤트ID>_s<번호>'
 * 가능한 일정 키: '2026-12-06|1', '2026-12-24|eab12cd_s1'
 */
'use strict';

const SERVICES = ['1', '2'];
// 배정 우선순위: '자주'는 점수를 빼고 '가끔'은 더합니다. 20점이면 이번 달 주일 2회 정도 차이를 뒤집습니다.
const PRIORITIES = ['high', 'low'];
const PRIO_WEIGHT = 20;
const usesPrio = (ctx, cat) => !!(ctx.cats.find(c => c.name === cat) || {}).usePriority;

class UserError extends Error {
  constructor(message, code) { super(message); this.code = code || 'bad_request'; }
}
const fail = (msg, code) => { throw new UserError(msg, code); };

const uniq = a => Array.from(new Set(a));
const pad = n => String(n).padStart(2, '0');
const monthKey = d => d.getFullYear() + '-' + pad(d.getMonth() + 1);
function shiftMonth(key, n) { const p = key.split('-').map(Number); return monthKey(new Date(p[0], p[1] - 1 + n, 1)); }
function sundays(key) {
  const p = key.split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, 1);
  const out = [];
  while (d.getDay() !== 0) d.setDate(d.getDate() + 1);
  while (d.getMonth() === p[1] - 1) {
    out.push(d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()));
    d.setDate(d.getDate() + 7);
  }
  return out;
}
function hash32(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function eachCell(slots, fn) {
  Object.keys(slots || {}).forEach(d => Object.keys(slots[d] || {}).forEach(s =>
    Object.keys(slots[d][s] || {}).forEach(r => fn(d, s, r, slots[d][s][r] || []))));
}

/* ---------- 입력 정리 ---------- */
const catNames = ctx => ctx.cats.map(c => c.name);
const bothOk = (ctx, cat) => !!(ctx.cats.find(c => c.name === cat) || {}).bothServices;
function checkMonth(m) { if (!/^\d{4}-\d{2}$/.test(String(m))) fail('월 형식이 잘못됐어요.'); return String(m); }
function checkCat(ctx, c) { if (catNames(ctx).indexOf(String(c)) < 0) fail('팀 이름이 잘못됐어요.'); return String(c); }
// 맨 앞의 = + - @ 는 스프레드시트로 내보낼 때 수식으로 해석될 수 있어 지웁니다.
function plain(s) { return String(s == null ? '' : s).trim().replace(/^[=+\-@\s]+/, ''); }
function cleanName(n) { const s = plain(n).slice(0, 20); if (!s) fail('이름을 입력해 주세요.'); return s; }
const SLOT_RE = /^\d{4}-\d{2}-\d{2}\|(?:[12]|e[a-z0-9]+_s\d+)$/;
function cleanSlots(list) {
  return uniq((Array.isArray(list) ? list : []).map(x => String(x).trim()).filter(x => SLOT_RE.test(x))).sort();
}
function cleanIds(ids) { return uniq((Array.isArray(ids) ? ids : []).map(String).filter(x => /^[A-Za-z0-9_-]{1,40}$/.test(x))); }

/* ---------- 예배·이벤트 시간대 ---------- */
// 그 주일에 열리는 부: 특별 일정으로 대체됐으면 없음, '1부만'·'2부만'이면 하나
const SUN_MODES = { only1: ['1'], only2: ['2'] };
function sunServices(ctx, d) {
  if ((ctx.events || []).some(e => e.replaces && e.date === d)) return [];
  return SUN_MODES[(ctx.sunMode || {})[d]] || SERVICES;
}
// occasions의 counts: 봉사 횟수에 넣는 시간대 (주일 예배, 주일을 대체한 특별 일정)
function occasions(ctx, month) {
  const out = [];
  sundays(month).forEach(d => sunServices(ctx, d).forEach(s => out.push({
    d, s, group: 'sun', sunday: true, counts: true, roles: ctx.roles, label: s + '부', evName: '',
    start: ((ctx.serviceTimes || {})[s] || [])[0] || '09:00', end: ((ctx.serviceTimes || {})[s] || [])[1] || '',
  })));
  (ctx.events || []).filter(e => e.date.indexOf(month) === 0).forEach(e => e.slots.forEach(sl => out.push({
    d: e.date, s: 'e' + e.id + '_' + sl.k, group: 'e' + e.id, sunday: false, counts: !!e.replaces, eventId: e.id, evName: e.name,
    roles: ctx.roles.filter(r => e.teams.indexOf(r.cat) >= 0), label: sl.label || '', start: sl.start || '', end: sl.end || '',
  })));
  out.sort((a, b) => a.d.localeCompare(b.d) || (a.sunday === b.sunday ? 0 : a.sunday ? -1 : 1));
  return out;
}
function occOf(ctx, month, date, svc) {
  const o = occasions(ctx, month).find(x => x.d === String(date) && x.s === String(svc));
  if (!o) fail('해당 예배나 이벤트 시간대를 찾을 수 없어요. 새로고침해 주세요.');
  return o;
}

/* ---------- 자동 배정 ----------
 * 점수(낮을수록 먼저 배정, 횟수는 '봉사한 주일 수'로 셉니다)
 *  · 이번 달 봉사한 주일 1회당 +10, 지난달 1회당 +4, 전전달 1회당 +2
 *  · 바로 지난 주일에 봉사 +6
 *  · 이번 달 같은 역할 1회당 +2, 지난 두 달 같은 역할 1회당 +1
 *  · 같은 예배(1·2부) 또는 같은 이벤트에서 이미 섬기는 사람 -10, 같은 역할이면 추가 -5 (찬양팀이 이어지도록)
 * 규칙
 *  · 한 시간대에서 한 사람은 한 역할만
 *  · 같은 예배·이벤트의 여러 시간대는 두 배정 모두 bothServices 팀일 때만
 *  · '부 고정'은 주일에만 적용
 *  · 이벤트 봉사는 횟수에 넣지 않음 (단, 주일을 대체한 특별 일정은 주일처럼 셈)
 * 확정된 팀의 배정과 수동으로 정한 칸은 고정한 채로 나머지를 채웁니다.
 */
// counted: 횟수에 넣을 'd|s' 집합 (없으면 주일 1·2부만)
function countedKeys(ctx, month) { return new Set(occasions(ctx, month).filter(o => o.counts).map(o => o.d + '|' + o.s)); }
function countServed(slots, roleCat, cats, counted) {
  const days = {}, perRole = {};
  eachCell(slots, (d, s, r, ps) => {
    if (counted ? !counted.has(d + '|' + s) : SERVICES.indexOf(s) < 0) return;
    if (cats && cats.indexOf(roleCat[r]) < 0) return;
    ps.forEach(p => { (days[p.id] = days[p.id] || {})[d] = 1; perRole[p.id + '|' + r] = (perRole[p.id + '|' + r] || 0) + 1; });
  });
  const n = {};
  Object.keys(days).forEach(id => { n[id] = Object.keys(days[id]).length; });
  return { n, perRole };
}

function history(ctx, key, depth, roleCat, memo) {
  const h = {}, hr = {}, prev = new Set();
  if (depth <= 0) return { h, hr, prev };
  [[1, 4], [2, 2]].forEach(([n, w]) => {
    const k = shiftMonth(key, -n);
    const s = buildSchedule(ctx, k, depth - 1, memo);
    const counted = countedKeys(ctx, k);
    const c = countServed(s, roleCat, null, counted);
    Object.keys(c.n).forEach(id => { h[id] = (h[id] || 0) + c.n[id] * w; });
    Object.keys(c.perRole).forEach(x => { hr[x] = (hr[x] || 0) + c.perRole[x]; });
    if (n === 1) {
      const last = Array.from(counted).map(x => x.slice(0, 10)).sort().slice(-1)[0];
      if (last) eachCell({ [last]: s[last] || {} }, (d, sv, r, ps) => { if (counted.has(d + '|' + sv)) ps.forEach(p => prev.add(p.id)); });
    }
  });
  return { h, hr, prev };
}

function buildSchedule(ctx, key, depth, memo) {
  if (depth === undefined) depth = 2;
  memo = memo || {};
  const mk = key + '@' + depth;
  if (memo[mk]) return memo[mk];
  const roleCat = {};
  ctx.roles.forEach(r => { roleCat[r.name] = r.cat; });
  const nameOf = id => (ctx.vols.find(v => v.id === id) || {}).name || '(삭제된 봉사자)';

  const occ = occasions(ctx, key);
  const occAt = {};
  occ.forEach(o => { occAt[o.d + '|' + o.s] = o; });
  const hasRole = (o, r) => o.roles.some(x => x.name === r);

  const fixed = {};
  const setFixed = (d, s, r, ps) => {
    const o = occAt[d + '|' + s];
    if (!roleCat[r] || !o || !hasRole(o, r)) return;
    ((fixed[d] = fixed[d] || {})[s] = fixed[d][s] || {})[r] = ps;
  };
  const finalCats = catNames(ctx).filter(c => ctx.confirmed[key + '|' + c]);
  finalCats.forEach(c => eachCell(ctx.confirmed[key + '|' + c], (d, s, r, ps) =>
    setFixed(d, s, r, ps.map(p => ({ id: p.id, name: nameOf(p.id) === '(삭제된 봉사자)' ? p.name : nameOf(p.id), manual: !!p.manual })))));
  eachCell(ctx.overrides[key] || {}, (d, s, r, ids) => {
    if (finalCats.indexOf(roleCat[r]) >= 0) return;
    setFixed(d, s, r, ids.map(id => ({ id, name: nameOf(id), manual: true })));
  });

  const H = history(ctx, key, depth, roleCat, memo);
  let prev = H.prev;
  const total = {}, perRole = {}, slots = {};

  uniq(occ.map(o => o.d)).forEach(d => {
    const dayOcc = occ.filter(o => o.d === d);
    slots[d] = {};
    const used = {};
    dayOcc.forEach(o => { slots[d][o.s] = {}; used[o.s] = new Set(); });
    const on = {};
    const servedToday = new Set();
    const inGroup = {};
    const place = (id, o, r) => {
      used[o.s].add(id);
      (on[id] = on[id] || {})[o.s] = { cat: roleCat[r], group: o.group };
      (inGroup[o.group] = inGroup[o.group] || new Set()).add(id);
      if (o.counts) {
        if (!servedToday.has(id)) { servedToday.add(id); total[id] = (total[id] || 0) + 1; }
        perRole[id + '|' + r] = (perRole[id + '|' + r] || 0) + 1;
      }
    };
    dayOcc.forEach(o => {
      const f = (fixed[d] || {})[o.s] || {};
      Object.keys(f).forEach(r => { slots[d][o.s][r] = f[r]; f[r].forEach(p => place(p.id, o, r)); });
    });

    const tasks = [];
    dayOcc.forEach((o, oi) => o.roles.forEach((r, ri) => {
      if (((fixed[d] || {})[o.s] || {})[r.name]) return;
      tasks.push({ o, r, oi, ri, cands: ctx.vols.filter(v => v.roles.indexOf(r.name) >= 0 &&
        v.dates.indexOf(d + '|' + o.s) >= 0 && (!o.sunday || !v.svcLock[r.cat] || v.svcLock[r.cat] === o.s)) });
    }));
    tasks.sort((a, b) => a.cands.length / a.r.count - b.cands.length / b.r.count || a.oi - b.oi || a.ri - b.ri);

    tasks.forEach(t => {
      const o = t.o;
      const prioOn = usesPrio(ctx, t.r.cat);
      const ok = v => {
        if (used[o.s].has(v.id)) return false;
        return Object.keys(on[v.id] || {}).every(s2 => {
          const x = on[v.id][s2];
          return x.group !== o.group || (bothOk(ctx, x.cat) && bothOk(ctx, t.r.cat));
        });
      };
      const sameRoleElsewhere = v => dayOcc.some(o2 => o2.group === o.group && o2.s !== o.s &&
        ((slots[d][o2.s] || {})[t.r.name] || []).some(p => p.id === v.id));
      const score = v => {
        const k = v.id + '|' + t.r.name;
        let sc = (total[v.id] || 0) * 10 + (H.h[v.id] || 0) + (prev.has(v.id) ? 6 : 0) + (perRole[k] || 0) * 2 + (H.hr[k] || 0);
        if (prioOn) {
          const p = (v.prio || {})[t.r.cat];
          if (p === 'high') sc -= PRIO_WEIGHT; else if (p === 'low') sc += PRIO_WEIGHT;
        }
        if ((inGroup[o.group] || new Set()).has(v.id)) {
          sc -= 10;
          if (sameRoleElsewhere(v)) sc -= 5;
        }
        return sc;
      };
      const pick = [];
      for (let i = 0; i < t.r.count; i++) {
        const cand = t.cands.filter(ok).sort((a, b) => score(a) - score(b) || hash32(a.id + d + o.s) - hash32(b.id + d + o.s))[0];
        if (!cand) break;
        pick.push({ id: cand.id, name: cand.name });
        place(cand.id, o, t.r.name);
      }
      slots[d][o.s][t.r.name] = pick;
    });
    if (dayOcc.some(o => o.counts)) prev = servedToday;
  });
  memo[mk] = slots;
  return slots;
}

/* ---------- 화면 데이터 ---------- */
const eventView = e => ({ id: e.id, name: e.name, date: e.date, teams: e.teams, slots: e.slots, replaces: !!e.replaces });
const publicVol = v => ({ id: v.id, name: v.name, roles: v.roles, lockedCats: v.lockedCats, svcLock: v.svcLock, linked: !!v.kakaoId });
const mineView = v => (v ? Object.assign(publicVol(v), { dates: v.dates }) : null);

// 누구나 받는 데이터: 개인별 가능한 일정은 포함하지 않습니다.
function publicView(ctx, month, memo) {
  memo = memo || {};
  const dayCounts = {};
  occasions(ctx, month).forEach(o => {
    dayCounts[o.d + '|' + o.s] = ctx.vols.filter(v => v.dates.indexOf(o.d + '|' + o.s) >= 0).length;
  });
  return {
    month,
    cats: ctx.cats.map(c => ({ name: c.name, bothServices: !!c.bothServices, usePriority: !!c.usePriority })),
    roles: ctx.roles,
    vols: ctx.vols.map(publicVol),
    schedule: { slots: buildSchedule(ctx, month, 2, memo), finalCats: catNames(ctx).filter(c => ctx.confirmed[month + '|' + c]) },
    dayCounts,
    events: (ctx.events || []).filter(e => e.date.indexOf(month) === 0).map(eventView),
    // 평소와 다른 주일: { 날짜: 'only1' | 'only2' | 'replaced' }
    sunMode: sundays(month).reduce((m, d) => {
      const svcs = sunServices(ctx, d);
      if (!svcs.length) m[d] = 'replaced'; else if (svcs.length === 1) m[d] = 'only' + svcs[0];
      return m;
    }, {}),
  };
}

// 관리자 권한: { all: true } 또는 { cats: ['찬양팀'] }
function editableCats(ctx, admin) {
  if (!admin) return [];
  return admin.all ? catNames(ctx) : (admin.cats || []).filter(c => catNames(ctx).indexOf(c) >= 0);
}
function needCat(ctx, admin, cat) {
  if (editableCats(ctx, admin).indexOf(cat) < 0) fail(`이 계정으로는 ${cat} 팀을 관리할 수 없어요.`, 'forbidden');
}

function adminExtras(ctx, month, admin, view, memo) {
  const cats = editableCats(ctx, admin);
  const roleCat = {};
  ctx.roles.forEach(r => { roleCat[r.name] = r.cat; });
  const now = countServed(view.schedule.slots, roleCat, cats, countedKeys(ctx, month)).n;
  const recent = {};
  [1, 2].forEach(n => {
    const pm = shiftMonth(month, -n);
    const c = countServed(buildSchedule(ctx, pm, 1, memo), roleCat, cats, countedKeys(ctx, pm)).n;
    Object.keys(c).forEach(id => { recent[id] = (recent[id] || 0) + c[id]; });
  });
  view.admin = { all: !!admin.all, cats };
  view.vols = ctx.vols.map(v => {
    const dates = v.dates.filter(x => x.indexOf(month) === 0);
    const prio = {};
    cats.forEach(c => { if (usesPrio(ctx, c) && (v.prio || {})[c]) prio[c] = v.prio[c]; });
    return Object.assign(publicVol(v), {
      dates,
      prio,
      stats: { now: now[v.id] || 0, recent: recent[v.id] || 0, avail: uniq(dates.map(x => x.slice(0, 10))).length },
    });
  });
  view.overrides = ctx.overrides[month] || {};
  const from = shiftMonth(month, -1);
  view.allEvents = (ctx.events || []).filter(e => e.date.slice(0, 7) >= from).map(e => Object.assign(eventView(e), {
    editable: e.teams.every(t => cats.indexOf(t) >= 0),
  }));
  return view;
}

module.exports = {
  SERVICES, PRIORITIES, PRIO_WEIGHT, usesPrio, UserError, fail, uniq, shiftMonth, sundays, eachCell, catNames, bothOk,
  checkMonth, checkCat, plain, cleanName, cleanSlots, cleanIds,
  occasions, occOf, sunServices, countedKeys, buildSchedule, countServed, publicView, adminExtras, editableCats, needCat,
  eventView, publicVol, mineView,
};
