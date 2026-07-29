// GELATOE2:
// MAGIC(8) | canonical header length uint32 BE | canonical UTF-8 JSON header | AES-GCM ciphertext+tag
// AES-GCM additionalData is the exact canonical JSON header bytes.
const MAGIC = 'GELATOE2';
const MAGIC_BYTES = new TextEncoder().encode(MAGIC);
const MIN_ITERATIONS = 600_000;
const MAX_ITERATIONS = 5_000_000;
const MAX_HEADER_BYTES = 16_384;
const HEADER_KEYS = ['bundleId', 'iterations', 'iv', 'kdf', 'salt', 'schemaVersion'];
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export class CryptoBundleError extends Error {
  constructor(code, cause) {
    super(code, cause ? { cause } : undefined);
    this.name = 'CryptoBundleError';
    this.code = code;
  }
}

const fail = (code, cause) => {
  throw new CryptoBundleError(code, cause);
};

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  fail('BAD_FORMAT');
}

function bytesEqual(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  let mismatch = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    mismatch |= left[index] ^ right[index];
  }
  return mismatch === 0;
}

export function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('BAD_HEADER');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  fail('BAD_HEADER');
}

export function base64UrlToBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) fail('BAD_HEADER');
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/') + padding;
  try {
    if (typeof atob === 'function') {
      return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    }
    return new Uint8Array(Buffer.from(base64, 'base64'));
  } catch (error) {
    fail('BAD_HEADER', error);
  }
}

export function bytesToBase64Url(bytes) {
  const value = toUint8Array(bytes);
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  const base64 = typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(value).toString('base64');
  return base64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function validateHeader(header, rawHeader) {
  if (!header || typeof header !== 'object' || Array.isArray(header)) fail('BAD_HEADER');
  const keys = Object.keys(header).sort();
  if (keys.length !== HEADER_KEYS.length || keys.some((key, index) => key !== HEADER_KEYS[index])) {
    fail('BAD_HEADER');
  }
  if (header.schemaVersion !== 2 || header.kdf !== 'PBKDF2-SHA256') fail('BAD_VERSION');
  if (!Number.isInteger(header.iterations)
      || header.iterations < MIN_ITERATIONS
      || header.iterations > MAX_ITERATIONS) {
    fail('UNSAFE_ITERATIONS');
  }
  if (typeof header.bundleId !== 'string'
      || header.bundleId.length < 1
      || header.bundleId.length > 160
      || !/^[a-z0-9][a-z0-9:-]*$/u.test(header.bundleId)) {
    fail('BAD_HEADER');
  }
  const canonical = textEncoder.encode(canonicalJson(header));
  if (!bytesEqual(canonical, rawHeader)) fail('NON_CANONICAL_HEADER');
  const salt = base64UrlToBytes(header.salt);
  const iv = base64UrlToBytes(header.iv);
  if (salt.byteLength !== 16 || iv.byteLength !== 12) fail('BAD_HEADER');
  if (bytesToBase64Url(salt) !== header.salt || bytesToBase64Url(iv) !== header.iv) {
    fail('NON_CANONICAL_HEADER');
  }
  return { salt, iv };
}

export function parseBundle(input) {
  const bytes = toUint8Array(input);
  if (bytes.byteLength < 8 + 4 + 2 + 16) fail('BAD_FORMAT');
  if (!bytesEqual(bytes.subarray(0, MAGIC_BYTES.length), MAGIC_BYTES)) fail('BAD_MAGIC');

  const headerLength = new DataView(
    bytes.buffer,
    bytes.byteOffset + MAGIC_BYTES.length,
    4,
  ).getUint32(0, false);
  if (headerLength < 2 || headerLength > MAX_HEADER_BYTES) fail('BAD_HEADER');

  const headerStart = MAGIC_BYTES.length + 4;
  const ciphertextStart = headerStart + headerLength;
  if (ciphertextStart + 16 >= bytes.byteLength) fail('BAD_FORMAT');

  const headerBytes = bytes.slice(headerStart, ciphertextStart);
  let header;
  try {
    header = JSON.parse(textDecoder.decode(headerBytes));
  } catch (error) {
    fail('BAD_HEADER', error);
  }
  const { salt, iv } = validateHeader(header, headerBytes);
  const ciphertext = bytes.slice(ciphertextStart);
  return { header, headerBytes, salt, iv, ciphertext };
}

export async function deriveAesKey(password, salt, iterations) {
  if (typeof password !== 'string' || password.length === 0) fail('EMPTY_PASSWORD');
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) fail('WEBCRYPTO_UNAVAILABLE');
  const passwordMaterial = await subtle.importKey(
    'raw',
    textEncoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt,
      iterations,
    },
    passwordMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
}

async function decryptParsed(parsed, key) {
  try {
    const clearBytes = await globalThis.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: parsed.iv,
        additionalData: parsed.headerBytes,
        tagLength: 128,
      },
      key,
      parsed.ciphertext,
    );
    const value = JSON.parse(textDecoder.decode(clearBytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('BAD_PAYLOAD');
    return value;
  } catch (error) {
    if (error instanceof CryptoBundleError) throw error;
    fail('DECRYPT_FAILED', error);
  }
}

export class GelatoVault {
  #key = null;
  #salt = null;

  get unlocked() {
    return Boolean(this.#key);
  }

  async unlockCatalog(input, password) {
    const parsed = parseBundle(input);
    if (parsed.header.bundleId !== 'catalog') fail('UNEXPECTED_BUNDLE');
    const key = await deriveAesKey(password, parsed.salt, parsed.header.iterations);
    const payload = await decryptParsed(parsed, key);
    this.#key = key;
    this.#salt = parsed.header.salt;
    return payload;
  }

  async decrypt(input, expectedBundleId) {
    if (!this.#key || !this.#salt) fail('LOCKED');
    const parsed = parseBundle(input);
    if (parsed.header.salt !== this.#salt) fail('SALT_MISMATCH');
    if (expectedBundleId && parsed.header.bundleId !== expectedBundleId) {
      fail('UNEXPECTED_BUNDLE');
    }
    return decryptParsed(parsed, this.#key);
  }

  lock() {
    this.#key = null;
    this.#salt = null;
  }
}
