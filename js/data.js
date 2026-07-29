import { GelatoVault, bytesToBase64Url, parseBundle } from './crypto.js';

const DATA_ROOT = './data/';
const CATALOG_PATH = 'catalog.enc';
const LEGACY_ENCRYPTED_CACHE = 'gelato-library-encrypted-v1';
const ENCRYPTED_CACHE_PREFIX = 'gelato-library-encrypted-v1-set-';
const ENCRYPTED_CONTROL_CACHE = 'gelato-library-encrypted-control-v1';
const ENCRYPTED_POINTER_PATH = './__gelato-cache__/encrypted-active';
const ENCRYPTED_CACHE_NAME_PATTERN = /^gelato-library-encrypted-v1-set-[a-zA-Z0-9_-]{16,80}$/u;
const ENCRYPTED_WRITE_LOCK = 'gelato-library-encrypted-cache-write-v1';
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,159}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
let encryptedCacheWriteQueue = Promise.resolve();

export class DataError extends Error {
  constructor(code, cause) {
    super(code, cause ? { cause } : undefined);
    this.name = 'DataError';
    this.code = code;
  }
}

const fail = (code, cause) => {
  throw new DataError(code, cause);
};

function safeId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function safeText(value, maxLength = 2_000) {
  return typeof value === 'string' && value.length <= maxLength;
}

function validateStats(stats) {
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)
      || !Number.isInteger(stats.blockCount)
      || stats.blockCount < 1
      || !Number.isInteger(stats.sectionCount)
      || stats.sectionCount < 0
      || !Number.isInteger(stats.searchableCharacterCount)
      || stats.searchableCharacterCount < 1) {
    fail('BAD_CATALOG');
  }
}

function validSupplementPlacement(role, position) {
  return (role === 'frontmatter' && position === 'before')
    || (role === 'index' && position === 'after');
}

export function normalizeBundlePath(path) {
  if (typeof path !== 'string' || path.length < 5 || path.length > 500) fail('BAD_PATH');
  let normalized = path.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (normalized.startsWith('data/')) normalized = normalized.slice(5);
  if (normalized.startsWith('/')
      || normalized.includes('//')
      || normalized.split('/').some((part) => part === '..' || part === '.')
      || !/^[a-zA-Z0-9._/-]+\.enc$/u.test(normalized)) {
    fail('BAD_PATH');
  }
  return normalized;
}

export function bundleUrl(path) {
  return new URL(`${DATA_ROOT}${normalizeBundlePath(path)}`, document.baseURI).href;
}

async function fetchBundle(path) {
  const url = bundleUrl(path);
  let response;
  try {
    response = await fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/octet-stream' },
    });
  } catch (error) {
    fail('NETWORK_ERROR', error);
  }
  if (!response.ok) fail(response.status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR');
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_BUNDLE_BYTES) fail('BUNDLE_TOO_LARGE');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_BUNDLE_BYTES) fail('BUNDLE_TOO_LARGE');
  return bytes;
}

function normalizeHash(value) {
  if (!value) return null;
  if (typeof value !== 'string') fail('BAD_HASH');
  const hash = value.trim();
  if (/^[a-f0-9]{64}$/iu.test(hash)) return { format: 'hex', value: hash.toLowerCase() };
  if (/^sha256:[a-f0-9]{64}$/iu.test(hash)) {
    return { format: 'hex', value: hash.slice(7).toLowerCase() };
  }
  if (/^sha256-[A-Za-z0-9_-]{43}$/u.test(hash)) {
    return { format: 'base64url', value: hash.slice(7) };
  }
  if (/^[A-Za-z0-9_-]{43}$/u.test(hash)) return { format: 'base64url', value: hash };
  fail('BAD_HASH');
}

async function verifyHash(bytes, expected) {
  const normalized = normalizeHash(expected);
  if (!normalized) return;
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  const actual = normalized.format === 'hex'
    ? [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    : bytesToBase64Url(digest);
  if (actual !== normalized.value) fail('HASH_MISMATCH');
}

function validateTargetSummary(summary, bookId, targetKind) {
  if (!summary || typeof summary !== 'object'
      || !safeId(summary.id)
      || !safeText(summary.title, 500)
      || !safeText(summary.description || '', 2_000)
      || typeof summary.bundlePath !== 'string'
      || !DIGEST_PATTERN.test(summary.contentDigest)
      || summary.bundleId !== `${bookId}:${targetKind}:${summary.id}`) {
    fail('BAD_CATALOG');
  }
  if (targetKind === 'chapter'
      && (!Number.isInteger(summary.number) || summary.number < 1)) {
    fail('BAD_CATALOG');
  }
  if (targetKind === 'supplement'
      && !validSupplementPlacement(summary.role, summary.position)) {
    fail('BAD_CATALOG');
  }
  validateStats(summary.stats);
  normalizeBundlePath(summary.bundlePath);
  normalizeHash(summary.hash);
}

function validateBook(book) {
  if (!book || typeof book !== 'object'
      || !safeId(book.id)
      || !safeText(book.title, 500)
      || !safeText(book.subtitle || '', 800)
      || !safeText(book.description || '', 4_000)
      || !safeText(book.language, 40)
      || !['source', 'editorial'].includes(book.chapterType)
      || !Array.isArray(book.chapters)
      || book.chapters.length < 1
      || book.chapters.length > 300
      || book.chapterCount !== book.chapters.length
      || !Array.isArray(book.supplements)
      || book.supplements.length > 50
      || typeof book.searchBundlePath !== 'string'
      || book.searchBundleId !== `${book.id}:search`) {
    fail('BAD_CATALOG');
  }
  normalizeBundlePath(book.searchBundlePath);
  if (!Array.isArray(book.authors) || book.authors.some((author) => !safeText(author, 200))) {
    fail('BAD_CATALOG');
  }
  const ids = new Set();
  for (const chapter of book.chapters) {
    validateTargetSummary(chapter, book.id, 'chapter');
    const key = `chapter:${chapter.id}`;
    if (ids.has(key)) fail('BAD_CATALOG');
    ids.add(key);
  }
  for (const supplement of book.supplements) {
    validateTargetSummary(supplement, book.id, 'supplement');
    const key = `supplement:${supplement.id}`;
    if (ids.has(key)) fail('BAD_CATALOG');
    ids.add(key);
  }
}

export function validateCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object'
      || catalog.schemaVersion !== 2
      || catalog.kind !== 'catalog'
      || catalog.bundleId !== 'catalog'
      || !catalog.library
      || typeof catalog.library !== 'object'
      || !safeId(catalog.library.id)
      || !safeText(catalog.library.title, 500)
      || !safeText(catalog.library.language, 40)
      || !Array.isArray(catalog.books)
      || catalog.books.length !== 2) {
    fail('BAD_CATALOG');
  }
  const bookIds = new Set();
  for (const book of catalog.books) {
    validateBook(book);
    if (bookIds.has(book.id)) fail('BAD_CATALOG');
    bookIds.add(book.id);
  }
  const searchBundles = catalog.searchBundles || {};
  if (!searchBundles || typeof searchBundles !== 'object' || Array.isArray(searchBundles)) {
    fail('BAD_CATALOG');
  }
  for (const [bookId, path] of Object.entries(searchBundles)) {
    if (!bookIds.has(bookId)) fail('BAD_CATALOG');
    normalizeBundlePath(path);
  }
  return catalog;
}

function validateSource(source, errorCode) {
  const pagesAreSafe = (pages) => pages == null
    || (Array.isArray(pages)
      && pages.length <= 10_000
      && pages.every((page) => Number.isInteger(page) || safeText(page, 100)));
  if (!source || typeof source !== 'object' || Array.isArray(source)
      || !['source-chapter', 'editorial-page-range', 'source-supplement'].includes(source.type)
      || !Array.isArray(source.files)
      || source.files.length < 1
      || source.files.length > 1_000
      || source.files.some((file) => !safeText(file, 1_000))
      || !pagesAreSafe(source.pdfPages)
      || !pagesAreSafe(source.printPages)
      || (source.segmentCount != null
        && (!Number.isInteger(source.segmentCount) || source.segmentCount < 1))) {
    fail(errorCode);
  }
}

function validateContentStats(stats, blocks, sections, errorCode) {
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)
      || stats.blockCount !== blocks.length
      || stats.sectionCount !== sections.length
      || !Number.isInteger(stats.searchableCharacterCount)
      || stats.searchableCharacterCount < 1) {
    fail(errorCode);
  }
}

function validateBlock(block, errorCode) {
  if (!block || typeof block !== 'object' || !safeId(block.id)) fail(errorCode);
  if (![
    'heading', 'paragraph', 'list', 'table', 'quote', 'code', 'math', 'footnote',
    'figureDescription', 'sourceAnchor', 'thematicBreak',
  ].includes(block.type)) {
    fail(errorCode);
  }
  if (block.text != null && !safeText(block.text, 500_000)) fail(errorCode);
  if (['heading', 'paragraph', 'quote', 'code', 'math', 'footnote', 'figureDescription'].includes(block.type)
      && !safeText(block.text, 500_000)) {
    fail(errorCode);
  }
  if (block.type === 'heading'
      && (!Number.isInteger(block.level)
        || block.level < 1
        || block.level > 6
        || !safeId(block.anchor))) {
    fail(errorCode);
  }
  if (block.type === 'code'
      && block.language != null
      && !safeText(block.language, 200)) {
    fail(errorCode);
  }
  if (block.type === 'footnote' && !safeText(block.label, 200)) {
    fail(errorCode);
  }
  if (block.type === 'list'
      && (!Array.isArray(block.items)
        || block.items.length < 1
        || block.items.length > 10_000
        || typeof block.ordered !== 'boolean'
        || (block.start != null && !Number.isInteger(block.start))
        || block.items.some((item) => !item
          || !Number.isInteger(item.depth)
          || item.depth < 0
          || item.depth > 12
          || !safeText(item.text, 50_000)))) {
    fail(errorCode);
  }
  if (block.type === 'table'
      && (!Array.isArray(block.head)
        || !Array.isArray(block.align)
        || !Array.isArray(block.rows)
        || ![block.head, block.align, ...block.rows].every((row) => Array.isArray(row))
        || block.head.length > 200
        || block.rows.length > 10_000
        || block.align.some((align) => !['left', 'center', 'right'].includes(align))
        || [...block.head, ...block.rows.flat()].some((cell) => !safeText(String(cell ?? ''), 50_000)))) {
    fail(errorCode);
  }
  if (block.type === 'sourceAnchor') {
    const pageValueIsSafe = (value) => value == null
      || Number.isInteger(value)
      || safeText(String(value), 100);
    if (!pageValueIsSafe(block.pdfPage)
        || !pageValueIsSafe(block.printPage)
        || (block.pageRole != null && !safeText(block.pageRole, 100))) {
      fail(errorCode);
    }
  }
}

function validateContentPayload(payload, bookId, targetKind, targetId) {
  const idField = targetKind === 'chapter' ? 'chapterId' : 'supplementId';
  if (!payload || typeof payload !== 'object'
      || payload.schemaVersion !== 2
      || payload.kind !== targetKind
      || payload.bookId !== bookId
      || payload[idField] !== targetId
      || payload.bundleId !== `${bookId}:${targetKind}:${targetId}`
      || !safeText(payload.title, 500)
      || !safeText(payload.description || '', 4_000)
      || !DIGEST_PATTERN.test(payload.contentDigest)
      || !Array.isArray(payload.sections)
      || payload.sections.length < 1
      || payload.sections.length > 1_000
      || !Array.isArray(payload.blocks)
      || payload.blocks.length < 1
      || payload.blocks.length > 100_000) {
    fail(targetKind === 'chapter' ? 'BAD_CHAPTER' : 'BAD_SUPPLEMENT');
  }
  if (targetKind === 'chapter'
      && (!Number.isInteger(payload.number) || payload.number < 1)) {
    fail('BAD_CHAPTER');
  }
  if (targetKind === 'supplement'
      && !validSupplementPlacement(payload.role, payload.position)) {
    fail('BAD_SUPPLEMENT');
  }

  const errorCode = targetKind === 'chapter' ? 'BAD_CHAPTER' : 'BAD_SUPPLEMENT';
  validateSource(payload.source, errorCode);
  validateContentStats(payload.stats, payload.blocks, payload.sections, errorCode);
  const blockIds = new Set();
  for (const block of payload.blocks) {
    validateBlock(block, errorCode);
    if (blockIds.has(block.id)) fail(errorCode);
    blockIds.add(block.id);
  }
  const sectionIds = new Set();
  for (const section of payload.sections) {
    if (!section || typeof section !== 'object'
        || !safeId(section.id)
        || !safeText(section.title, 500)
        || !Number.isInteger(section.level)
        || section.level < 1
        || section.level > 3
        || !safeId(section.blockId)
        || !blockIds.has(section.blockId)) {
      fail(errorCode);
    }
    if (sectionIds.has(section.id)) fail(errorCode);
    sectionIds.add(section.id);
  }
  const blockIndex = new Map(payload.blocks.map((block, index) => [block.id, index]));
  const sections = payload.sections.map((section, index) => {
    const start = blockIndex.get(section.blockId);
    const end = index + 1 < payload.sections.length
      ? blockIndex.get(payload.sections[index + 1].blockId)
      : payload.blocks.length;
    if (end <= start) fail(errorCode);
    return { ...section, blocks: payload.blocks.slice(start, end) };
  });
  return {
    ...payload,
    id: targetId,
    targetKind,
    targetId,
    sections,
  };
}

export function validateChapter(chapter, bookId, chapterId) {
  return validateContentPayload(chapter, bookId, 'chapter', chapterId);
}

export function validateSupplement(supplement, bookId, supplementId) {
  return validateContentPayload(supplement, bookId, 'supplement', supplementId);
}

export function validateSearchBundle(bundle, bookId) {
  if (!bundle || typeof bundle !== 'object'
      || bundle.schemaVersion !== 2
      || bundle.kind !== 'search-index'
      || bundle.bookId !== bookId
      || bundle.bundleId !== `${bookId}:search`
      || !Array.isArray(bundle.documents)
      || bundle.documents.length < 1
      || bundle.documentCount !== bundle.documents.length
      || bundle.documents.length > 500_000) {
    fail('BAD_SEARCH');
  }
  const documents = [];
  for (const document of bundle.documents) {
    const targetKind = document?.targetKind || (document?.chapterId ? 'chapter' : null);
    const targetId = document?.targetId || document?.chapterId;
    if (!document || typeof document !== 'object'
        || !safeId(document.id)
        || !['chapter', 'supplement'].includes(targetKind)
        || !safeId(targetId)
        || (document.sectionId != null && !safeId(document.sectionId))
        || !safeId(document.blockId)
        || !safeText(document.text, 20_000)
        || !safeText(document.normalized, 20_000)) {
      fail('BAD_SEARCH');
    }
    documents.push({ ...document, targetKind, targetId });
  }
  return { ...bundle, documents };
}

function findBook(catalog, bookId) {
  return catalog?.books.find((book) => book.id === bookId) || null;
}

export function orderedBookTargets(book) {
  if (!book) return [];
  const supplements = Array.isArray(book.supplements) ? book.supplements : [];
  const before = supplements
    .filter((item) => item.position === 'before')
    .map((item) => ({ ...item, targetKind: 'supplement', targetId: item.id }));
  const chapters = book.chapters
    .map((item) => ({ ...item, targetKind: 'chapter', targetId: item.id }));
  const after = supplements
    .filter((item) => item.position === 'after')
    .map((item) => ({ ...item, targetKind: 'supplement', targetId: item.id }));
  return [...before, ...chapters, ...after];
}

export function findTargetSummary(catalog, bookId, targetKind, targetId) {
  const book = findBook(catalog, bookId);
  if (!book || !['chapter', 'supplement'].includes(targetKind)) return null;
  const items = targetKind === 'chapter' ? book.chapters : book.supplements;
  const summary = items.find((item) => item.id === targetId);
  return summary ? { ...summary, targetKind, targetId } : null;
}

export class BundleRepository {
  #vault = new GelatoVault();
  #catalog = null;
  #catalogBytes = null;
  #catalogSalt = null;
  #contents = new Map();
  #search = new Map();

  get unlocked() {
    return this.#vault.unlocked && Boolean(this.#catalog);
  }

  get catalog() {
    return this.#catalog;
  }

  get catalogSalt() {
    return this.#catalogSalt;
  }

  async unlock(password) {
    const bytes = await fetchBundle(CATALOG_PATH);
    const parsed = parseBundle(bytes);
    const catalog = await this.#vault.unlockCatalog(bytes, password);
    this.#catalog = validateCatalog(catalog);
    this.#catalogBytes = bytes.slice(0);
    this.#catalogSalt = parsed.header.salt;
    return this.#catalog;
  }

  async loadContent(bookId, targetKind, targetId) {
    if (!this.unlocked) fail('LOCKED');
    if (!['chapter', 'supplement'].includes(targetKind)) fail('NOT_FOUND');
    const cacheKey = `${bookId}/${targetKind}/${targetId}`;
    if (this.#contents.has(cacheKey)) return this.#contents.get(cacheKey);
    const summary = findTargetSummary(this.#catalog, bookId, targetKind, targetId);
    if (!summary) fail('NOT_FOUND');
    const bytes = await fetchBundle(summary.bundlePath);
    await verifyHash(bytes, summary.hash);
    const payload = await this.#vault.decrypt(bytes, `${bookId}:${targetKind}:${targetId}`);
    const validPayload = targetKind === 'chapter'
      ? validateChapter(payload, bookId, targetId)
      : validateSupplement(payload, bookId, targetId);
    this.#contents.set(cacheKey, validPayload);
    return validPayload;
  }

  async loadChapter(bookId, chapterId) {
    return this.loadContent(bookId, 'chapter', chapterId);
  }

  async loadSupplement(bookId, supplementId) {
    return this.loadContent(bookId, 'supplement', supplementId);
  }

  async loadSearch(bookId) {
    if (!this.unlocked) fail('LOCKED');
    if (this.#search.has(bookId)) return this.#search.get(bookId);
    const book = findBook(this.#catalog, bookId);
    const path = this.#catalog.searchBundles?.[bookId] || book?.searchBundlePath;
    if (!book || !path) fail('NOT_FOUND');
    const bytes = await fetchBundle(path);
    const bundle = await this.#vault.decrypt(bytes, `${bookId}:search`);
    const validBundle = validateSearchBundle(bundle, bookId);
    this.#search.set(bookId, validBundle);
    return validBundle;
  }

  async cacheOffline(bundles) {
    if (!this.unlocked || !this.#catalogBytes || !this.#catalogSalt) fail('LOCKED');
    await cacheEncryptedSet(this.#catalogBytes, this.#catalogSalt, bundles);
  }

  lock() {
    this.#vault.lock();
    this.#catalog = null;
    this.#catalogBytes = null;
    this.#catalogSalt = null;
    this.#contents.clear();
    this.#search.clear();
  }
}

function encryptedResponse(bytes) {
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.byteLength),
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function cachedBundleSalt(cache, path) {
  const response = await cache.match(bundleUrl(path));
  if (!response) return null;
  try {
    return parseBundle(await response.arrayBuffer()).header.salt;
  } catch {
    return null;
  }
}

function encryptedPointerUrl() {
  return new URL(ENCRYPTED_POINTER_PATH, document.baseURI).href;
}

function safeEncryptedCacheName(value) {
  return typeof value === 'string'
    && (value === LEGACY_ENCRYPTED_CACHE || ENCRYPTED_CACHE_NAME_PATTERN.test(value));
}

async function encryptedCachePointer() {
  const control = await caches.open(ENCRYPTED_CONTROL_CACHE);
  const pointer = await control.match(encryptedPointerUrl());
  if (!pointer) return { current: LEGACY_ENCRYPTED_CACHE, previous: null };
  try {
    const text = (await pointer.text()).trim();
    try {
      const parsed = JSON.parse(text);
      if (parsed?.version === 1 && safeEncryptedCacheName(parsed.current)) {
        return {
          current: parsed.current,
          previous: safeEncryptedCacheName(parsed.previous) ? parsed.previous : null,
        };
      }
    } catch {
      // A pre-transaction pointer stored only the active cache name.
    }
    if (ENCRYPTED_CACHE_NAME_PATTERN.test(text)) {
      return { current: text, previous: null };
    }
  } catch {
    // Fall through to the legacy cache.
  }
  return { current: LEGACY_ENCRYPTED_CACHE, previous: null };
}

async function activeEncryptedCacheName() {
  return (await encryptedCachePointer()).current;
}

async function openActiveEncryptedCache() {
  return caches.open(await activeEncryptedCacheName());
}

function nextEncryptedCacheName() {
  const randomBytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(randomBytes);
  return `${ENCRYPTED_CACHE_PREFIX}${bytesToBase64Url(randomBytes)}`;
}

async function copyCachedResponses(source, destination) {
  for (const request of await source.keys()) {
    const response = await source.match(request);
    if (response) await destination.put(request, response);
  }
}

async function commitEncryptedCache(cacheName, previousName) {
  const control = await caches.open(ENCRYPTED_CONTROL_CACHE);
  const pointer = JSON.stringify({
    version: 1,
    current: cacheName,
    previous: previousName,
  });
  await control.put(encryptedPointerUrl(), new Response(pointer, {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  }));
}

async function cleanupOldEncryptedCache(cacheName) {
  if (!cacheName || !ENCRYPTED_CACHE_NAME_PATTERN.test(cacheName)) return;
  try {
    await caches.delete(cacheName);
  } catch {
    // Cleanup is best-effort after two complete cache generations remain addressable.
  }
}

async function encryptedCacheState(cache) {
  const catalogResponse = await cache.match(bundleUrl(CATALOG_PATH));
  if (catalogResponse) {
    try {
      return {
        hasEntries: true,
        catalogSalt: parseBundle(await catalogResponse.arrayBuffer()).header.salt,
      };
    } catch {
      return { hasEntries: true, catalogSalt: null };
    }
  }
  const keys = await cache.keys();
  return { hasEntries: keys.length > 0, catalogSalt: null };
}

async function cacheEncryptedSetLocked(catalogBytes, catalogSalt, bundles) {
  if (!('caches' in globalThis)) fail('CACHE_UNAVAILABLE');
  if (!Array.isArray(bundles)) fail('BAD_PATH');
  const parsedCatalog = parseBundle(catalogBytes);
  if (parsedCatalog.header.bundleId !== 'catalog' || parsedCatalog.header.salt !== catalogSalt) {
    fail('UNEXPECTED_BUNDLE');
  }

  const pointerBefore = await encryptedCachePointer();
  const previousName = pointerBefore.current;
  const previousCache = await caches.open(previousName);
  const previous = await encryptedCacheState(previousCache);
  const stagingName = nextEncryptedCacheName();
  await caches.delete(stagingName);
  const stagingCache = await caches.open(stagingName);
  let committed = false;

  try {
    if (previous.hasEntries && previous.catalogSalt === catalogSalt) {
      await copyCachedResponses(previousCache, stagingCache);
    }
    await stagingCache.put(bundleUrl(CATALOG_PATH), encryptedResponse(catalogBytes));

    for (const bundle of bundles) {
      const normalized = normalizeBundlePath(bundle.path);
      const bytes = await fetchBundle(normalized);
      await verifyHash(bytes, bundle.hash || null);
      const parsed = parseBundle(bytes);
      if (parsed.header.salt !== catalogSalt) fail('CONTENT_UPDATED');
      if (bundle.bundleId && parsed.header.bundleId !== bundle.bundleId) {
        fail('UNEXPECTED_BUNDLE');
      }
      await stagingCache.put(bundleUrl(normalized), encryptedResponse(bytes));
    }

    await commitEncryptedCache(stagingName, previousName);
    committed = true;
  } finally {
    if (!committed) {
      try {
        await caches.delete(stagingName);
      } catch {
        // The active pointer still references the previous complete cache.
      }
    }
  }

  await cleanupOldEncryptedCache(pointerBefore.previous);
}

function enqueueEncryptedCacheWrite(operation) {
  const write = async () => {
    const lockManager = globalThis.navigator?.locks;
    if (lockManager?.request) {
      return lockManager.request(
        ENCRYPTED_WRITE_LOCK,
        { mode: 'exclusive' },
        operation,
      );
    }
    // Older browsers without Web Locks still serialize writes in this page.
    // The versioned pointer prevents dangling caches, but separate old-browser
    // tabs can remain last-writer-wins until they move to a Web Locks build.
    return operation();
  };
  const result = encryptedCacheWriteQueue.then(write, write);
  encryptedCacheWriteQueue = result.catch(() => undefined);
  return result;
}

export function cacheEncryptedSet(catalogBytes, catalogSalt, bundles) {
  return enqueueEncryptedCacheWrite(
    () => cacheEncryptedSetLocked(catalogBytes, catalogSalt, bundles),
  );
}

export function removeCachedBundle(path) {
  if (!('caches' in globalThis)) return Promise.resolve(false);
  return enqueueEncryptedCacheWrite(async () => {
    const cache = await openActiveEncryptedCache();
    return cache.delete(bundleUrl(path));
  });
}

export async function isBundleCached(path, expectedSalt = null) {
  if (!('caches' in globalThis)) return false;
  const cache = await openActiveEncryptedCache();
  if (expectedSalt) {
    const catalogSalt = await cachedBundleSalt(cache, CATALOG_PATH);
    if (catalogSalt !== expectedSalt) return false;
  }
  const response = await cache.match(bundleUrl(path));
  if (!response) return false;
  if (!expectedSalt) return true;
  try {
    return parseBundle(await response.arrayBuffer()).header.salt === expectedSalt;
  } catch {
    return false;
  }
}

export function catalogBundlePath() {
  return CATALOG_PATH;
}
