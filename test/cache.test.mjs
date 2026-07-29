import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import { bytesToBase64Url, canonicalJson } from '../js/crypto.js';
import {
  cacheEncryptedSet,
  isBundleCached,
  removeCachedBundle,
} from '../js/data.js';

const encoder = new TextEncoder();
const baseUrl = 'https://example.test/gelato-library/';
const controlCacheName = 'gelato-library-encrypted-control-v1';
const pointerUrl = `${baseUrl}__gelato-cache__/encrypted-active`;

if (!globalThis.crypto) globalThis.crypto = webcrypto;

function fakeBundle(bundleId, saltSeed) {
  const salt = Uint8Array.from({ length: 16 }, (_, index) => saltSeed + index);
  const iv = Uint8Array.from({ length: 12 }, (_, index) => saltSeed + 32 + index);
  const header = {
    bundleId,
    iterations: 600_000,
    iv: bytesToBase64Url(iv),
    kdf: 'PBKDF2-SHA256',
    salt: bytesToBase64Url(salt),
    schemaVersion: 2,
  };
  const headerBytes = encoder.encode(canonicalJson(header));
  const bytes = new Uint8Array(12 + headerBytes.length + 17);
  bytes.set(encoder.encode('GELATOE2'), 0);
  new DataView(bytes.buffer).setUint32(8, headerBytes.length, false);
  bytes.set(headerBytes, 12);
  bytes.fill(saltSeed, 12 + headerBytes.length);
  return { bytes, salt: header.salt };
}

function requestUrl(value) {
  if (typeof value === 'string') return value;
  return value.url;
}

class MemoryCache {
  entries = new Map();

  async match(request) {
    return this.entries.get(requestUrl(request))?.clone();
  }

  async put(request, response) {
    this.entries.set(requestUrl(request), response.clone());
  }

  async delete(request) {
    return this.entries.delete(requestUrl(request));
  }

  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
}

class MemoryCacheStorage {
  stores = new Map();

  async open(name) {
    if (!this.stores.has(name)) this.stores.set(name, new MemoryCache());
    return this.stores.get(name);
  }

  async delete(name) {
    return this.stores.delete(name);
  }

  async keys() {
    return [...this.stores.keys()];
  }
}

async function readActivePointer(memoryCaches) {
  const control = await memoryCaches.open(controlCacheName);
  return JSON.parse(await (await control.match(pointerUrl)).text());
}

test('staging 검증 후 cache를 교체하고 실패하면 기존 active를 보존한다', async () => {
  const originals = {
    caches: globalThis.caches,
    document: globalThis.document,
    fetch: globalThis.fetch,
  };
  const memoryCaches = new MemoryCacheStorage();
  const catalogA = fakeBundle('catalog', 1);
  const chapterA = fakeBundle('goff:chapter:01', 1);
  const chapterA2 = fakeBundle('goff:chapter:02', 1);
  const searchA = fakeBundle('goff:search', 1);
  const catalogB = fakeBundle('catalog', 51);
  const chapterB = fakeBundle('goff:chapter:02', 51);
  const searchB = fakeBundle('goff:search', 51);
  const catalogC = fakeBundle('catalog', 101);
  const wrongSaltChapter = fakeBundle('goff:chapter:03', 51);
  const responses = new Map([
    [`${baseUrl}data/books/goff/chapters/01.enc`, chapterA.bytes],
    [`${baseUrl}data/books/goff/chapters/02.enc`, chapterA2.bytes],
    [`${baseUrl}data/books/goff/chapters/03.enc`, wrongSaltChapter.bytes],
    [`${baseUrl}data/search/goff.enc`, searchA.bytes],
  ]);
  const fetchOrder = [];
  let activeFetches = 0;
  let maxActiveFetches = 0;

  globalThis.document = { baseURI: baseUrl };
  globalThis.caches = memoryCaches;
  globalThis.fetch = async (request) => {
    const url = requestUrl(request);
    fetchOrder.push(url);
    activeFetches += 1;
    maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
    await new Promise((resolve) => setTimeout(resolve, 2));
    activeFetches -= 1;
    const bytes = responses.get(url);
    return bytes
      ? new Response(bytes, {
          status: 200,
          headers: { 'Content-Length': String(bytes.byteLength) },
        })
      : new Response('', { status: 404 });
  };

  try {
    await cacheEncryptedSet(catalogA.bytes, catalogA.salt, [
      {
        path: 'books/goff/chapters/01.enc',
        bundleId: 'goff:chapter:01',
      },
      { path: 'search/goff.enc', bundleId: 'goff:search' },
    ]);
    assert.equal(
      await isBundleCached('books/goff/chapters/01.enc', catalogA.salt),
      true,
    );

    await cacheEncryptedSet(catalogA.bytes, catalogA.salt, [{
      path: 'books/goff/chapters/02.enc',
      bundleId: 'goff:chapter:02',
    }]);
    assert.equal(
      await isBundleCached('books/goff/chapters/01.enc', catalogA.salt),
      true,
      '같은 build에 자료를 추가할 때 기존 active 항목이 사라졌습니다.',
    );
    assert.equal(await isBundleCached('search/goff.enc', catalogA.salt), true);

    responses.set(`${baseUrl}data/books/goff/chapters/02.enc`, chapterB.bytes);
    responses.set(`${baseUrl}data/search/goff.enc`, searchB.bytes);
    await cacheEncryptedSet(catalogB.bytes, catalogB.salt, [
      {
        path: 'books/goff/chapters/02.enc',
        bundleId: 'goff:chapter:02',
      },
      { path: 'search/goff.enc', bundleId: 'goff:search' },
    ]);

    assert.equal(
      await isBundleCached('books/goff/chapters/01.enc', catalogB.salt),
      false,
      '이전 build의 target이 남아 있습니다.',
    );
    assert.equal(
      await isBundleCached('books/goff/chapters/02.enc', catalogB.salt),
      true,
    );
    assert.equal(
      await isBundleCached('books/goff/chapters/02.enc', catalogA.salt),
      false,
      '현재 cached catalog와 다른 salt로 저장됨 표시를 하면 안 됩니다.',
    );
    assert.deepEqual(fetchOrder.slice(-2), [
      `${baseUrl}data/books/goff/chapters/02.enc`,
      `${baseUrl}data/search/goff.enc`,
    ]);
    assert.equal(maxActiveFetches, 1, '오프라인 번들 fetch가 순차 실행되지 않았습니다.');

    const control = await memoryCaches.open(controlCacheName);
    const activeBeforeFailure = await (await control.match(pointerUrl)).text();
    await assert.rejects(
      cacheEncryptedSet(catalogC.bytes, catalogC.salt, [{
        path: 'books/goff/chapters/03.enc',
        bundleId: 'goff:chapter:03',
      }]),
      (error) => error.code === 'CONTENT_UPDATED',
    );
    const activeAfterFailure = await (await control.match(pointerUrl)).text();
    assert.equal(
      activeAfterFailure,
      activeBeforeFailure,
      '검증 실패 후 active cache pointer가 바뀌었습니다.',
    );
    assert.equal(
      await isBundleCached('books/goff/chapters/02.enc', catalogB.salt),
      true,
      '검증 실패가 기존 active cache를 손상했습니다.',
    );
    let setCaches = (await memoryCaches.keys())
      .filter((name) => name.startsWith('gelato-library-encrypted-v1-set-'));
    assert.equal(setCaches.length, 2, '실패한 staging cache가 정리되지 않았습니다.');

    await cacheEncryptedSet(catalogB.bytes, catalogB.salt, [{
      path: 'search/goff.enc',
      bundleId: 'goff:search',
    }]);
    assert.equal(
      await isBundleCached('search/goff.enc', catalogB.salt),
      true,
      '실패한 write 뒤 queue가 다음 write를 실행하지 못했습니다.',
    );
    setCaches = (await memoryCaches.keys())
      .filter((name) => name.startsWith('gelato-library-encrypted-v1-set-'));
    assert.equal(setCaches.length, 2, '완료된 cache 두 세대보다 많이 남았습니다.');
  } finally {
    if (originals.caches === undefined) delete globalThis.caches;
    else globalThis.caches = originals.caches;
    if (originals.document === undefined) delete globalThis.document;
    else globalThis.document = originals.document;
    globalThis.fetch = originals.fetch;
  }
});

test('Promise.all 동시 저장은 Web Lock 안에서 union을 보존하고 pointer가 완전한 cache를 가리킨다', async () => {
  const originals = {
    caches: globalThis.caches,
    document: globalThis.document,
    fetch: globalThis.fetch,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  };
  const memoryCaches = new MemoryCacheStorage();
  const catalog = fakeBundle('catalog', 121);
  const chapter1 = fakeBundle('goff:chapter:01', 121);
  const chapter2 = fakeBundle('goff:chapter:02', 121);
  const chapter3 = fakeBundle('goff:chapter:03', 121);
  const responses = new Map([
    [`${baseUrl}data/books/goff/chapters/01.enc`, chapter1.bytes],
    [`${baseUrl}data/books/goff/chapters/02.enc`, chapter2.bytes],
    [`${baseUrl}data/books/goff/chapters/03.enc`, chapter3.bytes],
  ]);
  let lockTail = Promise.resolve();
  let lockCalls = 0;
  const lockManager = {
    request(name, options, callback) {
      assert.equal(name, 'gelato-library-encrypted-cache-write-v1');
      assert.equal(options.mode, 'exclusive');
      lockCalls += 1;
      const result = lockTail.then(() => callback({ name }));
      lockTail = result.catch(() => undefined);
      return result;
    },
  };

  globalThis.document = { baseURI: baseUrl };
  globalThis.caches = memoryCaches;
  globalThis.fetch = async (request) => {
    await new Promise((resolve) => setTimeout(resolve, 3));
    const bytes = responses.get(requestUrl(request));
    return bytes
      ? new Response(bytes, {
          status: 200,
          headers: { 'Content-Length': String(bytes.byteLength) },
        })
      : new Response('', { status: 404 });
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { locks: lockManager },
  });

  try {
    await Promise.all([
      cacheEncryptedSet(catalog.bytes, catalog.salt, [{
        path: 'books/goff/chapters/01.enc',
        bundleId: 'goff:chapter:01',
      }]),
      cacheEncryptedSet(catalog.bytes, catalog.salt, [{
        path: 'books/goff/chapters/02.enc',
        bundleId: 'goff:chapter:02',
      }]),
    ]);

    const pointer = await readActivePointer(memoryCaches);
    assert.equal(pointer.version, 1);
    assert.ok(memoryCaches.stores.has(pointer.current), 'active pointer 대상 cache가 없습니다.');
    const active = await memoryCaches.open(pointer.current);
    for (const path of [
      'catalog.enc',
      'books/goff/chapters/01.enc',
      'books/goff/chapters/02.enc',
    ]) {
      assert.ok(
        await active.match(`${baseUrl}data/${path}`),
        `동시 저장 후 active cache에 ${path}가 없습니다.`,
      );
    }
    assert.equal(await isBundleCached('books/goff/chapters/01.enc', catalog.salt), true);
    assert.equal(await isBundleCached('books/goff/chapters/02.enc', catalog.salt), true);

    await Promise.all([
      cacheEncryptedSet(catalog.bytes, catalog.salt, [{
        path: 'books/goff/chapters/03.enc',
        bundleId: 'goff:chapter:03',
      }]),
      removeCachedBundle('books/goff/chapters/01.enc'),
    ]);
    assert.equal(await isBundleCached('books/goff/chapters/01.enc', catalog.salt), false);
    assert.equal(await isBundleCached('books/goff/chapters/02.enc', catalog.salt), true);
    assert.equal(await isBundleCached('books/goff/chapters/03.enc', catalog.salt), true);
    assert.equal(lockCalls, 4, 'save/delete writer가 모두 Web Lock을 사용하지 않았습니다.');
  } finally {
    if (originals.caches === undefined) delete globalThis.caches;
    else globalThis.caches = originals.caches;
    if (originals.document === undefined) delete globalThis.document;
    else globalThis.document = originals.document;
    globalThis.fetch = originals.fetch;
    if (originals.navigator) {
      Object.defineProperty(globalThis, 'navigator', originals.navigator);
    } else {
      delete globalThis.navigator;
    }
  }
});
