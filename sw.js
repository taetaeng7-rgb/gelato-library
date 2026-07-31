const APP_CACHE_PREFIX = 'gelato-library-app-';
const APP_CACHE = 'gelato-library-app-v8';
const LEGACY_ENCRYPTED_CACHE = 'gelato-library-encrypted-v1';
const ENCRYPTED_CONTROL_CACHE = 'gelato-library-encrypted-control-v1';
const ENCRYPTED_POINTER_PATH = './__gelato-cache__/encrypted-active';
const ENCRYPTED_CACHE_NAME_PATTERN = /^gelato-library-encrypted-v1-set-[a-zA-Z0-9_-]{16,80}$/u;
const APP_SHELL = [
  './',
  './index.html',
  './css/style.css',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './manifest.webmanifest',
  './js/app.js',
  './js/crypto.js',
  './js/data.js',
  './js/reader-navigation.js',
  './js/reader-progress.js',
  './js/router.js',
  './js/sanitize.js',
  './js/store.js',
  './js/unlock-session.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(APP_CACHE_PREFIX) && key !== APP_CACHE)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

function isInScope(url) {
  return url.origin === self.location.origin && url.href.startsWith(self.registration.scope);
}

function isEncryptedBundle(url) {
  return url.pathname.endsWith('.enc');
}

function safeEncryptedCacheName(value) {
  return typeof value === 'string'
    && (value === LEGACY_ENCRYPTED_CACHE || ENCRYPTED_CACHE_NAME_PATTERN.test(value));
}

async function activeEncryptedCacheName() {
  const control = await caches.open(ENCRYPTED_CONTROL_CACHE);
  const pointerUrl = new URL(ENCRYPTED_POINTER_PATH, self.registration.scope).href;
  const pointer = await control.match(pointerUrl);
  if (!pointer) return LEGACY_ENCRYPTED_CACHE;
  try {
    const text = (await pointer.text()).trim();
    try {
      const parsed = JSON.parse(text);
      if (parsed?.version === 1 && safeEncryptedCacheName(parsed.current)) {
        return parsed.current;
      }
    } catch {
      // A pre-transaction pointer stored only the active cache name.
    }
    if (ENCRYPTED_CACHE_NAME_PATTERN.test(text)) return text;
  } catch {
    // Fall through to the legacy cache.
  }
  return LEGACY_ENCRYPTED_CACHE;
}

async function cachedEncryptedResponse(request) {
  try {
    const encryptedCache = await caches.open(await activeEncryptedCacheName());
    return await encryptedCache.match(request);
  } catch {
    return null;
  }
}

async function encryptedNetworkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) return response;
    return (await cachedEncryptedResponse(request)) || response;
  } catch {
    return (await cachedEncryptedResponse(request)) || Response.error();
  }
}

async function navigationNetworkFirst(request) {
  const appCache = await caches.open(APP_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      await appCache.put('./index.html', response.clone());
    }
    return response;
  } catch {
    return (await appCache.match('./index.html')) || Response.error();
  }
}

async function appShellStaleWhileRevalidate(request) {
  const appCache = await caches.open(APP_CACHE);
  const cached = await appCache.match(request);
  const network = fetch(request)
    .then(async (response) => {
      if (response.ok && response.type === 'basic') await appCache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  return cached || (await network) || Response.error();
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (!isInScope(url)) return;

  if (isEncryptedBundle(url)) {
    // Never cache encrypted content implicitly. The page caches only chapters the user selects.
    event.respondWith(encryptedNetworkFirst(event.request));
    return;
  }
  if (event.request.mode === 'navigate') {
    event.respondWith(navigationNetworkFirst(event.request));
    return;
  }
  event.respondWith(appShellStaleWhileRevalidate(event.request));
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
