import { isAesDecryptKey } from './crypto.js';

const DATABASE_NAME = 'gelato-library-unlock-v1';
const STORE_NAME = 'sessions';
const STORAGE_KEY = 'gelato.library.unlock-session.v1';
export const UNLOCK_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

function defaultSessionStorage() {
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
}

function randomSessionId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(24);
  globalThis.crypto?.getRandomValues?.(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener(
      'error',
      () => reject(request.error || new Error('IndexedDB request failed')),
      { once: true },
    );
  });
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', resolve, { once: true });
    transaction.addEventListener(
      'abort',
      () => reject(transaction.error || new Error('IndexedDB transaction aborted')),
      { once: true },
    );
    transaction.addEventListener(
      'error',
      () => reject(transaction.error || new Error('IndexedDB transaction failed')),
      { once: true },
    );
  });
}

function createIndexedDbKeyStore(indexedDb = globalThis.indexedDB) {
  if (!indexedDb?.open) return null;

  const openDatabase = () => new Promise((resolve, reject) => {
    const request = indexedDb.open(DATABASE_NAME, 1);
    let blocked = false;
    request.addEventListener('upgradeneeded', () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    });
    request.addEventListener('success', () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    }, { once: true });
    request.addEventListener(
      'error',
      () => reject(request.error || new Error('IndexedDB open failed')),
      { once: true },
    );
    request.addEventListener('blocked', () => {
      blocked = true;
      reject(new Error('IndexedDB open blocked'));
    }, { once: true });
  });

  const run = async (mode, operation) => {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(STORE_NAME, mode);
      const result = operation(transaction.objectStore(STORE_NAME));
      await Promise.all([requestResult(result), transactionComplete(transaction)]);
      return result.result;
    } finally {
      database.close();
    }
  };

  return {
    get(id) {
      return run('readonly', (store) => store.get(id));
    },
    set(record) {
      return run('readwrite', (store) => store.put(record));
    },
    delete(id) {
      return run('readwrite', (store) => store.delete(id));
    },
  };
}

function readStoredDescriptor(storage) {
  try {
    const value = JSON.parse(storage?.getItem(STORAGE_KEY) || 'null');
    if (!value
        || typeof value.id !== 'string'
        || !/^[a-zA-Z0-9-]{16,80}$/u.test(value.id)
        || !Number.isFinite(value.createdAt)) {
      return null;
    }
    return { id: value.id, createdAt: value.createdAt };
  } catch {
    return null;
  }
}

function readDescriptor(storage, now, maxAgeMs) {
  const value = readStoredDescriptor(storage);
  if (!value
      || value.createdAt > now + 60_000
      || now - value.createdAt > maxAgeMs) {
    return null;
  }
  return value;
}

export function createUnlockSessionManager({
  storage = defaultSessionStorage(),
  keyStore = createIndexedDbKeyStore(),
  now = () => Date.now(),
  newId = randomSessionId,
  maxAgeMs = UNLOCK_SESSION_MAX_AGE_MS,
} = {}) {
  const removeMarker = () => {
    try {
      storage?.removeItem(STORAGE_KEY);
    } catch {
      // A blocked storage API simply disables refresh persistence.
    }
  };

  const clear = async () => {
    const descriptor = readStoredDescriptor(storage);
    removeMarker();
    if (!descriptor || !keyStore) return;
    try {
      await keyStore.delete(descriptor.id);
    } catch {
      // The session marker is already gone, so the orphaned key cannot restore this tab.
    }
  };

  return {
    async save(key) {
      if (!storage || !keyStore || !isAesDecryptKey(key)) return false;
      const createdAt = now();
      const descriptor = { id: newId(), createdAt };
      try {
        await keyStore.set({ ...descriptor, key });
        storage.setItem(STORAGE_KEY, JSON.stringify(descriptor));
        return true;
      } catch {
        removeMarker();
        try {
          await keyStore.delete(descriptor.id);
        } catch {
          // Best-effort cleanup only.
        }
        return false;
      }
    },

    async restore() {
      const descriptor = readDescriptor(storage, now(), maxAgeMs);
      if (!descriptor || !keyStore) {
        await clear();
        return null;
      }
      try {
        const record = await keyStore.get(descriptor.id);
        if (record?.createdAt !== descriptor.createdAt || !isAesDecryptKey(record?.key)) {
          await clear();
          return null;
        }
        return record.key;
      } catch {
        return null;
      }
    },

    clear,
  };
}
