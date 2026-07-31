import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const css = await readFile(new URL('../css/style.css', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');

function declarationBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'u'))?.[1] || '';
}

function variables(selector, inherited = {}) {
  const result = { ...inherited };
  for (const [, name, value] of declarationBlock(selector).matchAll(/--([\w-]+)\s*:\s*([^;]+);/gu)) {
    result[name] = value.trim();
  }
  return result;
}

function rgb(hex) {
  const match = /^#([\da-f]{6})$/iu.exec(hex);
  assert.ok(match, `6자리 hex 색상이 아닙니다: ${hex}`);
  return [0, 2, 4].map((offset) => Number.parseInt(match[1].slice(offset, offset + 2), 16));
}

function luminance(hex) {
  const channels = rgb(hex).map((value) => {
    const channel = value / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(left, right) {
  const [bright, dark] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (bright + 0.05) / (dark + 0.05);
}

const light = variables(':root');
const sepia = variables(':root[data-theme="sepia"]', light);
const dark = variables(':root[data-theme="dark"]', light);

test('세 테마의 보조 글자와 주요 버튼은 WCAG AA 대비를 충족한다', () => {
  for (const [name, theme] of Object.entries({ light, sepia, dark })) {
    assert.ok(
      contrast(theme.muted, theme.bg) >= 4.5,
      `${name} muted/bg 대비가 4.5:1보다 낮습니다.`,
    );
    assert.ok(
      contrast(theme['on-accent'], theme.accent) >= 4.5,
      `${name} primary button 대비가 4.5:1보다 낮습니다.`,
    );
  }
});

test('키보드 포커스 색은 배경과 surface에서 식별 가능하다', () => {
  for (const [name, theme] of Object.entries({ light, sepia, dark })) {
    for (const surface of ['bg', 'surface']) {
      assert.ok(
        contrast(theme.focus, theme[surface]) >= 3,
        `${name} focus/${surface} 대비가 3:1보다 낮습니다.`,
      );
    }
  }
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--focus\)/u);
});

test('모바일 safe-area와 sticky reader header 회귀를 막는다', () => {
  assert.match(light['header-total-height'], /env\(safe-area-inset-top\)/u);
  assert.match(
    declarationBlock('.site-header'),
    /position:\s*sticky/u,
  );
  assert.match(
    declarationBlock('.site-header'),
    /env\(safe-area-inset-top\)/u,
  );
  assert.doesNotMatch(
    css,
    /body\[data-reader[^\]]*\]\s+\.site-header\s*\{[^}]*position:\s*absolute/iu,
  );
  assert.match(
    declarationBlock('.content-block'),
    /scroll-margin-top:\s*calc\(var\(--header-total-height\)/u,
  );
});

test('hash router를 바꾸지 않고 본문 건너뛰기가 동작한다', () => {
  assert.match(
    appSource,
    /skipLink\.addEventListener\('click',[\s\S]*?event\.preventDefault\(\)[\s\S]*?app\.focus/u,
  );
});

test('설명형 인용문과 주석의 의미 있는 줄바꿈을 보존한다', () => {
  assert.match(
    css,
    /\.reader-content blockquote p,[\s\S]*?white-space:\s*pre-line/u,
  );
});

test('독자용 구분선을 그리지 않고 block 종류별 스타일 hook을 둔다', () => {
  assert.doesNotMatch(appSource, /createElement\(['"]hr['"]\)/u);
  assert.match(appSource, /wrapper\.dataset\.blockType\s*=\s*block\.type/u);
  assert.match(
    declarationBlock('.reader-content .source-anchor'),
    /font-size:\s*max\(0\.75rem,\s*0\.7em\)/u,
  );
});

test('block code는 균일한 배경과 키보드 스크롤 영역을 사용한다', () => {
  assert.match(
    declarationBlock('.reader-content pre code'),
    /background:\s*transparent/u,
  );
  assert.match(
    css,
    /\.reader-content pre\s*\{[^}]*border:\s*1px solid var\(--line\)/u,
  );
  assert.match(appSource, /pre\.tabIndex\s*=\s*0/u);
  assert.match(appSource, /pre\.setAttribute\('role',\s*'region'\)/u);
});

test('본문의 H5·H6 계층과 모바일 다음 절 제목을 보존한다', () => {
  assert.match(appSource, /Math\.min\(6,\s*Math\.max\(2,/u);
  assert.match(css, /\.reader-content h5\s*\{/u);
  assert.match(css, /\.reader-content h6\s*\{/u);
  assert.match(
    css,
    /@media \(max-width:\s*30rem\)[\s\S]*?\.reader-footer-nav\s*\{[\s\S]*?grid-template-columns:\s*1fr/u,
  );
  assert.match(css, /-webkit-line-clamp:\s*2/u);
});

test('시각 자료 설명은 일반 인용문과 구분된 접근성 영역이다', () => {
  assert.match(appSource, /aside\.className\s*=\s*'visual-description'/u);
  assert.match(appSource, /aside\.setAttribute\('aria-label',\s*'시각 자료 설명'\)/u);
  assert.match(
    declarationBlock('.reader-content .visual-description'),
    /border-left:\s*4px solid var\(--warm\)/u,
  );
});
