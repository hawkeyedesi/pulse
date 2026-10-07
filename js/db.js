// Minimal promise wrapper around IndexedDB. Local-first store for everything.
//
// stores:
//   sessions  keyPath id            (index: startedAt, status)
//   samples   keyPath [sessionId,seq]
//   notes     keyPath sessionId
//   chats     keyPath key           (coach conversations)
//   outbox    autoIncrement         (pending remote deletes)
//   coachlog  keyPath sessionId     (v2: workout-log delivery to the coach session)

const DB_NAME = 'pulse';
const DB_VERSION = 2;
let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) {
        const s = db.createObjectStore('sessions', { keyPath: 'id' });
        s.createIndex('startedAt', 'startedAt');
        s.createIndex('status', 'status');
      }
      if (!db.objectStoreNames.contains('samples')) db.createObjectStore('samples', { keyPath: ['sessionId', 'seq'] });
      if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'sessionId' });
      if (!db.objectStoreNames.contains('chats')) db.createObjectStore('chats', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('coachlog')) db.createObjectStore('coachlog', { keyPath: 'sessionId' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => console.warn('IndexedDB upgrade blocked by another tab');
  });
  return dbPromise;
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

async function store(name, mode = 'readonly') {
  const db = await openDb();
  return db.transaction(name, mode).objectStore(name);
}

export async function get(name, key) { return reqP((await store(name)).get(key)); }
export async function put(name, value) { return reqP((await store(name, 'readwrite')).put(value)); }
export async function del(name, key) { return reqP((await store(name, 'readwrite')).delete(key)); }
export async function getAll(name) { return reqP((await store(name)).getAll()); }

export async function putMany(name, values) {
  if (!values.length) return;
  const db = await openDb();
  const tx = db.transaction(name, 'readwrite');
  const st = tx.objectStore(name);
  for (const v of values) st.put(v);
  return txDone(tx);
}

// ---------------------------------------------------------------- sessions
export async function listSessions() {
  const all = await getAll('sessions');
  return all.filter((s) => !s.deleted).sort((a, b) => b.startedAt - a.startedAt);
}
export async function activeSessions() {
  return (await getAll('sessions')).filter((s) => s.status === 'active' && !s.deleted);
}

export async function getSamples(sessionId) {
  const st = await store('samples');
  const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
  return reqP(st.getAll(range));
}

export async function deleteSessionLocal(sessionId) {
  const db = await openDb();
  const tx = db.transaction(['sessions', 'samples', 'notes', 'chats', 'coachlog'], 'readwrite');
  tx.objectStore('sessions').delete(sessionId);
  tx.objectStore('samples').delete(IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]));
  tx.objectStore('notes').delete(sessionId);
  tx.objectStore('chats').delete(`session:${sessionId}`);
  tx.objectStore('coachlog').delete(sessionId);
  return txDone(tx);
}

export async function notesMap() {
  const all = await getAll('notes');
  return new Map(all.map((n) => [n.sessionId, n]));
}

export async function clearAll() {
  const db = await openDb();
  const names = ['sessions', 'samples', 'notes', 'chats', 'outbox', 'coachlog'];
  const tx = db.transaction(names, 'readwrite');
  names.forEach((n) => tx.objectStore(n).clear());
  return txDone(tx);
}
