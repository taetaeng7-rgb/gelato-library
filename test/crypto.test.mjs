import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import {
  GelatoVault,
  bytesToBase64Url,
  canonicalJson,
  parseBundle,
} from '../js/crypto.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const encoder = new TextEncoder();

async function createBundle({ bundleId = 'catalog', password = 'correct horse battery staple', payload } = {}) {
  const salt = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
  const iv = Uint8Array.from({ length: 12 }, (_, index) => 100 + index);
  const header = {
    bundleId,
    iterations: 600_000,
    iv: bytesToBase64Url(iv),
    kdf: 'PBKDF2-SHA256',
    salt: bytesToBase64Url(salt),
    schemaVersion: 2,
  };
  const headerBytes = encoder.encode(canonicalJson(header));
  const passwordMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256' },
    passwordMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: headerBytes, tagLength: 128 },
    key,
    encoder.encode(JSON.stringify(payload || {
      schemaVersion: 2,
      contentVersion: 'test',
      books: [],
      searchBundles: {},
    })),
  ));
  const bytes = new Uint8Array(12 + headerBytes.length + ciphertext.length);
  bytes.set(encoder.encode('GELATOE2'), 0);
  new DataView(bytes.buffer).setUint32(8, headerBytes.length, false);
  bytes.set(headerBytes, 12);
  bytes.set(ciphertext, 12 + headerBytes.length);
  return bytes;
}

test('GELATOE2 canonical header를 파싱하고 AAD로 복호화한다', async () => {
  const payload = { schemaVersion: 2, value: '젤라토' };
  const bundle = await createBundle({ payload });
  const parsed = parseBundle(bundle);
  assert.equal(parsed.header.bundleId, 'catalog');
  assert.equal(parsed.header.iterations, 600_000);
  assert.equal(parsed.salt.byteLength, 16);
  assert.equal(parsed.iv.byteLength, 12);

  const vault = new GelatoVault();
  assert.deepEqual(await vault.unlockCatalog(bundle, 'correct horse battery staple'), payload);
  assert.equal(vault.unlocked, true);
  assert.equal(vault.sessionKey.extractable, false);

  const restoredVault = new GelatoVault();
  assert.deepEqual(await restoredVault.restoreCatalog(bundle, vault.sessionKey), payload);
  assert.equal(restoredVault.unlocked, true);

  vault.lock();
  assert.equal(vault.unlocked, false);
  assert.equal(vault.sessionKey, null);
});

test('6자 비밀번호를 허용하고 5자는 거부한다', async () => {
  const payload = { schemaVersion: 2, value: '최소 길이 검증' };
  const bundle = await createBundle({ password: '123456', payload });
  const acceptedVault = new GelatoVault();
  assert.deepEqual(await acceptedVault.unlockCatalog(bundle, '123456'), payload);

  const rejectedVault = new GelatoVault();
  await assert.rejects(
    rejectedVault.unlockCatalog(bundle, '12345'),
    (error) => error.code === 'PASSWORD_TOO_SHORT',
  );
});

test('틀린 비밀번호와 변조된 AAD/암호문을 거부한다', async () => {
  const bundle = await createBundle({ payload: { schemaVersion: 2 } });
  const vault = new GelatoVault();
  await assert.rejects(
    vault.unlockCatalog(bundle, 'wrong password'),
    (error) => error.code === 'DECRYPT_FAILED',
  );

  const tampered = bundle.slice();
  tampered[tampered.length - 1] ^= 1;
  await assert.rejects(
    vault.unlockCatalog(tampered, 'correct horse battery staple'),
    (error) => error.code === 'DECRYPT_FAILED',
  );
});

test('비정규 JSON 헤더를 암호화 전에 거부한다', async () => {
  const valid = await createBundle();
  const parsed = parseBundle(valid);
  const nonCanonicalText = JSON.stringify({
    schemaVersion: parsed.header.schemaVersion,
    salt: parsed.header.salt,
    kdf: parsed.header.kdf,
    iv: parsed.header.iv,
    iterations: parsed.header.iterations,
    bundleId: parsed.header.bundleId,
  });
  const headerBytes = encoder.encode(nonCanonicalText);
  const bytes = new Uint8Array(12 + headerBytes.length + parsed.ciphertext.length);
  bytes.set(encoder.encode('GELATOE2'));
  new DataView(bytes.buffer).setUint32(8, headerBytes.length, false);
  bytes.set(headerBytes, 12);
  bytes.set(parsed.ciphertext, 12 + headerBytes.length);
  assert.throws(() => parseBundle(bytes), (error) => error.code === 'NON_CANONICAL_HEADER');
});
