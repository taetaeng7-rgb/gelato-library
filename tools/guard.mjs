import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBundle } from '../js/crypto.js';
import { publicPathViolation } from './guard-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_BUNDLE_COUNT = 36;

async function filesBelow(directory) {
  const results = [];
  let entries = [];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return results;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...await filesBelow(absolute));
    else results.push(absolute);
  }
  return results;
}

const allFiles = await filesBelow(root);
const relativeFiles = allFiles.map((file) => path.relative(root, file));

for (const file of relativeFiles) {
  const violation = publicPathViolation(file);
  assert.equal(violation, null, violation || undefined);
}

const dataFiles = relativeFiles.filter((file) => file === 'data' || file.startsWith(`data${path.sep}`));
const allowedDataMetadata = new Set([
  path.join('data', '.gelato-output'),
  path.join('data', 'manifest.json'),
]);
const encryptedDataFiles = dataFiles.filter((file) => !allowedDataMetadata.has(file));
const encryptedHeaders = new Map();

for (const file of encryptedDataFiles) {
  assert.equal(path.extname(file), '.enc', `public data/에는 .enc만 허용됩니다: ${file}`);
  const bytes = new Uint8Array(await readFile(path.join(root, file)));
  const parsed = parseBundle(bytes);
  encryptedHeaders.set(file, {
    bundleId: parsed.header.bundleId,
    salt: parsed.header.salt,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

for (const file of dataFiles) {
  assert.ok(
    encryptedDataFiles.includes(file) || allowedDataMetadata.has(file),
    `public data/에 허용되지 않은 파일이 있습니다: ${file}`,
  );
}

if (dataFiles.includes(path.join('data', '.gelato-output'))) {
  assert.equal(
    await readFile(path.join(root, 'data', '.gelato-output'), 'utf8'),
    'gelato-content-output-v2\n',
    '암호화 출력 마커가 올바르지 않습니다.',
  );
}

if (dataFiles.includes(path.join('data', 'manifest.json'))) {
  const manifest = JSON.parse(await readFile(path.join(root, 'data', 'manifest.json'), 'utf8'));
  assert.equal(manifest.format, 'GELATOE2', 'manifest 암호화 포맷이 올바르지 않습니다.');
  assert.equal(manifest.bundleCount, EXPECTED_BUNDLE_COUNT, '현재 ebook 번들은 36개여야 합니다.');
  assert.equal(manifest.bundleCount, encryptedDataFiles.length, 'manifest bundle 수가 실제 파일 수와 다릅니다.');
  assert.equal(manifest.entry, 'catalog.enc', 'manifest entry는 catalog.enc여야 합니다.');
  assert.ok(Array.isArray(manifest.files), 'manifest files 목록이 필요합니다.');
  const listedPaths = new Set();
  for (const entry of manifest.files) {
    const relative = path.join('data', entry.path);
    const actual = encryptedHeaders.get(relative);
    assert.ok(actual, `manifest에만 있고 실제로 없는 번들입니다: ${entry.path}`);
    assert.equal(listedPaths.has(entry.path), false, `manifest 중복 경로입니다: ${entry.path}`);
    listedPaths.add(entry.path);
    assert.equal(entry.bundleId, actual.bundleId, `bundleId가 다릅니다: ${entry.path}`);
    assert.equal(entry.bytes, actual.bytes, `bytes가 다릅니다: ${entry.path}`);
    assert.equal(entry.sha256, actual.sha256, `sha256가 다릅니다: ${entry.path}`);
  }
  assert.equal(listedPaths.size, encryptedDataFiles.length, 'manifest에 빠진 암호문이 있습니다.');
}

const salts = new Set([...encryptedHeaders.values()].map((header) => header.salt));
assert.equal(salts.size, 1, '모든 암호문은 같은 build salt를 사용해야 합니다.');
assert.ok(
  encryptedHeaders.has(path.join('data', 'books', 'goff', 'supplements', 'frontmatter.enc')),
  'Goff 앞부분 supplement 번들이 필요합니다.',
);
assert.ok(
  encryptedHeaders.has(path.join('data', 'books', 'goff', 'supplements', 'index.enc')),
  'Goff 색인 supplement 번들이 필요합니다.',
);

const sourceFiles = relativeFiles.filter(
  (file) => /\.(?:css|html|js|mjs|json|md|svg|webmanifest|ya?ml)$/u.test(file),
);
const forbiddenSecrets = [
  /gh[pousr]_[A-Za-z0-9_]{30,}/u,
  /github_pat_[A-Za-z0-9_]{20,}/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
];
for (const file of sourceFiles) {
  const text = await readFile(path.join(root, file), 'utf8');
  for (const pattern of forbiddenSecrets) {
    assert.equal(pattern.test(text), false, `비밀정보로 보이는 값이 있습니다: ${file}`);
  }
}

const appSource = await readFile(path.join(root, 'js/app.js'), 'utf8');
const storeSource = await readFile(path.join(root, 'js/store.js'), 'utf8');
const serviceWorker = await readFile(path.join(root, 'sw.js'), 'utf8');
const index = await readFile(path.join(root, 'index.html'), 'utf8');

assert.match(index, /Content-Security-Policy/u, 'index.html에 CSP가 필요합니다.');
assert.doesNotMatch(
  index,
  /frame-ancestors|Permissions-Policy/iu,
  'GitHub Pages에서 효력이 없는 보안 meta를 선언하면 안 됩니다.',
);
assert.doesNotMatch(index, /<script(?![^>]*\bsrc=)/iu, '인라인 script는 허용하지 않습니다.');
assert.doesNotMatch(index, /\sstyle=/iu, '인라인 style은 허용하지 않습니다.');
assert.match(index, /rel="apple-touch-icon"/u, 'iOS 홈 화면 아이콘 연결이 필요합니다.');
const appShellSource = serviceWorker.match(/const APP_SHELL = \[([\s\S]*?)\];/u)?.[1] || '';
assert.doesNotMatch(appShellSource, /\.enc['"]/u, '암호문을 앱 셸에 자동 precache하면 안 됩니다.');
const appShellPaths = [...appShellSource.matchAll(/['"]\.\/([^'"]+)['"]/gu)]
  .map((match) => match[1])
  .filter(Boolean);
for (const appShellPath of appShellPaths) {
  assert.ok(
    relativeFiles.includes(appShellPath),
    `서비스 워커 앱 셸 파일이 없습니다: ${appShellPath}`,
  );
}
assert.doesNotMatch(
  `${appSource}\n${storeSource}`,
  /localStorage\.(?:setItem|getItem)\([^)]*(?:password|passphrase|plaintext|content|html|key)/iu,
  '비밀번호·키·본문을 localStorage에 저장하면 안 됩니다.',
);
assert.match(appSource, /textContent = block\.text/u, '본문은 textContent로 렌더링해야 합니다.');

console.log(`guard ok: ${relativeFiles.length} files, ${encryptedDataFiles.length} encrypted bundles`);
