import assert from 'node:assert/strict';
import test from 'node:test';
import { progressIndexAtViewport } from '../js/reader-progress.js';

test('viewport보다 긴 마지막 block은 끝까지 읽기 전 완료 처리하지 않는다', () => {
  const items = [
    { index: 0, rect: { top: -300, bottom: -250 } },
    { index: 1, rect: { top: 300, bottom: 2_500 } },
  ];
  assert.equal(progressIndexAtViewport(items, 800, false), 0);
  items[1].rect = { top: -1_700, bottom: 700 };
  assert.equal(progressIndexAtViewport(items, 800, false), 1);
});

test('페이지 끝에서는 긴 마지막 표·목록도 완료 처리한다', () => {
  const items = [{ index: 4, rect: { top: -500, bottom: 1_800 } }];
  assert.equal(progressIndexAtViewport(items, 800, false), 3);
  assert.equal(progressIndexAtViewport(items, 800, true), 4);
});

test('아직 reading line에 도달하지 않은 block은 진도를 올리지 않는다', () => {
  const items = [{ index: 0, rect: { top: 700, bottom: 900 } }];
  assert.equal(progressIndexAtViewport(items, 800, false), -1);
});
