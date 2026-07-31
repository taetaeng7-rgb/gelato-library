import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHash, routes } from '../js/router.js';
import {
  bookProgressPercent,
  chapterProgressPercent,
  createStore,
  getTargetProgress,
} from '../js/store.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    dump: () => Object.fromEntries(values),
  };
}

test('GitHub Pages용 hash 경로를 파싱한다', () => {
  assert.deepEqual(parseHash('#/'), { name: 'library', params: {}, query: {} });
  assert.deepEqual(parseHash('#/book/goff/chapter/01'), {
    name: 'chapter',
    params: { bookId: 'goff', chapterId: '01' },
    query: {},
  });
  assert.deepEqual(parseHash('#/book/goff/supplement/frontmatter'), {
    name: 'supplement',
    params: { bookId: 'goff', supplementId: 'frontmatter' },
    query: {},
  });
  assert.deepEqual(parseHash('#/read/goff/supplement/frontmatter/s-1/b-2'), {
    name: 'reader',
    params: {
      bookId: 'goff',
      targetKind: 'supplement',
      targetId: 'frontmatter',
      sectionId: 's-1',
      blockId: 'b-2',
    },
    query: {},
  });
  assert.equal(
    routes.reader('goff', 'chapter', '01', 's-1', 'b-2'),
    '#/read/goff/chapter/01/s-1/b-2',
  );
  assert.equal(routes.supplement('goff', 'index'), '#/book/goff/supplement/index');
  assert.equal(parseHash('#/read/goff/01/s-1').params.targetKind, 'chapter');
  assert.equal(
    parseHash('#/read/corvitto/chapter/01/%EC%A0%A4%EB%9D%BC%ED%86%A0%EC%9D%98-%EC%A0%95%EC%9D%98').params.sectionId,
    '젤라토의-정의',
  );
  assert.equal(parseHash('#/read/goff/%2Fbad/s').name, 'notFound');
});

test('진도와 책갈피에는 위치 식별자만 저장한다', () => {
  const storage = memoryStorage();
  const store = createStore(storage);
  store.setSectionProgress('goff', 'chapter', '01', 's-1', 4, 10, 2);
  store.setRecent('goff', 'chapter', '01', 's-1');
  assert.equal(store.toggleBookmark({
    bookId: 'goff',
    targetKind: 'chapter',
    targetId: '01',
    sectionId: 's-1',
    blockId: 'b-4',
    createdAt: 123,
    text: '저장되면 안 되는 본문',
  }), true);
  const serialized = JSON.stringify(storage.dump());
  assert.equal(serialized.includes('저장되면 안 되는 본문'), false);
  assert.equal(store.isBookmarked('goff', 'chapter', '01', 's-1', 'b-4'), true);
  assert.equal(chapterProgressPercent(
    getTargetProgress(store.get().progress, 'goff', 'chapter', '01'),
  ), 25);
  assert.equal(bookProgressPercent(
    'goff',
    [{ id: '01' }, { id: '02' }],
    store.get().progress,
  ), 13);
});

test('기존 chapterId 상태를 targetKind/targetId 구조로 이관한다', () => {
  const storage = memoryStorage({
    'gelato.library.state.v1': JSON.stringify({
      progress: {
        goff: {
          '01': {
            totalSections: 1,
            sections: { intro: { blockIndex: 1, totalBlocks: 2, complete: true } },
          },
        },
      },
      bookmarks: [{ bookId: 'goff', chapterId: '01', sectionId: 'intro' }],
      recent: { bookId: 'goff', chapterId: '01', sectionId: 'intro' },
    }),
  });
  const store = createStore(storage);
  assert.equal(getTargetProgress(store.get().progress, 'goff', 'chapter', '01').sections.intro.complete, true);
  assert.equal(store.get().bookmarks[0].targetKind, 'chapter');
  assert.equal(store.get().bookmarks[0].targetId, '01');
  assert.equal(store.get().recent.targetId, '01');
});

test('읽지 않는 목차 그룹을 진도에서 제외하고 기존 본문 진도를 이관한다', () => {
  const storage = memoryStorage();
  const store = createStore(storage);
  store.setSectionProgress('goff', 'chapter', '01', 'body-1', 1, 2, 3);
  store.setSectionProgress('goff', 'chapter', '01', 'body-2', 0, 1, 3);
  store.setSectionProgress('goff', 'chapter', '01', 'group', 0, 1, 3);
  store.reconcileReaderSections(
    'goff',
    'chapter',
    '01',
    [
      { id: 'body-1', totalBlocks: 2, title: '저장되면 안 되는 제목' },
      { id: 'body-2', totalBlocks: 1 },
    ],
  );
  const target = getTargetProgress(store.get().progress, 'goff', 'chapter', '01');
  assert.equal(target.totalSections, 2);
  assert.equal(target.sections.group, undefined);
  assert.equal(chapterProgressPercent(target), 100);
  assert.equal(JSON.stringify(storage.dump()).includes('저장되면 안 되는 제목'), false);

  const fresh = createStore(memoryStorage());
  fresh.reconcileReaderSections(
    'goff',
    'chapter',
    '02',
    [{ id: 'body', totalBlocks: 4 }],
  );
  assert.equal(chapterProgressPercent(
    getTargetProgress(fresh.get().progress, 'goff', 'chapter', '02'),
  ), 0);
});

test('본문 block 수가 바뀌면 기존 진도 비율을 새 payload에 맞춘다', () => {
  const store = createStore(memoryStorage());
  store.setSectionProgress('corvitto', 'chapter', '04', '계산법', 4, 10, 1);
  store.reconcileReaderSections(
    'corvitto',
    'chapter',
    '04',
    [{ id: '계산법', totalBlocks: 8 }],
  );
  const section = getTargetProgress(
    store.get().progress,
    'corvitto',
    'chapter',
    '04',
  ).sections['계산법'];
  assert.deepEqual(section, {
    blockIndex: 3,
    totalBlocks: 8,
    complete: false,
  });
});

test('글자 크기와 테마 허용값만 보존한다', () => {
  const storage = memoryStorage();
  const store = createStore(storage);
  store.setSettings({ theme: 'dark', fontSize: 'xlarge' });
  store.setSettings({ theme: 'javascript:bad', fontSize: 'giant' });
  assert.deepEqual(store.get().settings, { theme: 'dark', fontSize: 'xlarge' });
});
