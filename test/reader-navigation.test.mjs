import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readerKeyDirection,
  readerPageAction,
  readerPageDistance,
  readerSwipeDirection,
  resolveReadableSection,
  sectionHasReadableContent,
  sectionOutlineEntries,
} from '../js/reader-navigation.js';

function keyboardEvent(overrides = {}) {
  return {
    key: 'ArrowRight',
    defaultPrevented: false,
    repeat: false,
    isComposing: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    target: { closest: () => null },
    ...overrides,
  };
}

test('읽기 화면의 좌우 방향키만 페이지 이동으로 해석한다', () => {
  assert.equal(readerKeyDirection(keyboardEvent()), 1);
  assert.equal(readerKeyDirection(keyboardEvent({ key: 'ArrowLeft' })), -1);
  assert.equal(readerKeyDirection(keyboardEvent({ key: 'ArrowDown' })), 0);
});

test('입력·선택·수정키·반복·IME·대화상자에서는 방향키를 가로채지 않는다', () => {
  const blockedTarget = { closest: () => ({ nodeName: 'INPUT' }) };
  assert.equal(readerKeyDirection(keyboardEvent({ target: blockedTarget })), 0);
  assert.equal(readerKeyDirection(keyboardEvent({ repeat: true })), 0);
  assert.equal(readerKeyDirection(keyboardEvent({ isComposing: true })), 0);
  assert.equal(readerKeyDirection(keyboardEvent({ ctrlKey: true })), 0);
  assert.equal(readerKeyDirection(keyboardEvent(), { dialogOpen: true }), 0);
  assert.equal(readerKeyDirection(keyboardEvent(), { selectionActive: true }), 0);
});

test('모바일 좌우 스와이프를 읽기 방향으로 해석한다', () => {
  const start = { x: 220, y: 300, time: 100 };
  assert.equal(
    readerSwipeDirection(start, { x: 130, y: 305, time: 350 }),
    1,
  );
  assert.equal(
    readerSwipeDirection(start, { x: 300, y: 295, time: 350 }),
    -1,
  );
});

test('짧거나 느리거나 세로에 가까운 제스처는 스와이프로 해석하지 않는다', () => {
  const start = { x: 220, y: 300, time: 100 };
  assert.equal(readerSwipeDirection(start, { x: 180, y: 302, time: 250 }), 0);
  assert.equal(readerSwipeDirection(start, { x: 130, y: 305, time: 900 }), 0);
  assert.equal(readerSwipeDirection(start, { x: 130, y: 390, time: 350 }), 0);
});

test('절 중간에서는 한 화면 이동하고 위·아래 끝에서만 이웃 링크로 이동한다', () => {
  const metrics = {
    viewportHeight: 800,
    documentHeight: 3_000,
  };
  assert.equal(readerPageAction(1, { ...metrics, scrollTop: 1_000 }), 'scroll');
  assert.equal(readerPageAction(-1, { ...metrics, scrollTop: 1_000 }), 'scroll');
  assert.equal(readerPageAction(1, { ...metrics, scrollTop: 2_195 }), 'next');
  assert.equal(readerPageAction(-1, { ...metrics, scrollTop: 7 }), 'previous');
  assert.equal(readerPageAction(0, metrics), 'none');
});

test('고정 상·하단 영역과 겹침분을 제외해 화면 이동 거리를 계산한다', () => {
  assert.equal(readerPageDistance({
    viewportHeight: 900,
    headerHeight: 68,
    bottomInset: 70,
    overlap: 32,
  }), 730);
  assert.equal(readerPageDistance({ viewportHeight: 10, headerHeight: 20 }), 1);
});

test('목차의 H1~H3 계층을 깊이와 윤곽 번호로 보존한다', () => {
  const sections = [
    { id: 'a', level: 2 },
    { id: 'b', level: 3 },
    { id: 'c', level: 3 },
    { id: 'd', level: 2 },
    { id: 'e', level: 3 },
  ];
  const entries = sectionOutlineEntries(sections);
  assert.deepEqual(entries.map(({ label }) => label), ['1', '1.1', '1.2', '2', '2.1']);
  assert.deepEqual(entries.map(({ depth }) => depth), [0, 1, 1, 0, 1]);
  assert.deepEqual(entries.map(({ section }) => section.id), ['a', 'b', 'c', 'd', 'e']);
});

test('본문 없는 상위 제목과 페이지 표식만 있는 절은 읽기 화면에서 건너뛴다', () => {
  const group = {
    id: 'group',
    title: '목차',
    level: 2,
    blocks: [
      { type: 'sourceAnchor', pdfPage: '8' },
      { type: 'heading', text: '목차' },
      { type: 'thematicBreak' },
    ],
  };
  const readable = {
    id: 'readable',
    title: '제1장',
    level: 3,
    blocks: [
      { type: 'heading', text: '제1장' },
      { type: 'paragraph', text: '실제 내용' },
    ],
  };
  const sections = [group, readable];
  assert.equal(sectionHasReadableContent(group, 0, sections), false);
  assert.equal(sectionHasReadableContent(readable, 1, sections), true);
  assert.equal(resolveReadableSection([group, readable], 'group'), readable);
});

test('제목 자체가 내용인 헌사 같은 leaf 절은 건너뛰지 않는다', () => {
  const readable = {
    id: 'readable',
    title: '본문',
    level: 2,
    blocks: [{ type: 'paragraph', text: '내용' }],
  };
  const dedication = {
    id: 'dedication',
    title: '부모님을 기리며',
    level: 3,
    blocks: [{ type: 'heading', text: '부모님을 기리며' }],
  };
  const sections = [readable, dedication];
  assert.equal(sectionHasReadableContent(dedication, 1, sections), true);
  assert.equal(resolveReadableSection(sections, 'dedication'), dedication);
});
