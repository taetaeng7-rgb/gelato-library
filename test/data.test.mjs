import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeBundlePath,
  orderedBookTargets,
  validateCatalog,
  validateChapter,
  validateSearchBundle,
  validateSupplement,
} from '../js/data.js';

const chapterBundleId = 'goff:chapter:01';
const digest = 'a'.repeat(64);
const stats = {
  blockCount: 5,
  sectionCount: 2,
  searchableCharacterCount: 20,
};

test('data 루트 안의 .enc 상대경로만 허용한다', () => {
  assert.equal(normalizeBundlePath('books/goff/chapters/01.enc'), 'books/goff/chapters/01.enc');
  assert.equal(normalizeBundlePath('./data/search/goff.enc'), 'search/goff.enc');
  for (const unsafe of ['../secret.enc', '/absolute.enc', 'https://bad.test/a.enc', 'book.json']) {
    assert.throws(() => normalizeBundlePath(unsafe), (error) => error.code === 'BAD_PATH');
  }
});

test('pipeline catalog와 chapter·supplement schema를 검증·절 단위로 변환한다', () => {
  const catalog = {
    schemaVersion: 2,
    kind: 'catalog',
    bundleId: 'catalog',
    library: { id: 'gelato', title: '젤라토 서재', language: 'ko' },
    books: ['goff', 'corvitto'].map((id) => ({
      id,
      title: id,
      subtitle: '',
      authors: ['Author'],
      language: 'ko',
      chapterType: 'source',
      chapterCount: 1,
      chapters: [{
        id: '01',
        number: 1,
        title: '첫 장',
        description: '',
        bundleId: `${id}:chapter:01`,
        bundlePath: `books/${id}/chapters/01.enc`,
        contentDigest: digest,
        stats,
      }],
      supplements: id === 'goff' ? [{
        id: 'frontmatter',
        title: '책 앞부분',
        description: '',
        role: 'frontmatter',
        position: 'before',
        bundleId: 'goff:supplement:frontmatter',
        bundlePath: 'books/goff/supplements/frontmatter.enc',
        contentDigest: digest,
        stats,
      }] : [],
      searchBundleId: `${id}:search`,
      searchBundlePath: `search/${id}.enc`,
    })),
  };
  assert.equal(validateCatalog(catalog), catalog);
  assert.deepEqual(
    orderedBookTargets(catalog.books[0]).map(({ targetKind, targetId }) => (
      `${targetKind}:${targetId}`
    )),
    ['supplement:frontmatter', 'chapter:01'],
  );

  const chapter = validateChapter({
    schemaVersion: 2,
    kind: 'chapter',
    bundleId: chapterBundleId,
    bookId: 'goff',
    chapterId: '01',
    number: 1,
    title: '첫 장',
    description: '',
    source: { type: 'source-chapter', files: ['books/goff/ch01.md'] },
    contentDigest: digest,
    stats,
    sections: [
      { id: '첫-절', title: '첫 절', level: 2, blockId: 'b0' },
      { id: 's2', title: '둘째 절', level: 2, blockId: 'b3' },
    ],
    blocks: [
      {
        id: 'b0',
        type: 'sourceAnchor',
        pdfPage: '1',
        printPage: null,
        printLocator: '표제지 다음의 번호 없는 사진 지면',
        pageRole: null,
      },
      { id: 'b1', type: 'heading', level: 2, text: '첫 절', anchor: 'first' },
      { id: 'b2', type: 'paragraph', text: '내용' },
      { id: 'b3', type: 'heading', level: 2, text: '둘째 절', anchor: 'second' },
      { id: 'b4', type: 'thematicBreak' },
    ],
  }, 'goff', '01');
  assert.equal(chapter.id, '01');
  assert.deepEqual(chapter.sections.map((section) => section.blocks.length), [3, 2]);
  assert.equal(chapter.sections[0].blocks[0].type, 'sourceAnchor');
  assert.equal(
    chapter.sections[0].blocks[0].printLocator,
    '표제지 다음의 번호 없는 사진 지면',
  );

  const supplement = validateSupplement({
    schemaVersion: 2,
    kind: 'supplement',
    bundleId: 'goff:supplement:frontmatter',
    bookId: 'goff',
    supplementId: 'frontmatter',
    title: '책 앞부분',
    description: '',
    role: 'frontmatter',
    position: 'before',
    source: { type: 'source-supplement', files: ['books/goff/frontmatter.md'] },
    contentDigest: digest,
    stats: { blockCount: 1, sectionCount: 1, searchableCharacterCount: 4 },
    sections: [{ id: 'intro', title: '들어가며', level: 1, blockId: 's1' }],
    blocks: [{ id: 's1', type: 'paragraph', text: '들어가며' }],
  }, 'goff', 'frontmatter');
  assert.equal(supplement.targetKind, 'supplement');
  assert.equal(supplement.sections[0].blocks[0].text, '들어가며');
});

test('검색 색인의 chapter·supplement 위치와 null section을 확인한다', () => {
  const bundle = {
    schemaVersion: 2,
    kind: 'search-index',
    bundleId: 'goff:search',
    bookId: 'goff',
    documentCount: 2,
    documents: [
      {
        id: 'd1',
        targetKind: 'chapter',
        targetId: '01',
        sectionId: 's1',
        blockId: 'b1',
        text: 'gelato',
        normalized: 'gelato',
      },
      {
        id: 'd2',
        targetKind: 'supplement',
        targetId: 'index',
        sectionId: null,
        blockId: 'b2',
        text: '색인',
        normalized: '색인',
      },
    ],
  };
  const validated = validateSearchBundle(bundle, 'goff');
  assert.deepEqual(
    validated.documents.map(({ targetKind, targetId, sectionId }) => ({
      targetKind,
      targetId,
      sectionId,
    })),
    [
      { targetKind: 'chapter', targetId: '01', sectionId: 's1' },
      { targetKind: 'supplement', targetId: 'index', sectionId: null },
    ],
  );
});
