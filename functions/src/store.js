/**
 * 저장 계층
 *
 * 전체 데이터를 메모리에 올려 두고(state), 바뀐 문서만 Firestore에 씁니다.
 * meta/state 문서의 v(버전)가 같으면 다시 읽지 않아서 읽기 횟수를 크게 줄입니다.
 *
 * Firestore 구조
 *   config/main          { roles: [{ cat, name, count }] }
 *   volunteers/{id}      { name, roles, dates, lockedCats, svcLock, kakaoId, updatedAt }
 *   events/{id}          { name, date, teams, slots, updatedAt }
 *   months/{YYYY-MM}     { overrides, finals: { 팀: slots } }
 *   users/{카카오회원번호} { nickname, admin: { all, cats }, lastLogin }
 *   calendar/{YYYY-MM|팀} { map: { '날짜|시간대': 캘린더일정ID } }
 *   push/{id}            { kakaoId, endpoint, keys, ua, createdAt }  푸시 알림을 받을 기기
 *   notices/{id}         { title, body, target: 'all' | 팀, pinned, until, authorId, authorName, createdAt, updatedAt }
 *   meta/state           { v }
 */
'use strict';

const COLS = { volunteers: 'vols', events: 'events', months: 'months', users: 'users', calendar: 'calendar', push: 'push', notices: 'notices' };

const emptyData = () => ({ roles: [], vols: {}, events: {}, months: {}, users: {}, calendar: {}, push: {}, notices: {} });
const clone = o => JSON.parse(JSON.stringify(o));

// 한 번의 변경 작업. data를 고치면서 바뀐 문서 경로를 기록합니다.
function makeTx(data) {
  const d = clone(data);
  const dirty = {};
  const put = (col, id, val) => { d[COLS[col]][id] = val; dirty[col + '/' + id] = val; };
  const del = (col, id) => { delete d[COLS[col]][id]; dirty[col + '/' + id] = null; };
  return {
    data: d,
    dirty,
    putVol: v => put('volunteers', v.id, v),
    delVol: id => del('volunteers', id),
    putEvent: e => put('events', e.id, e),
    delEvent: id => del('events', id),
    putMonth: (m, val) => (val ? put('months', m, val) : del('months', m)),
    putUser: u => put('users', u.kakaoId, u),
    putCal: (key, val) => (val ? put('calendar', key, val) : del('calendar', key)),
    putPush: s => put('push', s.id, s),
    delPush: id => del('push', id),
    putNotice: n => put('notices', n.id, n),
    delNotice: id => del('notices', id),
    setRoles: roles => { d.roles = roles; dirty['config/main'] = { roles }; },
  };
}

// 저장할 때는 id 같은 중복 필드를 빼고, 읽을 때 다시 채웁니다.
function toDoc(path, val) {
  if (val === null) return null;
  const v = Object.assign({}, val);
  if (path.startsWith('volunteers/') || path.startsWith('events/') || path.startsWith('push/') || path.startsWith('notices/')) delete v.id;
  if (path.startsWith('users/')) delete v.kakaoId;
  return v;
}
function fromDocs(docs) {
  const data = emptyData();
  Object.keys(docs).forEach(path => {
    const [col, id] = path.split('/');
    const val = docs[path];
    if (col === 'config' && id === 'main') data.roles = Array.isArray(val.roles) ? val.roles : [];
    else if (col === 'volunteers') data.vols[id] = Object.assign({ id }, val);
    else if (col === 'events') data.events[id] = Object.assign({ id }, val);
    else if (col === 'months') data.months[id] = val;
    else if (col === 'users') data.users[id] = Object.assign({ kakaoId: id }, val);
    else if (col === 'calendar') data.calendar[id] = val;
    else if (col === 'push') data.push[id] = Object.assign({ id }, val);
    else if (col === 'notices') data.notices[id] = Object.assign({ id }, val);
  });
  return data;
}

class Store {
  constructor(adapter) { this.adapter = adapter; this.cache = null; }

  async read() {
    const v = await this.adapter.getVersion();
    if (this.cache && this.cache.v === v) return this.cache.data;
    const data = fromDocs(await this.adapter.loadAll());
    this.cache = { v, data };
    return data;
  }

  // fn(tx)는 tx.data를 보고 고친 뒤 결과를 돌려줍니다. 동시에 고치는 사람이 있으면 자동으로 다시 시도합니다.
  async transact(fn) {
    let out, pending = null;
    await this.adapter.transaction(async io => {
      pending = null;
      const v = await io.getVersion();
      const data = this.cache && this.cache.v === v ? this.cache.data : fromDocs(await io.loadAll());
      const tx = makeTx(data);
      out = await fn(tx);
      const paths = Object.keys(tx.dirty);
      if (!paths.length) { this.cache = { v, data }; return; }
      const writes = {};
      paths.forEach(p => { writes[p] = toDoc(p, tx.dirty[p]); });
      io.write(writes, v + 1);
      pending = { v: v + 1, data: tx.data };
    });
    if (pending) this.cache = pending;
    return out;
  }
}

/* ---------- 메모리 저장소 (시험·로컬 미리보기용) ---------- */
class MemoryAdapter {
  constructor() { this.docs = {}; this.v = 0; this.queue = Promise.resolve(); this.reads = 0; }
  async getVersion() { return this.v; }
  async loadAll() { this.reads += Object.keys(this.docs).length; return clone(this.docs); }
  transaction(fn) {
    const run = this.queue.then(async () => {
      const io = {
        getVersion: async () => this.v,
        loadAll: async () => this.loadAll(),
        write: (writes, nv) => {
          Object.keys(writes).forEach(p => { if (writes[p] === null) delete this.docs[p]; else this.docs[p] = clone(writes[p]); });
          this.v = nv;
        },
      };
      await fn(io);
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

/* ---------- Firestore 저장소 ---------- */
class FirestoreAdapter {
  constructor(db) { this.db = db; this.metaRef = db.collection('meta').doc('state'); }
  async getVersion() { const s = await this.metaRef.get(); return s.exists ? Number(s.data().v) || 0 : 0; }
  async _load(get) {
    const docs = {};
    const cfg = await get(this.db.collection('config').doc('main'));
    if (cfg.exists) docs['config/main'] = cfg.data();
    for (const col of Object.keys(COLS)) {
      const snap = await get(this.db.collection(col));
      snap.forEach(doc => { docs[col + '/' + doc.id] = doc.data(); });
    }
    return docs;
  }
  async loadAll() { return this._load(ref => ref.get()); }
  async transaction(fn) {
    await this.db.runTransaction(async t => {
      const pending = [];
      const io = {
        getVersion: async () => { const s = await t.get(this.metaRef); return s.exists ? Number(s.data().v) || 0 : 0; },
        loadAll: async () => this._load(ref => t.get(ref)),
        write: (writes, nv) => { pending.push([writes, nv]); },
      };
      await fn(io);
      pending.forEach(([writes, nv]) => {
        Object.keys(writes).forEach(p => {
          const [col, id] = p.split('/');
          const ref = this.db.collection(col).doc(id);
          if (writes[p] === null) t.delete(ref); else t.set(ref, writes[p]);
        });
        t.set(this.metaRef, { v: nv });
      });
    });
  }
}

module.exports = { Store, MemoryAdapter, FirestoreAdapter, makeTx, emptyData };
