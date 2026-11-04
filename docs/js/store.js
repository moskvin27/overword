// Хранилище в браузере: IndexedDB для файлов книг и состояния (словарь, прогресс).

const DB_NAME = 'overword';
const DB_VER = 1;
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const kvGet = (key) => tx('kv', 'readonly', (s) => s.get(key));
export const kvSet = (key, val) => tx('kv', 'readwrite', (s) => s.put(val, key));
export const fileGet = (id) => tx('files', 'readonly', (s) => s.get(id));
export const fileSet = (id, val) => tx('files', 'readwrite', (s) => s.put(val, id));
export const fileDel = (id) => tx('files', 'readwrite', (s) => s.delete(id));
export const fileKeys = () => tx('files', 'readonly', (s) => s.getAllKeys());

// ---------- состояние, которое синхронизируется между компами ----------
// words: { lemma: { ru, color, pins: { bookId: ["стр:индекс", ...] }, u, del? } }
// books: { bookId: { title, page, pages, u } }

export function emptyState() {
  return { v: 1, words: {}, books: {}, nextColor: 0 };
}

export function normalizeState(s) {
  const st = Object.assign(emptyState(), s || {});
  st.words = st.words || {};
  st.books = st.books || {};
  if (typeof st.nextColor !== 'number') st.nextColor = Object.keys(st.words).length;
  return st;
}

// Слияние двух копий: по каждому слову и книге побеждает более свежая правка.
export function mergeStates(a, b) {
  a = normalizeState(a);
  b = normalizeState(b);
  const out = emptyState();
  const pick = (x, y) => (!x ? y : !y ? x : (y.u || 0) > (x.u || 0) ? y : x);
  for (const k of new Set([...Object.keys(a.words), ...Object.keys(b.words)])) {
    out.words[k] = pick(a.words[k], b.words[k]);
  }
  for (const k of new Set([...Object.keys(a.books), ...Object.keys(b.books)])) {
    out.books[k] = pick(a.books[k], b.books[k]);
  }
  out.nextColor = Math.max(a.nextColor || 0, b.nextColor || 0);
  return out;
}

export async function hashFile(file) {
  // Отпечаток книги: размер + SHA-256 первых 4 МБ. Одинаков на всех компах для одного файла.
  const head = await file.slice(0, 4 * 1024 * 1024).arrayBuffer();
  const sizeBytes = new TextEncoder().encode(String(file.size));
  const buf = new Uint8Array(head.byteLength + sizeBytes.length);
  buf.set(new Uint8Array(head), 0);
  buf.set(sizeBytes, head.byteLength);
  const dig = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(dig)).slice(0, 10).map((x) => x.toString(16).padStart(2, '0')).join('');
}
