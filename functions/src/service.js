/**
 * 화면 요청 처리
 *
 * deps = {
 *   store, config,
 *   calendar: makeCalendarClient(...) 또는 null(연동 안 함),
 *   calendarLinks: { google, ical } 또는 null,
 *   kakaoReady: boolean,
 *   setupCode: 관리자 설정 코드(비어 있으면 첫 관리자 설정 불가),
 *   push: { publicKey, send(sub, payload), recent: Map } 또는 null(알림 안 씀),
 * }
 * auth = { kakaoId } 또는 null
 */
'use strict';

const crypto = require('crypto');
const L = require('./logic');
const { eventTimes } = require('./calendar');
const { safeEq } = require('./auth');
const P = require('./push');

const { fail, uniq } = L;
const nowIso = () => new Date().toISOString();
const newId = n => crypto.randomBytes(8).toString('hex').slice(0, n || 8);

/* ---------- 데이터 → 계산용 ctx ---------- */
function ctxOf(data, config) {
  const cats = config.CATEGORIES;
  const catSet = cats.map(c => c.name);
  const roles = (data.roles && data.roles.length ? data.roles : config.DEFAULT_ROLES).filter(r => catSet.indexOf(r.cat) >= 0);
  const vols = Object.values(data.vols).map(v => ({
    id: v.id, name: v.name, roles: v.roles || [], dates: v.dates || [],
    lockedCats: (v.lockedCats || []).filter(c => catSet.indexOf(c) >= 0), svcLock: v.svcLock || {}, prio: v.prio || {}, kakaoId: v.kakaoId || '',
  })).sort((a, b) => a.id.localeCompare(b.id));
  const events = Object.values(data.events)
    .filter(e => e.name && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && (e.slots || []).length && (e.teams || []).some(t => catSet.indexOf(t) >= 0))
    .map(e => ({ id: e.id, name: e.name, date: e.date, teams: e.teams.filter(t => catSet.indexOf(t) >= 0), slots: e.slots, replaces: !!e.replaces }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  const confirmed = {}, overrides = {}, sunMode = {};
  Object.keys(data.months).forEach(m => {
    const doc = data.months[m] || {};
    overrides[m] = doc.overrides || {};
    Object.assign(sunMode, doc.sunMode || {});
    Object.keys(doc.finals || {}).forEach(c => { confirmed[m + '|' + c] = doc.finals[c]; });
  });
  return { cats, roles, vols, events, confirmed, overrides, sunMode, serviceTimes: config.SERVICE_TIMES };
}

const adminOf = u => (u && u.admin && (u.admin.all || (u.admin.cats || []).length) ? { all: !!u.admin.all, cats: u.admin.all ? [] : (u.admin.cats || []) } : null);
const hasSuper = data => Object.values(data.users).some(u => u.admin && u.admin.all);

/* ---------- 팀 이름 변경 반영 ---------- */
// config.RENAMED_CATEGORIES에 있는 예전 팀 이름을 저장된 모든 데이터에서 새 이름으로 바꿉니다.
// 서버가 켜진 뒤 첫 요청에서 한 번만 확인하고, 바꿀 것이 없으면 아무것도 쓰지 않습니다.
function renameCats(tx, map) {
  const nm = c => (Object.prototype.hasOwnProperty.call(map, c) ? map[c] : c);
  const keys = o => { const r = {}; Object.keys(o || {}).forEach(k => { r[nm(k)] = o[k]; }); return r; };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const d = tx.data;
  const roles = (d.roles || []).map(r => Object.assign({}, r, { cat: nm(r.cat) }));
  if (!same(roles, d.roles || [])) tx.setRoles(roles);
  Object.values(d.vols).forEach(v => {
    const n = Object.assign({}, v);
    if (v.lockedCats) n.lockedCats = uniq(v.lockedCats.map(nm));
    if (v.svcLock) n.svcLock = keys(v.svcLock);
    if (v.prio) n.prio = keys(v.prio);
    if (!same(n, v)) tx.putVol(n);
  });
  Object.values(d.events).forEach(e => {
    const n = Object.assign({}, e, { teams: uniq((e.teams || []).map(nm)) });
    if (!same(n, e)) tx.putEvent(n);
  });
  Object.keys(d.months).forEach(m => {
    const doc = d.months[m] || {};
    if (!doc.finals) return;
    const n = Object.assign({}, doc, { finals: keys(doc.finals) });
    if (!same(n, doc)) tx.putMonth(m, n);
  });
  Object.values(d.users).forEach(u => {
    if (!u.admin || !u.admin.cats) return;
    const n = Object.assign({}, u, { admin: Object.assign({}, u.admin, { cats: uniq(u.admin.cats.map(nm)) }) });
    if (!same(n, u)) tx.putUser(n);
  });
  Object.keys(d.calendar).forEach(k => {
    const [m, c] = k.split('|');
    if (nm(c) === c) return;
    const nk = m + '|' + nm(c);
    tx.putCal(nk, d.calendar[nk] ? { map: Object.assign({}, d.calendar[k].map, d.calendar[nk].map) } : d.calendar[k]);
    tx.putCal(k, null);
  });
}
async function migrate(deps) {
  const map = deps.config.RENAMED_CATEGORIES || {};
  if (!Object.keys(map).length || deps.store.catsChecked) return;
  try {
    await deps.store.transact(tx => renameCats(tx, map));
    deps.store.catsChecked = true;
  } catch (e) { console.error('팀 이름 변경 반영 실패', e); }
}

/* ---------- 보기 ---------- */
async function view(deps, auth, q) {
  const data = await deps.store.read();
  const ctx = ctxOf(data, deps.config);
  const month = L.checkMonth(q.month);
  const memo = {};
  const v = L.publicView(ctx, month, memo);
  v.appName = deps.config.APP_NAME;
  v.kakaoReady = !!deps.kakaoReady;
  v.calendar = deps.calendarLinks || null;
  v.me = null;
  if (auth) {
    const u = data.users[auth.kakaoId] || null;
    const admin = adminOf(u);
    v.me = { nickname: (u && u.nickname) || '', vol: L.mineView(ctx.vols.find(x => x.kakaoId === auth.kakaoId)), admin };
    v.setupNeeded = !hasSuper(data) && !!deps.setupCode;
    if (admin) {
      L.adminExtras(ctx, month, admin, v, memo);
      v.calendarReady = !!deps.calendar;
      if (admin.all) {
        v.users = Object.values(data.users).map(x => {
          const vol = ctx.vols.find(y => y.kakaoId === x.kakaoId);
          return { kakaoId: x.kakaoId, nickname: x.nickname || '', volName: vol ? vol.name : '', admin: adminOf(x), lastLogin: x.lastLogin || '', me: x.kakaoId === auth.kakaoId };
        }).sort((a, b) => (b.admin ? 1 : 0) - (a.admin ? 1 : 0) || (a.volName || a.nickname).localeCompare(b.volName || b.nickname, 'ko'));
        v.push = deps.push
          ? { publicKey: deps.push.publicKey, devices: Object.values(data.push).filter(s => s.kakaoId === auth.kakaoId).length, remindDay: (deps.config.REMIND || {}).day || 20 }
          : null;
      }
    }
  }
  return v;
}

/* ---------- 로그인 기록 ---------- */
async function recordLogin(deps, kakaoId, nickname) {
  await deps.store.transact(tx => {
    const u = tx.data.users[kakaoId] || { kakaoId, admin: null };
    tx.putUser(Object.assign({}, u, { kakaoId, nickname: nickname || u.nickname || '', lastLogin: nowIso() }));
  });
}

/* ---------- 본인 ---------- */
function needLogin(auth) { if (!auth) fail('로그인이 필요해요. 카카오로 다시 로그인해 주세요.', 'login_required'); }

// 처음 로그인한 사람이 목록에 있는 자기 이름과 카카오 계정을 연결합니다.
async function linkMine(deps, auth, body) {
  needLogin(auth);
  const linked = await deps.store.transact(tx => {
    const vols = Object.values(tx.data.vols);
    if (vols.some(v => v.kakaoId === auth.kakaoId)) fail('이 카카오 계정은 이미 다른 이름과 연결돼 있어요.');
    const v = tx.data.vols[String(body.volId || '')];
    if (!v) fail('봉사자를 찾을 수 없어요. 새로고침해 주세요.');
    if (v.kakaoId) fail(`'${v.name}'님은 이미 다른 카카오 계정과 연결돼 있어요. 본인이라면 관리자에게 연결 해제를 요청해 주세요.`);
    tx.putVol(Object.assign({}, v, { kakaoId: auth.kakaoId, updatedAt: nowIso() }));
    return v;
  });
  await notifySafe(deps, { title: '새 봉사자 연결', body: `${linked.name}님이 카카오 계정으로 이름을 연결했어요.`, url: '/?tab=settings', tag: 'vol-' + linked.id }, { except: auth.kakaoId });
  return view(deps, auth, { month: body.month });
}

/**
 * 로그인한 본인의 정보 저장 (처음이면 새로 등록)
 * body = { name, roles, dates, touched: ['2026-12'], month }
 * touched에 있는 달의 일정만 바꾸고, 관리자가 역할을 고정한 팀의 역할은 바꾸지 않습니다.
 */
async function saveMine(deps, auth, body) {
  needLogin(auth);
  const month = L.checkMonth(body.month);
  const name = L.cleanName(body.name);
  const touched = (Array.isArray(body.touched) ? body.touched : []).map(String).filter(m => /^\d{4}-\d{2}$/.test(m));
  const dates = L.cleanSlots(body.dates).filter(x => touched.indexOf(x.slice(0, 7)) >= 0);
  const saved = await deps.store.transact(tx => {
    const ctx = ctxOf(tx.data, deps.config);
    const roleCat = {};
    ctx.roles.forEach(r => { roleCat[r.name] = r.cat; });
    let v = Object.values(tx.data.vols).find(x => x.kakaoId === auth.kakaoId);
    const dup = Object.values(tx.data.vols).find(x => x.name === name && (!v || x.id !== v.id));
    if (dup) {
      fail(v ? `'${name}' 이름은 다른 봉사자가 쓰고 있어요.`
        : `'${name}' 이름이 이미 목록에 있어요. 본인이라면 '목록에서 내 이름 찾기'로 연결해 주세요.`);
    }
    const isNew = !v;
    v = v ? Object.assign({}, v) : { id: newId(), roles: [], dates: [], lockedCats: [], svcLock: {}, kakaoId: auth.kakaoId };
    const locked = v.lockedCats || [];
    const asked = (Array.isArray(body.roles) ? body.roles : []).map(String).filter(r => roleCat[r]);
    const roles = (v.roles || []).filter(r => locked.indexOf(roleCat[r]) >= 0).concat(asked.filter(r => locked.indexOf(roleCat[r]) < 0));
    if (!roles.length) fail('맡을 수 있는 역할을 하나 이상 골라 주세요.');
    v.name = name;
    v.roles = uniq(roles);
    v.dates = uniq((v.dates || []).filter(x => touched.indexOf(x.slice(0, 7)) < 0).concat(dates)).sort();
    v.savedMonths = uniq((v.savedMonths || []).concat(touched)).sort().slice(-24);
    v.updatedAt = nowIso();
    tx.putVol(v);
    return { v, isNew, teams: uniq(v.roles.map(r => roleCat[r])) };
  });
  const { v, isNew, teams } = saved;
  const mLabel = m => +m.slice(5) + '월';
  const months = touched.slice().sort();
  const n = v.dates.filter(x => months.indexOf(x.slice(0, 7)) >= 0).length;
  const what = months.length ? `${months.map(mLabel).join('·')} 가능 예배 ${n}회` : '';
  if (isNew) {
    await notifySafe(deps, { title: '새 봉사자 가입', body: `${v.name}님이 가입했어요 (${teams.join('·')})${what ? '. ' + what : ''}`, url: '/?tab=settings&month=' + month, tag: 'vol-' + v.id }, { except: auth.kakaoId });
  } else if (months.length) {
    await notifySafe(deps, { title: '봉사 일정 입력', body: `${v.name}님이 ${what}를 저장했어요.`, url: '/?tab=settings&month=' + (months[0] || month), tag: 'vol-' + v.id },
      { except: auth.kakaoId, throttleKey: 'dates:' + v.id });
  }
  return view(deps, auth, { month });
}

/* ---------- 첫 관리자 설정 ---------- */
async function setup(deps, auth, body) {
  needLogin(auth);
  if (!deps.setupCode) fail('관리자 설정 코드가 등록돼 있지 않아요. README의 비밀 값 등록을 확인해 주세요.');
  if (!safeEq(String(body.code || '').trim(), deps.setupCode)) fail('설정 코드가 맞지 않아요.', 'forbidden');
  await deps.store.transact(tx => {
    if (hasSuper(tx.data)) fail('이미 전체 관리자가 있어요. 전체 관리자에게 권한을 요청해 주세요.', 'forbidden');
    const u = tx.data.users[auth.kakaoId] || { kakaoId: auth.kakaoId, nickname: '' };
    tx.putUser(Object.assign({}, u, { admin: { all: true, cats: [] } }));
  });
  return view(deps, auth, { month: body.month });
}

/* ---------- 관리자 ---------- */
const ADMIN = {};

// 봉사자 미리 등록 또는 수정. 팀 담당자는 자기 팀 부분만 바뀝니다.
ADMIN.saveVolunteer = (tx, ctx, admin, b) => {
  const cats = L.editableCats(ctx, admin);
  const roleCat = {};
  ctx.roles.forEach(r => { roleCat[r.name] = r.cat; });
  const name = L.cleanName(b.name);
  const curRaw = b.id ? tx.data.vols[String(b.id)] : null;
  if (b.id && !curRaw) fail('봉사자를 찾을 수 없어요.');
  if (Object.values(tx.data.vols).some(x => x.name === name && (!curRaw || x.id !== curRaw.id))) fail(`'${name}' 이름이 이미 있어요.`);
  const cur = curRaw ? clone(curRaw) : { id: newId(), roles: [], dates: [], lockedCats: [], svcLock: {}, kakaoId: '' };
  const mine = r => cats.indexOf(roleCat[r]) >= 0;
  cur.roles = uniq((cur.roles || []).filter(r => !mine(r)).concat((Array.isArray(b.roles) ? b.roles : []).map(String).filter(r => roleCat[r] && mine(r))));
  cur.lockedCats = uniq((cur.lockedCats || []).filter(c => cats.indexOf(c) < 0).concat((Array.isArray(b.lockedCats) ? b.lockedCats : []).filter(c => cats.indexOf(c) >= 0)));
  cur.svcLock = Object.assign({}, cur.svcLock || {});
  cats.forEach(c => {
    const s = String(((b.svcLock || {})[c]) || '');
    if (L.SERVICES.indexOf(s) >= 0) cur.svcLock[c] = s; else delete cur.svcLock[c];
  });
  // 배정 우선순위: 보내온 경우에만 바꿉니다 (usePriority 팀, 내가 관리하는 팀만)
  if (b.prio && typeof b.prio === 'object') {
    cur.prio = Object.assign({}, cur.prio || {});
    cats.filter(c => L.usesPrio(ctx, c)).forEach(c => {
      const p = String(b.prio[c] || '');
      if (L.PRIORITIES.indexOf(p) >= 0) cur.prio[c] = p; else delete cur.prio[c];
    });
  }
  if (!cur.roles.length && !curRaw) fail('역할을 하나 이상 골라 주세요.');
  cur.name = name;
  cur.updatedAt = nowIso();
  tx.putVol(cur);
};

ADMIN.unlinkKakao = (tx, ctx, admin, b) => {
  const cur = tx.data.vols[String(b.id)];
  if (cur) tx.putVol(Object.assign({}, cur, { kakaoId: '', updatedAt: nowIso() }));
};

// 관리자가 봉사자 대신 그 달의 가능한 예배를 입력합니다.
ADMIN.saveDates = (tx, ctx, admin, b, month) => {
  const cur = tx.data.vols[String(b.id)];
  if (!cur) fail('봉사자를 찾을 수 없어요.');
  const mine = L.cleanSlots(b.dates).filter(x => x.indexOf(month) === 0);
  tx.putVol(Object.assign({}, cur, {
    dates: uniq((cur.dates || []).filter(x => x.indexOf(month) !== 0).concat(mine)).sort(),
    savedMonths: uniq((cur.savedMonths || []).concat([month])).sort().slice(-24),
    updatedAt: nowIso(),
  }));
};

ADMIN.deleteVolunteer = (tx, ctx, admin, b) => {
  if (!admin.all) fail('봉사자 삭제는 전체 관리자만 할 수 있어요. 팀에서 빼려면 역할을 모두 해제하고 저장하세요.', 'forbidden');
  if (tx.data.vols[String(b.id)]) tx.delVol(String(b.id));
};

ADMIN.saveRoles = (tx, ctx, admin, b) => {
  const cat = L.checkCat(ctx, b.cat);
  L.needCat(ctx, admin, cat);
  const clean = (Array.isArray(b.roles) ? b.roles : [])
    .map(r => ({ cat, name: L.plain(r.name).replace(/[,|]/g, ' ').slice(0, 20), count: Math.max(1, Math.min(10, parseInt(r.count, 10) || 1)) }))
    .filter(r => r.name);
  if (!clean.length) fail('역할을 하나 이상 남겨 주세요.');
  if (uniq(clean.map(r => r.name)).length !== clean.length) fail('같은 이름의 역할이 있어요.');
  const others = ctx.roles.filter(r => r.cat !== cat);
  const clash = clean.find(r => others.some(o => o.name === r.name));
  if (clash) fail(`'${clash.name}' 역할은 ${others.find(o => o.name === clash.name).cat}에 이미 있어요. 다른 이름을 써 주세요.`);
  // 팀 순서(config)는 그대로 두고, 이 팀의 역할만 보내온 순서대로 바꿉니다.
  const order = ctx.cats.map(c => c.name);
  const rest = others.filter(r => order.indexOf(r.cat) < 0);
  tx.setRoles([].concat(...order.map(c => (c === cat ? clean : others.filter(r => r.cat === c))), rest));
};

function cellRole(ctx, admin, role, month, date, svc) {
  const r = ctx.roles.find(x => x.name === role);
  if (!r) fail('역할을 찾을 수 없어요.');
  L.needCat(ctx, admin, r.cat);
  const o = L.occOf(ctx, month, date, svc);
  if (!o.roles.some(x => x.name === role)) fail('이 이벤트에는 해당 팀이 포함돼 있지 않아요.');
  return r;
}
const monthDoc = (tx, m) => clone(tx.data.months[m] || { overrides: {}, finals: {} });
const clone = o => JSON.parse(JSON.stringify(o));

// 확정 전 스케줄의 한 칸을 정합니다. ids가 null이면 자동 배정으로 되돌립니다.
ADMIN.saveOverride = (tx, ctx, admin, b, month) => {
  const r = cellRole(ctx, admin, b.role, month, b.date, b.svc);
  const doc = monthDoc(tx, month);
  if ((doc.finals || {})[r.cat]) fail(`${r.cat} 스케줄이 확정돼 있어요. 확정된 칸은 바로 고칠 수 있어요.`);
  const ov = doc.overrides || {};
  const d = String(b.date), s = String(b.svc);
  if (b.ids === null) {
    if (ov[d] && ov[d][s]) {
      delete ov[d][s][b.role];
      if (!Object.keys(ov[d][s]).length) delete ov[d][s];
      if (!Object.keys(ov[d]).length) delete ov[d];
    }
  } else {
    ((ov[d] = ov[d] || {})[s] = ov[d][s] || {})[b.role] = L.cleanIds(b.ids);
  }
  doc.overrides = ov;
  tx.putMonth(month, doc);
};

// 확정된 팀 스케줄의 한 칸을 고칩니다.
ADMIN.editFinalCell = (tx, ctx, admin, b, month) => {
  const r = cellRole(ctx, admin, b.role, month, b.date, b.svc);
  const doc = monthDoc(tx, month);
  const slots = (doc.finals || {})[r.cat];
  if (!slots) fail(`${r.cat} 스케줄은 아직 확정되지 않았어요.`);
  const nameOf = id => (ctx.vols.find(v => v.id === id) || {}).name || '(삭제된 봉사자)';
  const d = String(b.date), s = String(b.svc);
  ((slots[d] = slots[d] || {})[s] = slots[d][s] || {})[b.role] = L.cleanIds(b.ids).map(id => ({ id, name: nameOf(id), manual: true }));
  tx.putMonth(month, doc);
  return { sync: [[month, r.cat]] };
};

// 한 팀의 스케줄을 지금 결과대로 확정합니다.
ADMIN.setFinal = (tx, ctx, admin, b, month) => {
  const cat = L.checkCat(ctx, b.cat);
  L.needCat(ctx, admin, cat);
  const all = L.buildSchedule(ctx, month, 2);
  const names = ctx.roles.filter(r => r.cat === cat).map(r => r.name);
  const mine = {};
  L.eachCell(all, (d, s, role, ps) => {
    if (names.indexOf(role) < 0) return;
    ((mine[d] = mine[d] || {})[s] = mine[d][s] || {})[role] = ps;
  });
  const doc = monthDoc(tx, month);
  doc.finals = Object.assign({}, doc.finals, { [cat]: mine });
  tx.putMonth(month, doc);
  return { sync: [[month, cat]] };
};

// 확정된 스케줄을 구글 캘린더에 다시 올립니다 (캘린더를 나중에 연결했거나, 캘린더에서 일정을 지웠을 때)
ADMIN.syncCalendar = (tx, ctx, admin, b, month) => {
  const cats = L.editableCats(ctx, admin).filter(c => ctx.confirmed[month + '|' + c] || tx.data.calendar[month + '|' + c]);
  if (!cats.length) fail('이 달에는 확정된 스케줄이 없어요. 먼저 팀 스케줄을 확정해 주세요.');
  return { sync: cats.map(c => [month, c]) };
};

ADMIN.unsetFinal = (tx, ctx, admin, b, month) => {
  const cat = L.checkCat(ctx, b.cat);
  L.needCat(ctx, admin, cat);
  const doc = monthDoc(tx, month);
  if (doc.finals) delete doc.finals[cat];
  tx.putMonth(month, doc);
  return { sync: [[month, cat]] };
};

// 비정기 이벤트. 팀 담당자는 자기 팀만 포함된 이벤트를 만들고 고칠 수 있습니다.
ADMIN.saveEvent = (tx, ctx, admin, b, month) => {
  const cats = L.editableCats(ctx, admin);
  const ev = b.event || {};
  const name = L.plain(ev.name).slice(0, 30);
  if (!name) fail('이벤트 이름을 입력해 주세요.');
  const date = String(ev.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date + 'T00:00:00').getTime())) fail('날짜를 골라 주세요.');
  const teams = uniq((Array.isArray(ev.teams) ? ev.teams : []).map(String)).filter(t => L.catNames(ctx).indexOf(t) >= 0);
  if (!teams.length) fail('필요한 팀을 하나 이상 골라 주세요.');
  teams.forEach(t => L.needCat(ctx, admin, t));
  const cur = ev.id ? ctx.events.find(e => e.id === String(ev.id)) : null;
  if (ev.id && !cur) fail('이벤트를 찾을 수 없어요. 새로고침해 주세요.');
  if (cur && !cur.teams.every(t => cats.indexOf(t) >= 0)) fail('다른 팀이 포함된 이벤트는 전체 관리자만 고칠 수 있어요.', 'forbidden');

  const okTime = t => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ''));
  const rows = (Array.isArray(ev.slots) ? ev.slots : []).slice(0, 6);
  if (!rows.length) fail('시간대를 하나 이상 넣어 주세요.');
  const known = cur ? cur.slots.map(s => s.k) : [];
  let next = known.reduce((m, k) => Math.max(m, Number(k.slice(1)) || 0), 0);
  const slots = rows.map((s, i) => {
    if (!okTime(s.start)) fail(`${i + 1}번째 시간대의 시작 시간을 확인해 주세요.`);
    if (s.end && (!okTime(s.end) || s.end <= s.start)) fail(`${i + 1}번째 시간대의 끝 시간이 시작보다 늦어야 해요.`);
    const k = known.indexOf(String(s.k)) >= 0 ? String(s.k) : 's' + (++next);
    return { k, label: L.plain(s.label).slice(0, 12) || (rows.length > 1 ? (i + 1) + '부' : '예배'), start: s.start, end: s.end || '' };
  });
  if (uniq(slots.map(s => s.k)).length !== slots.length) fail('시간대 정보가 겹쳐요. 새로고침 후 다시 저장해 주세요.');

  // 주일 예배 대체: 주일 날짜에만, 전체 관리자만 바꿀 수 있어요. (팀 담당자가 고치면 기존 값 유지)
  let replaces = !!(cur && cur.replaces);
  if (admin.all) replaces = !!ev.replaces;
  else if (!!ev.replaces !== replaces) fail('주일 예배 대체는 전체 관리자만 설정할 수 있어요.', 'forbidden');
  if (replaces && new Date(date + 'T00:00:00').getDay() !== 0) fail('주일 예배 대체는 주일(일요일) 날짜에만 할 수 있어요.');

  const id = cur ? cur.id : newId(6).toLowerCase();
  const doc = { id, name, date, teams, slots, updatedAt: nowIso() };
  if (replaces) doc.replaces = true;
  tx.putEvent(doc);
  // 날짜를 바꿨다면 봉사자들이 체크해 둔 가능 여부도 새 날짜로 옮깁니다.
  if (cur && cur.date !== date) {
    const tag = '|e' + id + '_';
    Object.values(tx.data.vols).forEach(v => {
      if (!(v.dates || []).some(x => x.indexOf(tag) > 0)) return;
      tx.putVol(Object.assign({}, v, { dates: uniq(v.dates.map(x => (x.indexOf(tag) > 0 ? date + x.slice(10) : x))).sort() }));
    });
  }
  const months = uniq([month, date.slice(0, 7)].concat(cur ? [cur.date.slice(0, 7)] : []));
  // 주일 대체가 걸려 있으면 그 주일 예배(모든 팀)도 바뀌므로 모든 팀 캘린더를 맞춥니다.
  const touchedTeams = replaces || (cur && cur.replaces) ? L.catNames(ctx) : uniq(teams.concat(cur ? cur.teams : []));
  const replChanged = replaces !== !!(cur && cur.replaces) || (replaces && cur && cur.date !== date);
  return { sync: [].concat(...months.map(m => touchedTeams.map(t => [m, t]))), warn: replChanged ? months.map(m => finalWarn(ctx, m)).filter(Boolean)[0] || '' : '' };
};

ADMIN.deleteEvent = (tx, ctx, admin, b) => {
  const cats = L.editableCats(ctx, admin);
  const cur = ctx.events.find(e => e.id === String(b.id));
  if (!cur) return null;
  if (!cur.teams.every(t => cats.indexOf(t) >= 0)) fail('다른 팀이 포함된 이벤트는 전체 관리자만 지울 수 있어요.', 'forbidden');
  if (cur.replaces && !admin.all) fail('주일 예배를 대체한 일정은 전체 관리자만 지울 수 있어요.', 'forbidden');
  tx.delEvent(cur.id);
  const tag = '|e' + cur.id + '_';
  Object.values(tx.data.vols).forEach(v => {
    if (!(v.dates || []).some(x => x.indexOf(tag) > 0)) return;
    tx.putVol(Object.assign({}, v, { dates: v.dates.filter(x => x.indexOf(tag) < 0) }));
  });
  return { sync: (cur.replaces ? L.catNames(ctx) : cur.teams).map(t => [cur.date.slice(0, 7), t]) };
};

// 주일 예배 변경 (전체 관리자): mode = '' (1·2부) | 'only1' | 'only2'
ADMIN.setSunMode = (tx, ctx, admin, b, month) => {
  if (!admin.all) fail('주일 예배 변경은 전체 관리자만 할 수 있어요.', 'forbidden');
  const date = String(b.date || '');
  if (L.sundays(month).indexOf(date) < 0) fail('이 달의 주일 날짜가 아니에요. 새로고침해 주세요.');
  const mode = String(b.mode || '');
  if (['', 'only1', 'only2'].indexOf(mode) < 0) fail('알 수 없는 변경이에요.');
  const doc = monthDoc(tx, month);
  const sm = Object.assign({}, doc.sunMode || {});
  if (mode) sm[date] = mode; else delete sm[date];
  doc.sunMode = sm;
  tx.putMonth(month, doc);
  return { sync: L.catNames(ctx).map(c => [month, c]), warn: finalWarn(ctx, month) };
};
// 이미 확정된 팀은 확정 당시 배정이 그대로 남으므로 다시 확정하도록 안내합니다.
function finalWarn(ctx, month) {
  const fin = L.catNames(ctx).filter(c => ctx.confirmed[month + '|' + c]);
  return fin.length ? `확정된 ${fin.join('·')} 스케줄은 확정 당시 배정이 그대로예요. 바뀐 예배 구성으로 다시 배정하려면 확정을 해제한 뒤 다시 확정해 주세요.` : '';
}

// 관리자 지정 (전체 관리자만). admin: { all: bool, cats: [] } 또는 null
ADMIN.setAdmin = (tx, ctx, admin, b) => {
  if (!admin.all) fail('관리자 지정은 전체 관리자만 할 수 있어요.', 'forbidden');
  const u = tx.data.users[String(b.kakaoId)];
  if (!u) fail('해당 계정을 찾을 수 없어요.');
  const a = b.admin || null;
  const next = a && a.all ? { all: true, cats: [] }
    : a && Array.isArray(a.cats) && a.cats.length ? { all: false, cats: uniq(a.cats.map(String)).filter(c => L.catNames(ctx).indexOf(c) >= 0) } : null;
  const wasSuper = !!(u.admin && u.admin.all);
  if (wasSuper && !(next && next.all)) {
    const supers = Object.values(tx.data.users).filter(x => x.admin && x.admin.all);
    if (supers.length <= 1) fail('전체 관리자가 한 명은 있어야 해요. 다른 사람을 먼저 전체 관리자로 지정해 주세요.');
  }
  tx.putUser(Object.assign({}, u, { admin: next && (next.all || next.cats.length) ? next : null }));
};

async function adminAction(deps, auth, action, body) {
  needLogin(auth);
  const fn = Object.prototype.hasOwnProperty.call(ADMIN, action) ? ADMIN[action] : null;
  if (!fn) fail('알 수 없는 요청이에요.', 'not_found');
  if (action === 'syncCalendar' && !deps.calendar) fail('구글 캘린더가 아직 연결되지 않았어요. CALENDAR_ID를 넣고 다시 배포해 주세요.');
  const month = L.checkMonth(body.month);
  const res = await deps.store.transact(tx => {
    const admin = adminOf(tx.data.users[auth.kakaoId]);
    if (!admin) fail('관리자만 할 수 있어요.', 'forbidden');
    const ctx = ctxOf(tx.data, deps.config);
    return fn(tx, ctx, admin, body, month) || {};
  });
  const notes = res.warn ? [res.warn] : [];
  for (const [m, c] of uniq((res.sync || []).map(x => x.join('|'))).map(x => x.split('|'))) {
    const n = await syncCalendarSafe(deps, m, c);
    if (n) notes.push(n);
  }
  if (action === 'setFinal' || action === 'unsetFinal') {
    const data = await deps.store.read();
    const vol = Object.values(data.vols).find(x => x.kakaoId === auth.kakaoId);
    const who = (vol && vol.name) || ((data.users[auth.kakaoId] || {}).nickname) || '관리자';
    const cat = String(body.cat || '');
    await notifySafe(deps, action === 'setFinal'
      ? { title: '스케줄 확정', body: `${who}님이 ${+month.slice(5)}월 ${cat} 스케줄을 확정했어요.`, url: `/?tab=schedule&month=${month}`, tag: `final-${month}-${cat}` }
      : { title: '스케줄 확정 해제', body: `${who}님이 ${+month.slice(5)}월 ${cat} 스케줄 확정을 해제했어요.`, url: `/?tab=schedule&month=${month}`, tag: `final-${month}-${cat}` },
    { except: auth.kakaoId });
  }
  const v = await view(deps, auth, { month });
  if (notes.length) v.notice = notes.join(' ');
  return v;
}

/* ---------- 관리자 푸시 알림 (전체 관리자만 받음) ---------- */
// msg = { title, body, url, tag }, opt = { except: 보내지 않을 카카오 회원번호, to: [받을 회원번호], throttleKey, throttleMs }
async function notify(deps, msg, opt) {
  opt = opt || {};
  if (!deps.push) return 0;
  if (opt.throttleKey) {
    const recent = deps.push.recent || (deps.push.recent = new Map());
    const t = recent.get(opt.throttleKey);
    if (t && Date.now() - t < (opt.throttleMs || 10 * 60 * 1000)) return 0;
    recent.set(opt.throttleKey, Date.now());
  }
  const data = await deps.store.read();
  const to = new Set(opt.to || Object.values(data.users).filter(u => u.admin && u.admin.all && u.kakaoId !== opt.except).map(u => u.kakaoId));
  const subs = Object.values(data.push).filter(s => to.has(s.kakaoId));
  if (!subs.length) return 0;
  const payload = JSON.stringify({ title: msg.title, body: msg.body, url: msg.url || '/', tag: msg.tag || '' });
  const gone = [];
  let sent = 0;
  await Promise.all(subs.map(async s => {
    try { await P.withTimeout(deps.push.send({ endpoint: s.endpoint, keys: s.keys }, payload), 8000); sent++; }
    catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) gone.push(s.id); // 알림을 끈 기기
      else console.error('푸시 알림 실패', (e && (e.statusCode || e.message)) || e);
    }
  }));
  if (gone.length) await deps.store.transact(tx => { gone.forEach(id => { if (tx.data.push[id]) tx.delPush(id); }); });
  return sent;
}
async function notifySafe(deps, msg, opt) {
  try { return await notify(deps, msg, opt); } catch (e) { console.error('푸시 알림 오류', e); return 0; }
}

function needSuper(data, auth) {
  needLogin(auth);
  const u = data.users[auth.kakaoId];
  if (!u || !u.admin || !u.admin.all) fail('알림은 전체 관리자만 받을 수 있어요.', 'forbidden');
}

async function pushSubscribe(deps, auth, body) {
  needLogin(auth);
  if (!deps.push) fail('푸시 알림이 아직 설정되지 않았어요. README의 알림 설정을 확인해 주세요.');
  const s = body.subscription || {};
  const keys = s.keys || {};
  if (!P.validEndpoint(s.endpoint) || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string' ||
      keys.p256dh.length > 200 || keys.auth.length > 100) fail('알림 등록 정보가 올바르지 않아요. 다시 시도해 주세요.');
  const id = P.subId(s.endpoint);
  await deps.store.transact(tx => {
    needSuper(tx.data, auth);
    // 한 사람당 기기 10대까지 (오래된 것부터 정리)
    const mine = Object.values(tx.data.push).filter(x => x.kakaoId === auth.kakaoId && x.id !== id)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    mine.slice(0, Math.max(0, mine.length - 9)).forEach(x => tx.delPush(x.id));
    tx.putPush({ id, kakaoId: auth.kakaoId, endpoint: s.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth },
      ua: L.plain(String(body.ua || '')).slice(0, 160), createdAt: nowIso() });
  });
  return view(deps, auth, { month: body.month });
}

async function pushUnsubscribe(deps, auth, body) {
  needLogin(auth);
  const id = typeof body.endpoint === 'string' ? P.subId(body.endpoint) : '';
  await deps.store.transact(tx => {
    const s = tx.data.push[id];
    if (s && s.kakaoId === auth.kakaoId) tx.delPush(id);
  });
  return view(deps, auth, { month: body.month });
}

async function pushTest(deps, auth, body) {
  const data = await deps.store.read();
  needSuper(data, auth);
  if (!deps.push) fail('푸시 알림이 아직 설정되지 않았어요.');
  if (!Object.values(data.push).some(s => s.kakaoId === auth.kakaoId)) fail('이 계정으로 알림을 켠 기기가 없어요. 먼저 알림 받기를 눌러 주세요.');
  const sent = await notify(deps, { title: '시험 알림', body: '알림이 잘 도착했어요. 봉사 일정 소식을 이렇게 알려 드릴게요.', url: '/?tab=settings', tag: 'test' }, { to: [auth.kakaoId] });
  if (!sent) fail('알림을 보내지 못했어요. 알림을 껐다가 다시 켜 주세요.');
  const v = await view(deps, auth, { month: body.month });
  v.sent = sent;
  return v;
}

// 매달 정해진 날: 다음 달 일정을 아직 저장하지 않은 봉사자를 알립니다.
async function remindMissing(deps, now) {
  const d = new Date((now || new Date()).getTime() + 9 * 3600 * 1000); // 서울 시간
  const month = L.shiftMonth(d.toISOString().slice(0, 7), 1);
  const data = await deps.store.read();
  const missing = Object.values(data.vols)
    .filter(v => (v.roles || []).length && !(v.dates || []).some(x => x.indexOf(month) === 0) && (v.savedMonths || []).indexOf(month) < 0)
    .map(v => v.name).sort((a, b) => a.localeCompare(b, 'ko'));
  if (!missing.length) return { month, missing, sent: 0 };
  const list = missing.length > 12 ? missing.slice(0, 12).join(', ') + ` 외 ${missing.length - 12}명` : missing.join(', ');
  const sent = await notifySafe(deps, { title: `${+month.slice(5)}월 일정 미입력 ${missing.length}명`, body: list, url: `/?tab=settings&month=${month}`, tag: 'remind-' + month });
  return { month, missing, sent };
}

/* ---------- 구글 캘린더 ---------- */
// 확정된 팀 스케줄을 예배·팀마다 일정 하나로 올립니다. 확정이 풀리면 그 팀 일정은 지웁니다.
async function syncCalendar(deps, month, cat) {
  if (!deps.calendar) return;
  const data = await deps.store.read();
  const ctx = ctxOf(data, deps.config);
  const key = month + '|' + cat;
  const slots = ctx.confirmed[key] || null;
  const stored = ((data.calendar[key] || {}).map) || {};
  if (!slots && !Object.keys(stored).length) return;

  const desired = {};
  if (slots) {
    L.occasions(ctx, month).forEach(o => {
      const roles = o.roles.filter(r => r.cat === cat);
      if (!roles.length) return;
      const lines = roles.map(r => ({ role: r.name, names: ((((slots[o.d] || {})[o.s]) || {})[r.name] || []).map(p => p.name) }));
      if (!lines.some(l => l.names.length)) return;
      desired[o.d + '|' + o.s] = { o, lines };
    });
  }
  const map = {};
  for (const k of Object.keys(desired)) {
    const { o, lines } = desired[k];
    const people = uniq([].concat(...lines.map(l => l.names)));
    const what = [o.evName, o.label].filter(Boolean).join(' ');
    const ev = Object.assign({
      summary: `${what} ${cat}: ${people.join('·')}`,
      description: `${what} ${cat} 봉사\n\n` + lines.map(l => `${l.role}: ${l.names.join(', ') || '(미정)'}`).join('\n') +
        `\n\n${deps.config.APP_NAME}에서 자동으로 만든 일정입니다. 변경은 웹앱에서 해 주세요.`,
    }, eventTimes(o.d, o.start, o.end));
    map[k] = await deps.calendar.upsert(stored[k] || null, ev);
  }
  for (const k of Object.keys(stored)) {
    if (!desired[k]) { try { await deps.calendar.remove(stored[k]); } catch (e) { /* 이미 지워진 일정 */ } }
  }
  await deps.store.transact(tx => { tx.putCal(key, Object.keys(map).length ? { map } : null); });
}
async function syncCalendarSafe(deps, month, cat) {
  try { await syncCalendar(deps, month, cat); return ''; }
  catch (e) { return `스케줄은 저장됐지만 구글 캘린더에 반영하지 못했어요: ${e.message}`; }
}

module.exports = { ctxOf, migrate, view, recordLogin, linkMine, saveMine, setup, adminAction, syncCalendar, notify, pushSubscribe, pushUnsubscribe, pushTest, remindMissing, ADMIN };
