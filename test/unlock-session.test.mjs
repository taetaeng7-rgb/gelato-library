import assert from 'node:assert/strict';
import test from 'node:test';
import {
  UNLOCK_SESSION_MAX_AGE_MS,
  createUnlockSessionManager,
} from '../js/unlock-session.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    get size() {
      return values.size;
    },
  };
}

function memoryKeyStore() {
  const values = new Map();
  return {
    get: async (id) => values.get(id) ?? null,
    set: async (record) => values.set(record.id, record),
    delete: async (id) => values.delete(id),
    get size() {
      return values.size;
    },
  };
}

const sessionKey = {
  type: 'secret',
  extractable: false,
  algorithm: { name: 'AES-GCM', length: 256 },
  usages: ['decrypt'],
};

test('비밀번호 대신 비추출 복호화 키를 새로고침 세션에서 복원한다', async () => {
  const storage = memoryStorage();
  const keyStore = memoryKeyStore();
  const options = {
    storage,
    keyStore,
    now: () => 1_000,
    newId: () => 'session-1234567890',
  };
  const manager = createUnlockSessionManager(options);
  assert.equal(await manager.save(sessionKey), true);
  assert.equal(storage.size, 1);
  assert.equal(keyStore.size, 1);

  const restored = await createUnlockSessionManager(options).restore();
  assert.equal(restored, sessionKey);

  await manager.clear();
  assert.equal(storage.size, 0);
  assert.equal(keyStore.size, 0);
});

test('만료된 잠금 세션은 복원하지 않는다', async () => {
  const storage = memoryStorage();
  const keyStore = memoryKeyStore();
  let currentTime = 1_000;
  const manager = createUnlockSessionManager({
    storage,
    keyStore,
    now: () => currentTime,
    newId: () => 'session-1234567890',
  });
  await manager.save(sessionKey);
  currentTime += UNLOCK_SESSION_MAX_AGE_MS + 1;
  assert.equal(await manager.restore(), null);
  assert.equal(storage.size, 0);
  assert.equal(keyStore.size, 0);
});

test('추출 가능한 키나 복호화 용도가 아닌 키는 저장하지 않는다', async () => {
  const storage = memoryStorage();
  const keyStore = memoryKeyStore();
  const manager = createUnlockSessionManager({ storage, keyStore });
  assert.equal(await manager.save({ ...sessionKey, extractable: true }), false);
  assert.equal(await manager.save({ ...sessionKey, usages: ['encrypt'] }), false);
  assert.equal(storage.size, 0);
  assert.equal(keyStore.size, 0);
});
