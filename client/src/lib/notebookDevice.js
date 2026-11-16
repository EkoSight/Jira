/**
 * Today's page on this device (Part N6), in IndexedDB, kept apart for each
 * signed-in person: one database per person, named from their account.
 * Holds a copy of today's page and the changes still to be sent. Signing out
 * deletes every notebook database on the device.
 *
 * A tiny wrapper; no library. Every call fails soft: without IndexedDB (a
 * private window, blocked storage) the notebook simply works online only.
 */
const PREFIX = 'taskflow-notebook-';
const KNOWN = 'taskflow.notebook.dbs';

const remember = (name) => {
  try {
    const list = new Set(JSON.parse(localStorage.getItem(KNOWN) || '[]'));
    list.add(name);
    localStorage.setItem(KNOWN, JSON.stringify([...list]));
  } catch { /* a convenience only */ }
};

function open(name) {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('No IndexedDB')); return; }
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('kv'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', mode);
    const result = fn(tx.objectStore('kv'));
    tx.oncomplete = () => resolve(result?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** The device store for one person. */
export function deviceStore(userId) {
  const name = `${PREFIX}u${userId}`;
  let dbp = null;
  const db = () => { if (!dbp) { dbp = open(name); remember(name); } return dbp; };
  return {
    async get(key) {
      try { return await run(await db(), 'readonly', (s) => s.get(key)); } catch { return undefined; }
    },
    async set(key, value) {
      try { await run(await db(), 'readwrite', (s) => s.put(value, key)); return true; } catch { return false; }
    },
    async del(key) {
      try { await run(await db(), 'readwrite', (s) => s.delete(key)); } catch { /* nothing to remove */ }
    },
  };
}

/** Sign-out: every notebook database on this device goes, whoever it belonged to. */
export async function clearNotebookDevice() {
  const names = new Set();
  try { for (const n of JSON.parse(localStorage.getItem(KNOWN) || '[]')) names.add(n); } catch { /* none known */ }
  try {
    if (typeof indexedDB !== 'undefined' && indexedDB.databases) {
      for (const d of await indexedDB.databases()) if (d.name?.startsWith(PREFIX)) names.add(d.name);
    }
  } catch { /* older browsers list nothing */ }
  await Promise.all([...names].map((n) => new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(n);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch { resolve(); }
  })));
  try { localStorage.removeItem(KNOWN); } catch { /* fine */ }
}
