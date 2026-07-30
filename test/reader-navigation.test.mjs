import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readerKeyDirection,
  readerPageAction,
  readerPageDistance,
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
