import path from 'node:path';

const allowedExactPaths = new Set([
  '.github/workflows/verify.yml',
  '.gitignore',
  '.nojekyll',
  'README.md',
  'apple-touch-icon.png',
  'css/style.css',
  'data/.gelato-output',
  'data/manifest.json',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'icon-maskable.svg',
  'icon.svg',
  'index.html',
  'js/app.js',
  'js/crypto.js',
  'js/data.js',
  'js/reader-navigation.js',
  'js/reader-progress.js',
  'js/router.js',
  'js/sanitize.js',
  'js/store.js',
  'js/unlock-session.js',
  'manifest.webmanifest',
  'package.json',
  'sw.js',
  'test/cache.test.mjs',
  'test/crypto.test.mjs',
  'test/data.test.mjs',
  'test/guard-policy.test.mjs',
  'test/reader-navigation.test.mjs',
  'test/reader-progress.test.mjs',
  'test/router-store.test.mjs',
  'test/service-worker.test.mjs',
  'test/style.test.mjs',
  'test/unlock-session.test.mjs',
  'tools/guard-policy.mjs',
  'tools/guard.mjs',
]);
const allowedPathPatterns = [
  /^data\/catalog\.enc$/u,
  /^data\/search\/(?:corvitto|goff|ai)\.enc$/u,
  /^data\/books\/(?:corvitto|goff|ai)\/chapters\/\d{2}\.enc$/u,
  /^data\/books\/goff\/supplements\/(?:frontmatter|index)\.enc$/u,
];
const plaintextCandidateExtensions = new Set([
  '.csv',
  '.doc',
  '.docx',
  '.epub',
  '.markdown',
  '.md',
  '.mobi',
  '.odt',
  '.pages',
  '.pdf',
  '.rtf',
  '.tex',
  '.tsv',
  '.txt',
]);
const archiveExtensions = new Set([
  '.7z',
  '.bz2',
  '.gz',
  '.rar',
  '.tar',
  '.tgz',
  '.xz',
  '.zip',
  '.zst',
]);
const secretNamePattern = /(?:^|[._-])(?:env(?:rc)?|secrets?|passwords?|passwd|credentials?|private-key|access-token|github-token)(?:$|[._-])/iu;
const secretExtensions = new Set(['.key', '.pem', '.p12', '.pfx', '.keystore']);
const secretBasenames = new Set(['.netrc', '.npmrc', '.pypirc']);

export function isAllowedPublicPath(filePath) {
  const normalized = String(filePath).replaceAll('\\', '/');
  return allowedExactPaths.has(normalized)
    || allowedPathPatterns.some((pattern) => pattern.test(normalized));
}

export function publicPathViolation(filePath) {
  const normalized = String(filePath).replaceAll('\\', '/');
  const extension = path.posix.extname(normalized).toLowerCase();
  const secretLikeSegment = normalized.split('/').some((segment) => (
    secretNamePattern.test(segment)
      || secretExtensions.has(path.posix.extname(segment).toLowerCase())
      || secretBasenames.has(segment.toLowerCase())
  ));
  if (secretLikeSegment) {
    return `비밀정보 파일명으로 보이는 경로가 있습니다: ${normalized}`;
  }
  if (archiveExtensions.has(extension)) {
    return `압축·archive 파일은 공개 저장소에서 허용되지 않습니다: ${normalized}`;
  }
  if (plaintextCandidateExtensions.has(extension) && normalized !== 'README.md') {
    return `평문 자료 allowlist에 없는 파일입니다: ${normalized}`;
  }
  return isAllowedPublicPath(normalized)
    ? null
    : `공개 저장소 allowlist에 없는 경로입니다: ${normalized}`;
}
