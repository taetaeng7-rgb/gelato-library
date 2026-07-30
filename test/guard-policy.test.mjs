import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { publicPathViolation } from '../tools/guard-policy.mjs';

const root = path.resolve(import.meta.dirname, '..');

async function filesBelow(directory) {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...await filesBelow(absolute));
    else results.push(path.relative(root, absolute));
  }
  return results;
}

test('README만 평문 문서 allowlist로 허용한다', () => {
  assert.equal(publicPathViolation('README.md'), null);
  for (const file of [
    'translation/ch01.md',
    'notes.txt',
    'draft.docx',
    'book.epub',
    'book.odt',
    'book.rtf',
    'source.pdf',
    'table.csv',
  ]) {
    assert.match(publicPathViolation(file), /평문 자료 allowlist/u, file);
  }
});

test('번역 원고가 숨을 수 있는 archive 형식을 기본 거부한다', () => {
  for (const file of [
    'translation.zip',
    'backup.tar',
    'backup.tar.gz',
    'source.7z',
    'source.rar',
    'bundle.tgz',
    'bundle.xz',
  ]) {
    assert.match(publicPathViolation(file), /archive/u, file);
  }
});

test('비밀번호·토큰·개인키 형태의 경로를 거부한다', () => {
  for (const file of [
    '.env',
    'config/.envrc',
    'secrets.json',
    'passwords.txt',
    '.npmrc',
    'keys/deploy.pem',
  ]) {
    assert.match(publicPathViolation(file), /비밀정보|평문 자료/u, file);
  }
});

test('확장자 우회명과 확장자 없는 평문 후보도 exact allowlist로 거부한다', () => {
  for (const file of [
    'draft',
    'draft.md.bak',
    'gelato-library.passphrase',
    'id_rsa',
    'backup.zipx',
    'test/leaked-book.test.mjs',
  ]) {
    assert.ok(publicPathViolation(file), `${file}이 허용되었습니다.`);
  }
});

test('현재 공개 산출물 72개는 exact allowlist와 일치한다', async () => {
  const files = await filesBelow(root);
  assert.equal(files.length, 72);
  assert.deepEqual(
    files
      .map((file) => [file, publicPathViolation(file)])
      .filter(([, violation]) => violation),
    [],
  );
});
