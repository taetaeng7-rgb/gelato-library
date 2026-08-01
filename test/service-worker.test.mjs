import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const swSource = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const cryptoSource = await readFile(new URL('../js/crypto.js', import.meta.url), 'utf8');
const scope = 'https://example.test/gelato-library/';
const activeCacheName = 'gelato-library-encrypted-v1-set-abcdefghijklmnop';
const previousCacheName = 'gelato-library-encrypted-v1-set-ponmlkjihgfedcba';

async function runEncryptedNetworkFirst({
  networkStatus,
  networkBody = '',
  cachedBody = null,
  previousCachedBody = null,
  plainPointer = false,
}) {
  const controlCache = {
    async match() {
      return new Response(plainPointer
        ? activeCacheName
        : JSON.stringify({
            version: 1,
            current: activeCacheName,
            previous: previousCacheName,
          }));
    },
  };
  const activeCache = {
    async match() {
      return cachedBody == null ? undefined : new Response(cachedBody, { status: 200 });
    },
  };
  const previousCache = {
    async match() {
      return previousCachedBody == null
        ? undefined
        : new Response(previousCachedBody, { status: 200 });
    },
  };
  const emptyCache = { async match() { return undefined; } };
  const context = vm.createContext({
    URL,
    Request,
    Response,
    caches: {
      async open(name) {
        if (name === 'gelato-library-encrypted-control-v1') return controlCache;
        if (name === activeCacheName) return activeCache;
        if (name === previousCacheName) return previousCache;
        return emptyCache;
      },
      async keys() {
        return [];
      },
      async delete() {
        return true;
      },
    },
    fetch: async () => {
      if (networkStatus === 'reject') throw new TypeError('offline');
      return new Response(networkBody, { status: networkStatus });
    },
    self: {
      addEventListener() {},
      clients: { claim: async () => {} },
      location: { origin: 'https://example.test' },
      registration: { scope },
      skipWaiting: async () => {},
    },
  });
  vm.runInContext(swSource, context);
  context.testRequest = new Request(`${scope}data/catalog.enc`);
  return vm.runInContext('encryptedNetworkFirst(testRequest)', context);
}

test('암호문 network-first는 HTTP 오류와 연결 실패에서 active cache로 복구한다', async () => {
  const serverError = await runEncryptedNetworkFirst({
    networkStatus: 503,
    networkBody: 'server error',
    cachedBody: 'cached bundle',
  });
  assert.equal(serverError.status, 200);
  assert.equal(await serverError.text(), 'cached bundle');

  const notFound = await runEncryptedNetworkFirst({
    networkStatus: 404,
    networkBody: 'not found',
  });
  assert.equal(notFound.status, 404);
  assert.equal(await notFound.text(), 'not found');

  const deletedFromCurrent = await runEncryptedNetworkFirst({
    networkStatus: 404,
    networkBody: 'deleted',
    previousCachedBody: 'stale previous bundle',
  });
  assert.equal(
    await deletedFromCurrent.text(),
    'deleted',
    'current에서 삭제한 번들을 previous cache에서 되살리면 안 됩니다.',
  );

  const offline = await runEncryptedNetworkFirst({
    networkStatus: 'reject',
    cachedBody: 'offline bundle',
  });
  assert.equal(offline.status, 200);
  assert.equal(await offline.text(), 'offline bundle');

  const success = await runEncryptedNetworkFirst({
    networkStatus: 200,
    networkBody: 'fresh bundle',
    cachedBody: 'old bundle',
  });
  assert.equal(await success.text(), 'fresh bundle');

  const legacyPointer = await runEncryptedNetworkFirst({
    networkStatus: 500,
    cachedBody: 'plain pointer cache',
    plainPointer: true,
  });
  assert.equal(await legacyPointer.text(), 'plain pointer cache');
});

test('새 service worker가 제어권을 얻으면 한 번만 reload한다', () => {
  assert.match(
    appSource,
    /let reloadingForServiceWorker = false;[\s\S]*?controllerchange[\s\S]*?if \(reloadingForServiceWorker\) return;[\s\S]*?reloadingForServiceWorker = true;[\s\S]*?window\.location\.reload\(\)/u,
  );
});

test('읽기 이동과 잠금 세션 모듈을 최신 앱 셸에 포함한다', () => {
  assert.match(swSource, /gelato-library-app-v12/u);
  assert.match(swSource, /\.\/js\/reader-navigation\.js/u);
  assert.match(swSource, /\.\/js\/unlock-session\.js/u);
});

test('잠금 해제 화면과 코드가 최소 6자를 함께 강제한다', () => {
  assert.match(cryptoSource, /MIN_PASSWORD_CHARACTERS = 6/u);
  assert.match(appSource, /import \{ MIN_PASSWORD_CHARACTERS \} from '\.\/crypto\.js';/u);
  assert.match(appSource, /minlength="\$\{MIN_PASSWORD_CHARACTERS\}"/u);
  assert.match(
    appSource,
    /Array\.from\(password\)\.length < MIN_PASSWORD_CHARACTERS/u,
  );
});
