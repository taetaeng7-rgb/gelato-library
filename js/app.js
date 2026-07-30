import {
  BundleRepository,
  isBundleCached,
  orderedBookTargets,
  removeCachedBundle,
} from './data.js';
import { progressIndexAtViewport } from './reader-progress.js';
import { parseHash, routes } from './router.js';
import {
  bookProgressPercent,
  chapterProgressPercent,
  createStore,
  getTargetProgress,
} from './store.js';
import { escapeHtml } from './sanitize.js';
import { MIN_PASSWORD_CHARACTERS } from './crypto.js';

const app = document.querySelector('#app');
const skipLink = document.querySelector('.skip-link');
const bottomNav = document.querySelector('#bottom-nav');
const lockButton = document.querySelector('#lock-button');
const searchButton = document.querySelector('#search-button');
const settingsButton = document.querySelector('#reader-settings-button');
const settingsDialog = document.querySelector('#settings-dialog');
const themeMeta = document.querySelector('meta[name="theme-color"]');
const toastElement = document.querySelector('#toast');
const repository = new BundleRepository();
const store = createStore();
const lockChannel = 'BroadcastChannel' in globalThis
  ? new BroadcastChannel('gelato-library-session')
  : null;

let viewController = null;
let renderVersion = 0;
let toastTimer = null;
let hiddenAt = null;
let lastFocusedRoute = '';

skipLink.addEventListener('click', (event) => {
  event.preventDefault();
  app.focus({ preventScroll: true });
  app.scrollIntoView({ block: 'start', behavior: 'auto' });
});

function beginView() {
  viewController?.abort();
  viewController = new AbortController();
  return viewController.signal;
}

function applySettings() {
  const { theme, fontSize } = store.get().settings;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.fontSize = fontSize;
  themeMeta.content = theme === 'dark' ? '#111816' : theme === 'sepia' ? '#eee3cc' : '#f7f2e8';
  for (const button of document.querySelectorAll('[data-theme-value]')) {
    button.setAttribute('aria-pressed', String(button.dataset.themeValue === theme));
  }
  for (const button of document.querySelectorAll('[data-font-size]')) {
    button.setAttribute('aria-pressed', String(button.dataset.fontSize === fontSize));
  }
}

function toast(message) {
  window.clearTimeout(toastTimer);
  toastElement.textContent = message;
  toastElement.dataset.open = 'true';
  toastTimer = window.setTimeout(() => {
    toastElement.dataset.open = 'false';
  }, 2_800);
}

function setUnlockedChrome(unlocked) {
  lockButton.hidden = !unlocked;
  searchButton.hidden = !unlocked;
  bottomNav.hidden = !unlocked;
}

function setActiveNav(name) {
  for (const link of bottomNav.querySelectorAll('[data-nav]')) {
    const active = link.dataset.nav === name;
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function setPageTitle(title = '') {
  document.title = title ? `${title} · 젤라토 서재` : '젤라토 서재';
}

function showLoading(label = '책을 불러오는 중') {
  app.innerHTML = `
    <div class="loading" role="status">
      <div>
        <div class="spinner" aria-hidden="true"></div>
        <span>${escapeHtml(label)}</span>
      </div>
    </div>`;
}

function errorMessage(error) {
  const code = error?.code || error?.message;
  const messages = {
    BAD_MAGIC: '지원하지 않는 암호화 파일입니다.',
    BAD_FORMAT: '암호화 파일 형식이 올바르지 않습니다.',
    BAD_HEADER: '암호화 파일의 보안 헤더가 손상되었습니다.',
    BAD_VERSION: '앱에서 지원하지 않는 콘텐츠 버전입니다.',
    NON_CANONICAL_HEADER: '암호화 파일 헤더 검증에 실패했습니다.',
    UNSAFE_ITERATIONS: '안전하지 않거나 지나치게 큰 키 유도 설정입니다.',
    DECRYPT_FAILED: '비밀번호가 다르거나 파일이 손상되었습니다.',
    EMPTY_PASSWORD: '비밀번호를 입력해 주세요.',
    PASSWORD_TOO_SHORT: `비밀번호는 ${MIN_PASSWORD_CHARACTERS}자 이상이어야 합니다.`,
    HASH_MISMATCH: '콘텐츠 무결성 검증에 실패했습니다.',
    SALT_MISMATCH: '서로 다른 암호화 세트의 파일입니다.',
    UNEXPECTED_BUNDLE: '요청한 콘텐츠와 암호화 파일이 일치하지 않습니다.',
    BAD_CATALOG: '책 목록 데이터 형식이 올바르지 않습니다.',
    BAD_CHAPTER: '챕터 데이터 형식이 올바르지 않습니다.',
    BAD_SUPPLEMENT: '책의 앞뒤 자료 형식이 올바르지 않습니다.',
    BAD_SEARCH: '검색 데이터 형식이 올바르지 않습니다.',
    BAD_PATH: '안전하지 않은 콘텐츠 경로가 차단되었습니다.',
    NOT_FOUND: '요청한 콘텐츠 파일을 찾지 못했습니다.',
    BUNDLE_TOO_LARGE: '콘텐츠 파일이 허용 크기를 초과했습니다.',
    NETWORK_ERROR: '네트워크에 연결할 수 없습니다. 오프라인 저장 여부를 확인해 주세요.',
    HTTP_ERROR: '콘텐츠를 불러오지 못했습니다.',
    CONTENT_UPDATED: '콘텐츠가 갱신되었습니다. 서재를 잠근 뒤 다시 열어 주세요.',
    CACHE_UNAVAILABLE: '이 브라우저에서는 오프라인 저장을 사용할 수 없습니다.',
    WEBCRYPTO_UNAVAILABLE: '이 브라우저에서는 안전한 복호화를 사용할 수 없습니다.',
  };
  return messages[code] || '예상하지 못한 오류가 발생했습니다.';
}

function renderError(error, heading = '콘텐츠를 열 수 없습니다') {
  const signal = beginView();
  document.body.dataset.reader = 'false';
  app.innerHTML = `
    <section class="page-shell narrow-shell">
      <div class="error-state" role="alert">
        <h1>${escapeHtml(heading)}</h1>
        <p>${escapeHtml(errorMessage(error))}</p>
        <button class="primary-button" type="button" id="retry-button">다시 시도</button>
        <a class="secondary-button" href="#/">서재로 이동</a>
      </div>
    </section>`;
  app.querySelector('#retry-button')?.addEventListener('click', renderRoute, { signal });
}

function renderUnlock() {
  const signal = beginView();
  setUnlockedChrome(false);
  setActiveNav('');
  setPageTitle('잠금 해제');
  document.body.dataset.reader = 'false';
  app.innerHTML = `
    <section class="unlock-page" aria-labelledby="unlock-title">
      <div class="unlock-card">
        <div class="unlock-emblem" aria-hidden="true">G</div>
        <h1 id="unlock-title">젤라토 서재 열기</h1>
        <p>비밀번호는 이 탭의 메모리에서만 사용되며 브라우저 저장소나 서버로 전송되지 않습니다.</p>
        <form id="unlock-form">
          <label class="field-label" for="password">비밀번호 (${MIN_PASSWORD_CHARACTERS}자 이상)</label>
          <div class="password-row">
            <input id="password" name="password" type="password" required autocomplete="off"
              minlength="${MIN_PASSWORD_CHARACTERS}" autocapitalize="none" spellcheck="false"
              aria-describedby="unlock-error">
            <button class="secondary-button" id="password-toggle" type="button"
              aria-controls="password" aria-pressed="false">표시</button>
          </div>
          <button class="primary-button unlock-submit" id="unlock-submit" type="submit">서재 열기</button>
          <p class="form-error" id="unlock-error" role="alert" aria-live="polite"></p>
        </form>
        <div class="privacy-note">
          <span aria-hidden="true">◇</span>
          <span>새로고침하거나 잠그면 키가 사라져 비밀번호를 다시 입력해야 합니다.</span>
        </div>
      </div>
    </section>`;

  const form = app.querySelector('#unlock-form');
  const passwordInput = app.querySelector('#password');
  const toggle = app.querySelector('#password-toggle');
  const error = app.querySelector('#unlock-error');
  const submit = app.querySelector('#unlock-submit');

  toggle.addEventListener('click', () => {
    const visible = passwordInput.type === 'text';
    passwordInput.type = visible ? 'password' : 'text';
    toggle.textContent = visible ? '표시' : '숨김';
    toggle.setAttribute('aria-pressed', String(!visible));
    passwordInput.focus();
  }, { signal });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    let password = passwordInput.value;
    passwordInput.value = '';
    if (!password) {
      error.textContent = '비밀번호를 입력해 주세요.';
      passwordInput.focus();
      return;
    }
    if (Array.from(password).length < MIN_PASSWORD_CHARACTERS) {
      password = '';
      error.textContent = `비밀번호는 ${MIN_PASSWORD_CHARACTERS}자 이상이어야 합니다.`;
      passwordInput.focus();
      return;
    }
    error.textContent = '';
    submit.disabled = true;
    submit.textContent = '안전하게 여는 중…';
    try {
      await repository.unlock(password);
      password = '';
      setUnlockedChrome(true);
      const route = parseHash();
      if (route.name === 'notFound') location.hash = routes.library();
      else await renderRoute();
    } catch (unlockError) {
      password = '';
      error.textContent = errorMessage(unlockError);
      submit.disabled = false;
      submit.textContent = '서재 열기';
      passwordInput.focus();
    }
  }, { signal });

  window.requestAnimationFrame(() => passwordInput.focus());
}

function bookById(bookId) {
  return repository.catalog?.books.find((book) => book.id === bookId) || null;
}

function targetSummary(book, targetKind, targetId) {
  if (!book) return null;
  const items = targetKind === 'supplement' ? book.supplements : book.chapters;
  const summary = items?.find((item) => item.id === targetId);
  return summary ? { ...summary, targetKind, targetId } : null;
}

function targetDetailRoute(bookId, targetKind, targetId, blockId = null) {
  return routes.target(bookId, targetKind, targetId, blockId);
}

function targetKicker(target) {
  if (target.targetKind === 'chapter') return `${target.number}장`;
  return target.role === 'index' ? '찾아보기' : '책 앞부분';
}

function progressMarkup(percent, label = '읽은 분량') {
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  return `
    <div class="progress-wrap">
      <div class="progress-label"><span>${escapeHtml(label)}</span><span>${safePercent}%</span></div>
      <progress class="progress-track" aria-label="${escapeHtml(label)}"
        max="100" value="${safePercent}">${safePercent}%</progress>
    </div>`;
}

function renderLibrary() {
  const signal = beginView();
  const catalog = repository.catalog;
  const state = store.get();
  setPageTitle('');
  setActiveNav('library');
  document.body.dataset.reader = 'false';

  const recent = state.recent;
  const recentBook = recent ? bookById(recent.bookId) : null;
  const recentTarget = recent
    ? targetSummary(recentBook, recent.targetKind, recent.targetId)
    : null;
  const recentHref = recentBook && recentTarget
    ? routes.reader(
        recent.bookId,
        recent.targetKind,
        recent.targetId,
        recent.sectionId,
      )
    : '';

  app.innerHTML = `
    <section class="page-shell">
      <header class="page-heading library-hero">
        <p class="eyebrow">My gelato bookshelf</p>
        <h1>젤라토를 깊이 읽는<br>작은 서재</h1>
        <p>책을 고르고, 챕터를 거쳐, 읽고 싶은 절로 바로 이동하세요.</p>
        ${recentHref ? `
          <p><a class="primary-button" href="${recentHref}">최근 읽던 곳 이어보기</a></p>
        ` : ''}
      </header>
      <div class="book-grid">
        ${catalog.books.map((book, index) => {
          const percent = bookProgressPercent(book.id, book.chapters, state.progress);
          const authors = book.authors.join(', ');
          return `
            <article class="book-card">
              <div class="book-cover" aria-hidden="true"><span>${String(index + 1).padStart(2, '0')}</span></div>
              <div class="book-card-body">
                <h2>${escapeHtml(book.title)}</h2>
                <p class="book-meta">${escapeHtml(book.subtitle || authors)}</p>
                <p class="book-description">${escapeHtml(book.description || '')}</p>
                <div class="book-card-footer">
                  ${progressMarkup(percent)}
                  <a class="primary-button" href="${routes.book(book.id)}">
                    ${percent > 0 ? '계속 읽기' : '책 열기'}
                  </a>
                </div>
              </div>
            </article>`;
        }).join('')}
      </div>
    </section>`;

  app.querySelectorAll('.book-card a').forEach((link) => {
    link.addEventListener('click', () => {}, { signal });
  });
}

function renderBook(bookId) {
  const signal = beginView();
  const book = bookById(bookId);
  if (!book) {
    renderError({ code: 'NOT_FOUND' }, '책을 찾을 수 없습니다');
    return;
  }
  const state = store.get();
  setPageTitle(book.title);
  setActiveNav('library');
  document.body.dataset.reader = 'false';
  const bookPercent = bookProgressPercent(book.id, book.chapters, state.progress);
  const supplementList = (position, heading) => {
    const items = book.supplements.filter((item) => item.position === position);
    if (!items.length) return '';
    return `
      <section class="supplement-group" aria-labelledby="supplement-${position}-title">
        <h2 id="supplement-${position}-title">${heading}</h2>
        <ul class="chapter-list supplement-list">
          ${items.map((item) => {
            const percent = chapterProgressPercent(
              getTargetProgress(state.progress, book.id, 'supplement', item.id),
            );
            return `
              <li class="chapter-card supplement-card">
                <span class="chapter-number" aria-hidden="true">${item.role === 'index' ? '찾기' : '앞'}</span>
                <div>
                  <h3><a href="${routes.supplement(book.id, item.id)}">${escapeHtml(item.title)}</a></h3>
                  ${item.description ? `<p>${escapeHtml(item.description)}</p>` : ''}
                  ${progressMarkup(percent, '읽은 분량')}
                </div>
              </li>`;
          }).join('')}
        </ul>
      </section>`;
  };
  app.innerHTML = `
    <section class="page-shell narrow-shell">
      <nav class="breadcrumbs" aria-label="현재 위치">
        <a href="#/">서재</a><span aria-hidden="true">›</span>
        <span aria-current="page">${escapeHtml(book.title)}</span>
      </nav>
      <header class="book-detail-head">
        <div>
          <p class="eyebrow">${escapeHtml(book.authors.join(', '))}</p>
          <h1>${escapeHtml(book.title)}</h1>
          ${book.subtitle ? `<p>${escapeHtml(book.subtitle)}</p>` : ''}
          ${book.description ? `<p>${escapeHtml(book.description)}</p>` : ''}
        </div>
        ${progressMarkup(bookPercent, '책 전체 진도')}
      </header>
      ${supplementList('before', '책을 읽기 전에')}
      <section aria-labelledby="chapter-list-title">
        <h2 id="chapter-list-title">챕터</h2>
      <ol class="chapter-list">
        ${book.chapters.map((chapter) => {
          const percent = chapterProgressPercent(
            getTargetProgress(state.progress, book.id, 'chapter', chapter.id),
          );
          return `
            <li class="chapter-card">
              <span class="chapter-number">${escapeHtml(String(chapter.number))}</span>
              <div>
                <h3><a href="${routes.chapter(book.id, chapter.id)}">${escapeHtml(chapter.title)}</a></h3>
                ${chapter.description ? `<p>${escapeHtml(chapter.description)}</p>` : ''}
                ${progressMarkup(percent, '챕터 진도')}
              </div>
            </li>`;
        }).join('')}
      </ol>
      </section>
      ${supplementList('after', '책을 읽은 뒤에')}
    </section>`;
}

async function renderContentDetail(
  bookId,
  targetKind,
  targetId,
  version,
  targetBlockId = null,
) {
  const signal = beginView();
  const book = bookById(bookId);
  const summary = targetSummary(book, targetKind, targetId);
  if (!book || !summary) {
    renderError({ code: 'NOT_FOUND' }, '읽을 자료를 찾을 수 없습니다');
    return;
  }
  setPageTitle(summary.title);
  setActiveNav('library');
  document.body.dataset.reader = 'false';
  showLoading('목차를 여는 중');
  try {
    const content = await repository.loadContent(bookId, targetKind, targetId);
    if (version !== renderVersion) return;
    if (targetBlockId) {
      const targetSection = content.sections.find(
        (section) => section.blocks.some((block) => block.id === targetBlockId),
      );
      if (targetSection) {
        history.replaceState(
          null,
          '',
          routes.reader(bookId, targetKind, targetId, targetSection.id, targetBlockId),
        );
        await renderRoute();
        return;
      }
    }
    const targetState = getTargetProgress(
      store.get().progress,
      bookId,
      targetKind,
      targetId,
    );
    const percent = chapterProgressPercent(targetState);
    const recent = store.get().recent;
    const preferredSection = recent?.bookId === bookId
      && recent?.targetKind === targetKind
      && recent?.targetId === targetId
      && content.sections.some((section) => section.id === recent.sectionId)
      ? recent.sectionId
      : content.sections.find((section) => !targetState?.sections?.[section.id]?.complete)?.id
        || content.sections[0].id;

    app.innerHTML = `
      <section class="page-shell narrow-shell">
        <nav class="breadcrumbs" aria-label="현재 위치">
          <a href="#/">서재</a><span aria-hidden="true">›</span>
          <a href="${routes.book(bookId)}">${escapeHtml(book.title)}</a><span aria-hidden="true">›</span>
          <span aria-current="page">${escapeHtml(summary.title)}</span>
        </nav>
        <article class="chapter-summary">
          <p class="eyebrow">${escapeHtml(targetKicker({ ...content, targetKind }))}</p>
          <h1>${escapeHtml(content.title)}</h1>
          ${content.description ? `<p>${escapeHtml(content.description)}</p>` : ''}
          ${progressMarkup(percent, targetKind === 'chapter' ? '챕터 진도' : '자료 진도')}
          <div class="chapter-actions">
            <a class="primary-button" href="${routes.reader(
              bookId,
              targetKind,
              targetId,
              preferredSection,
            )}">
              ${percent > 0 ? '이어 읽기' : '처음부터 읽기'}
            </a>
            <button class="secondary-button" type="button" id="offline-button">오프라인 저장</button>
            <button class="ghost-button" type="button" id="offline-search-button">검색 오프라인 저장</button>
          </div>
          <p class="offline-status" id="offline-status" aria-live="polite"></p>
        </article>
        <h2>이 자료의 절</h2>
        <ol class="section-list">
          ${content.sections.map((section, index) => {
            const sectionState = targetState?.sections?.[section.id];
            const sectionPercent = sectionState?.totalBlocks
              ? Math.round(((sectionState.blockIndex + 1) / sectionState.totalBlocks) * 100)
              : 0;
            return `
              <li>
                <a href="${routes.reader(bookId, targetKind, targetId, section.id)}">
                  <span>${index + 1}. ${escapeHtml(section.title)}</span>
                  <small class="muted">${Math.min(100, Math.max(0, sectionPercent))}%</small>
                </a>
              </li>`;
          }).join('')}
        </ol>
      </section>`;

    const offlineButton = app.querySelector('#offline-button');
    const offlineSearchButton = app.querySelector('#offline-search-button');
    const offlineStatus = app.querySelector('#offline-status');
    const updateOffline = async () => {
      const [contentCached, searchCached] = await Promise.all([
        isBundleCached(summary.bundlePath, repository.catalogSalt),
        isBundleCached(book.searchBundlePath, repository.catalogSalt),
      ]);
      if (signal.aborted) return;
      offlineButton.dataset.cached = String(contentCached);
      offlineSearchButton.dataset.cached = String(searchCached);
      offlineButton.textContent = contentCached ? '이 자료 저장 삭제' : '자료와 검색 함께 저장';
      offlineSearchButton.textContent = searchCached ? '검색 저장 삭제' : '검색만 저장';
      if (contentCached && searchCached) {
        offlineStatus.textContent = '현재 버전의 자료와 이 책 검색색인이 암호문으로 저장되어 있습니다.';
      } else if (contentCached) {
        offlineStatus.textContent = '자료만 저장되어 있습니다. 오프라인 검색은 별도로 저장할 수 있습니다.';
      } else if (searchCached) {
        offlineStatus.textContent = '이 책 검색색인은 유지되어 있습니다. 자료 본문은 저장되지 않았습니다.';
      } else {
        offlineStatus.textContent = '저장 시 현재 자료와 이 책 검색색인을 순서대로 암호화 상태로 저장합니다.';
      }
    };
    await updateOffline();
    offlineButton.addEventListener('click', async () => {
      offlineButton.disabled = true;
      offlineSearchButton.disabled = true;
      try {
        if (offlineButton.dataset.cached === 'true') {
          await removeCachedBundle(summary.bundlePath);
          toast('이 자료의 오프라인 저장을 삭제했습니다. 공용 검색색인은 유지됩니다.');
        } else {
          await repository.cacheOffline([
            {
              path: summary.bundlePath,
              hash: summary.hash,
              bundleId: summary.bundleId,
            },
            {
              path: book.searchBundlePath,
              bundleId: book.searchBundleId,
            },
          ]);
          toast('현재 자료와 이 책 검색색인을 오프라인에 저장했습니다.');
        }
        await updateOffline();
      } catch (error) {
        toast(errorMessage(error));
      } finally {
        offlineButton.disabled = false;
        offlineSearchButton.disabled = false;
      }
    }, { signal });
    offlineSearchButton.addEventListener('click', async () => {
      offlineButton.disabled = true;
      offlineSearchButton.disabled = true;
      try {
        if (offlineSearchButton.dataset.cached === 'true') {
          await removeCachedBundle(book.searchBundlePath);
          toast('이 책의 오프라인 검색색인을 삭제했습니다.');
        } else {
          await repository.cacheOffline([{
            path: book.searchBundlePath,
            bundleId: book.searchBundleId,
          }]);
          toast('이 책의 검색색인을 오프라인에 저장했습니다.');
        }
        await updateOffline();
      } catch (error) {
        toast(errorMessage(error));
      } finally {
        offlineButton.disabled = false;
        offlineSearchButton.disabled = false;
      }
    }, { signal });
  } catch (error) {
    if (version === renderVersion) renderError(error);
  }
}

function makeList(block) {
  const tagName = block.ordered ? 'ol' : 'ul';
  const root = document.createElement(tagName);
  if (block.ordered && Number.isInteger(block.start)) root.start = block.start;
  const stack = [{ list: root, depth: 0, lastItem: null }];
  for (const item of block.items) {
    const targetDepth = Math.min(12, Math.max(0, item.depth));
    while (stack.length - 1 > targetDepth) stack.pop();
    while (stack.length - 1 < targetDepth) {
      const parent = stack.at(-1);
      const nested = document.createElement(tagName);
      const host = parent.lastItem || document.createElement('li');
      if (!parent.lastItem) {
        host.className = 'sr-only';
        parent.list.append(host);
      }
      host.append(nested);
      stack.push({ list: nested, depth: stack.length, lastItem: null });
    }
    const listItem = document.createElement('li');
    listItem.textContent = item.text;
    stack.at(-1).list.append(listItem);
    stack.at(-1).lastItem = listItem;
  }
  return root;
}

function makeTable(block) {
  const wrapper = document.createElement('div');
  wrapper.className = 'table-scroll';
  wrapper.tabIndex = 0;
  wrapper.setAttribute('role', 'region');
  wrapper.setAttribute('aria-label', '가로로 스크롤할 수 있는 표');
  const table = document.createElement('table');
  if (block.head.length) {
    const head = document.createElement('thead');
    const row = document.createElement('tr');
    block.head.forEach((value, index) => {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = String(value ?? '');
      const align = block.align[index];
      if (['left', 'center', 'right'].includes(align)) cell.classList.add(`align-${align}`);
      row.append(cell);
    });
    head.append(row);
    table.append(head);
  }
  const body = document.createElement('tbody');
  for (const values of block.rows) {
    const row = document.createElement('tr');
    values.forEach((value, index) => {
      const cell = document.createElement('td');
      cell.textContent = String(value ?? '');
      const align = block.align[index];
      if (['left', 'center', 'right'].includes(align)) cell.classList.add(`align-${align}`);
      row.append(cell);
    });
    body.append(row);
  }
  table.append(body);
  wrapper.append(table);
  return wrapper;
}

function makeBlockContent(block) {
  if (block.type === 'heading') {
    const level = Math.min(4, Math.max(2, Number(block.level) || 2));
    const heading = document.createElement(`h${level}`);
    heading.textContent = block.text;
    return heading;
  }
  if (block.type === 'paragraph') {
    const paragraph = document.createElement('p');
    paragraph.textContent = block.text;
    return paragraph;
  }
  if (block.type === 'quote') {
    const quote = document.createElement('blockquote');
    const paragraph = document.createElement('p');
    paragraph.textContent = block.text;
    quote.append(paragraph);
    return quote;
  }
  if (block.type === 'code' || block.type === 'math') {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = block.text;
    if (block.type === 'code' && block.language) code.dataset.language = block.language;
    pre.append(code);
    return pre;
  }
  if (block.type === 'footnote') {
    const aside = document.createElement('aside');
    aside.className = 'footnote';
    const label = block.label ? `${block.label} ` : '';
    aside.textContent = `${label}${block.text}`;
    return aside;
  }
  if (block.type === 'figureDescription') {
    const figure = document.createElement('figure');
    const caption = document.createElement('figcaption');
    caption.textContent = block.text;
    figure.append(caption);
    return figure;
  }
  if (block.type === 'list') return makeList(block);
  if (block.type === 'table') return makeTable(block);
  if (block.type === 'sourceAnchor') {
    const marker = document.createElement('small');
    marker.className = 'source-anchor';
    const values = [];
    if (block.pdfPage != null) values.push(`PDF ${block.pdfPage}쪽`);
    if (block.printPage != null) values.push(`인쇄본 ${block.printPage}쪽`);
    marker.textContent = values.join(' · ');
    return marker;
  }
  return document.createElement('hr');
}

function displayEntriesForSection(section) {
  let foldedHeadingIndex = -1;
  for (let index = 0; index < section.blocks.length; index += 1) {
    const block = section.blocks[index];
    if (block.type === 'sourceAnchor' || block.type === 'thematicBreak') continue;
    if (block.type === 'heading'
        && normalizeSearch(block.text) === normalizeSearch(section.title)) {
      foldedHeadingIndex = index;
    }
    break;
  }
  return {
    foldedHeadingId: foldedHeadingIndex >= 0 ? section.blocks[foldedHeadingIndex].id : null,
    entries: section.blocks
      .map((block, index) => ({ block, index }))
      .filter((entry) => entry.index !== foldedHeadingIndex),
  };
}

function addReaderBlocks(container, entries, highlightedBlockId) {
  const fragment = document.createDocumentFragment();
  entries.forEach(({ block, index }) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'content-block';
    wrapper.id = `block-${block.id}`;
    wrapper.tabIndex = -1;
    wrapper.dataset.blockId = block.id;
    wrapper.dataset.blockIndex = String(index);
    if (block.id === highlightedBlockId) wrapper.dataset.highlighted = 'true';
    wrapper.append(makeBlockContent(block));
    fragment.append(wrapper);
  });
  container.replaceChildren(fragment);
}

function updateReaderProgress(progressElement, index, total) {
  const percent = total ? Math.min(100, Math.round(((index + 1) / total) * 100)) : 0;
  const label = progressElement.querySelector('.progress-label span:last-child');
  const track = progressElement.querySelector('progress');
  if (label) label.textContent = `${percent}%`;
  if (track) track.value = percent;
}

async function renderReader(
  bookId,
  targetKind,
  targetId,
  sectionId,
  targetBlockId,
  version,
) {
  const signal = beginView();
  const book = bookById(bookId);
  const summary = targetSummary(book, targetKind, targetId);
  if (!book || !summary) {
    renderError({ code: 'NOT_FOUND' }, '읽을 내용을 찾을 수 없습니다');
    return;
  }
  setActiveNav('');
  document.body.dataset.reader = 'true';
  showLoading('본문을 여는 중');
  try {
    const targetContent = await repository.loadContent(bookId, targetKind, targetId);
    if (version !== renderVersion) return;
    const sectionIndex = targetContent.sections.findIndex((section) => section.id === sectionId);
    if (sectionIndex < 0) {
      renderError({ code: 'NOT_FOUND' }, '절을 찾을 수 없습니다');
      return;
    }
    const section = targetContent.sections[sectionIndex];
    const previousSection = targetContent.sections[sectionIndex - 1] || null;
    const nextSection = targetContent.sections[sectionIndex + 1] || null;
    const orderedTargets = orderedBookTargets(book);
    const targetIndex = orderedTargets.findIndex(
      (item) => item.targetKind === targetKind && item.targetId === targetId,
    );
    const previousTarget = orderedTargets[targetIndex - 1] || null;
    const nextTarget = orderedTargets[targetIndex + 1] || null;
    const saved = getTargetProgress(
      store.get().progress,
      bookId,
      targetKind,
      targetId,
    )?.sections?.[sectionId];
    const initialIndex = Math.max(-1, saved?.blockIndex ?? -1);
    const selectedBlockId = targetBlockId
      && section.blocks.some((block) => block.id === targetBlockId)
      ? targetBlockId
      : null;
    const bookmarkSaved = store.isBookmarked(
      bookId,
      targetKind,
      targetId,
      sectionId,
      selectedBlockId,
    );
    setPageTitle(section.title);
    store.setRecent(bookId, targetKind, targetId, sectionId);

    app.innerHTML = `
      <article class="reader-shell">
        <nav class="breadcrumbs" aria-label="현재 위치">
          <a href="#/">서재</a><span aria-hidden="true">›</span>
          <a href="${routes.book(bookId)}">${escapeHtml(book.title)}</a><span aria-hidden="true">›</span>
          <a href="${targetDetailRoute(bookId, targetKind, targetId)}">${escapeHtml(targetContent.title)}</a>
        </nav>
        <header class="reader-header" id="reader-section-header">
          <p class="reader-kicker">${escapeHtml(targetKicker({
            ...targetContent,
            targetKind,
          }))} · ${sectionIndex + 1}/${targetContent.sections.length}절</p>
          <h1>${escapeHtml(section.title)}</h1>
          <div class="reader-tools">
            <div class="reader-progress">${progressMarkup(
              section.blocks.length
                ? Math.round(((initialIndex + 1) / section.blocks.length) * 100)
                : 0,
              '현재 절 진도',
            )}</div>
            <button class="secondary-button" id="bookmark-button" type="button"
              aria-pressed="${store.isBookmarked(
                bookId,
                targetKind,
                targetId,
                sectionId,
                selectedBlockId,
              )}">
              ${bookmarkSaved ? '★ 저장됨' : '☆ 책갈피'}
            </button>
          </div>
        </header>
        <div class="reader-content" id="reader-content"></div>
        <footer class="reader-footer">
          <nav class="reader-footer-nav" aria-label="본문 이동">
            ${previousSection ? `
              <a href="${routes.reader(bookId, targetKind, targetId, previousSection.id)}">
                <small>← 이전 절</small><strong>${escapeHtml(previousSection.title)}</strong>
              </a>
            ` : previousTarget ? `
              <a href="${targetDetailRoute(bookId, previousTarget.targetKind, previousTarget.targetId)}">
                <small>← 이전 ${previousTarget.targetKind === 'chapter' ? '챕터' : '자료'}</small>
                <strong>${escapeHtml(previousTarget.title)}</strong>
              </a>
            ` : '<span></span>'}
            ${nextSection ? `
              <a href="${routes.reader(bookId, targetKind, targetId, nextSection.id)}">
                <small>다음 절 →</small><strong>${escapeHtml(nextSection.title)}</strong>
              </a>
            ` : nextTarget ? `
              <a href="${targetDetailRoute(bookId, nextTarget.targetKind, nextTarget.targetId)}">
                <small>다음 ${nextTarget.targetKind === 'chapter' ? '챕터' : '자료'} →</small>
                <strong>${escapeHtml(nextTarget.title)}</strong>
              </a>
            ` : `
              <a href="${routes.book(bookId)}">
                <small>책 읽기 완료</small><strong>챕터 목록으로 →</strong>
              </a>`}
          </nav>
        </footer>
      </article>`;

    const content = app.querySelector('#reader-content');
    const progressElement = app.querySelector('.reader-progress');
    const bookmarkButton = app.querySelector('#bookmark-button');
    const { entries, foldedHeadingId } = displayEntriesForSection(section);
    const foldedHeadingSelected = selectedBlockId === foldedHeadingId;
    const readerHeader = app.querySelector('#reader-section-header');
    if (foldedHeadingSelected) {
      readerHeader.dataset.highlighted = 'true';
      readerHeader.tabIndex = -1;
    }
    addReaderBlocks(content, entries, selectedBlockId);

    bookmarkButton.addEventListener('click', () => {
      const added = store.toggleBookmark({
        bookId,
        targetKind,
        targetId,
        sectionId,
        blockId: selectedBlockId,
        createdAt: Date.now(),
      });
      bookmarkButton.textContent = added ? '★ 저장됨' : '☆ 책갈피';
      bookmarkButton.setAttribute('aria-pressed', String(added));
      toast(added ? '책갈피에 저장했습니다.' : '책갈피를 삭제했습니다.');
    }, { signal });

    let highestIndex = initialIndex;
    const blocks = [...content.querySelectorAll('.content-block')];
    const recordProgress = (index) => {
      if (index <= highestIndex) return;
      highestIndex = index;
      store.setSectionProgress(
        bookId,
        targetKind,
        targetId,
        sectionId,
        highestIndex,
        section.blocks.length,
        targetContent.sections.length,
      );
      updateReaderProgress(progressElement, highestIndex, section.blocks.length);
    };

    if (blocks.length) {
      let progressFrame = 0;
      const evaluateProgress = () => {
        progressFrame = 0;
        const items = blocks.map((block) => ({
          index: Number(block.dataset.blockIndex),
          rect: block.getBoundingClientRect(),
        }));
        const pageAtEnd = window.scrollY + window.innerHeight
          >= document.documentElement.scrollHeight - 4;
        recordProgress(progressIndexAtViewport(items, window.innerHeight, pageAtEnd));
      };
      const scheduleProgress = () => {
        if (!progressFrame) progressFrame = window.requestAnimationFrame(evaluateProgress);
      };
      window.addEventListener('scroll', scheduleProgress, { passive: true, signal });
      window.addEventListener('resize', scheduleProgress, { passive: true, signal });
      signal.addEventListener('abort', () => window.cancelAnimationFrame(progressFrame), { once: true });
      scheduleProgress();
    } else if (section.blocks.length) {
      // A title-only section is represented by the reader heading itself.
      recordProgress(section.blocks.length - 1);
    }

    window.requestAnimationFrame(() => {
      const target = foldedHeadingSelected
        ? readerHeader
        : selectedBlockId
          ? document.querySelector(`#block-${CSS.escape(selectedBlockId)}`)
          : initialIndex > 0
            ? blocks.find((block) => Number(block.dataset.blockIndex) >= initialIndex)
            : null;
      target?.scrollIntoView({ block: 'start' });
      target?.focus?.({ preventScroll: true });
    });
  } catch (error) {
    if (version === renderVersion) renderError(error);
  }
}

function normalizeSearch(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/\s+/gu, ' ').trim();
}

function searchSnippet(text, query) {
  const source = String(text || '').replace(/\s+/gu, ' ').trim();
  const lower = source.toLocaleLowerCase('ko-KR');
  const needle = query.toLocaleLowerCase('ko-KR');
  const matchIndex = lower.indexOf(needle);
  const start = Math.max(0, (matchIndex < 0 ? 0 : matchIndex) - 65);
  const end = Math.min(source.length, (matchIndex < 0 ? 0 : matchIndex) + needle.length + 105);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < source.length ? '…' : '';
  if (matchIndex < 0) return `${escapeHtml(prefix)}${escapeHtml(source.slice(start, end))}${escapeHtml(suffix)}`;
  return `${escapeHtml(prefix)}${escapeHtml(source.slice(start, matchIndex))}`
    + `<mark>${escapeHtml(source.slice(matchIndex, matchIndex + needle.length))}</mark>`
    + `${escapeHtml(source.slice(matchIndex + needle.length, end))}${escapeHtml(suffix)}`;
}

async function renderSearch(queryValue, selectedBookId, version) {
  const signal = beginView();
  const catalog = repository.catalog;
  const query = String(queryValue || '').slice(0, 120);
  const normalizedQuery = normalizeSearch(query);
  const validBookId = catalog.books.some((book) => book.id === selectedBookId)
    ? selectedBookId
    : '';
  setPageTitle('검색');
  setActiveNav('search');
  document.body.dataset.reader = 'false';
  app.innerHTML = `
    <section class="page-shell narrow-shell">
      <header class="page-heading">
        <p class="eyebrow">Search</p>
        <h1>책에서 찾기</h1>
        <p>검색어는 서버로 전송되지 않지만 주소의 # 뒤와 브라우저 방문 기록에 남을 수 있습니다.</p>
      </header>
      <form class="search-form" id="search-form" role="search">
        <div class="search-field">
          <label class="sr-only" for="search-query">검색어</label>
          <input id="search-query" type="search" value="${escapeHtml(query)}"
            placeholder="두 글자 이상 입력" autocomplete="off" maxlength="120">
          <button class="icon-button" id="clear-search" type="button" aria-label="검색어 지우기">×</button>
        </div>
        <button class="primary-button" type="submit">검색</button>
      </form>
      <div class="filter-chips" aria-label="검색할 책">
        <button type="button" data-book-filter="" aria-pressed="${String(!validBookId)}">전체</button>
        ${catalog.books.map((book) => `
          <button type="button" data-book-filter="${escapeHtml(book.id)}"
            aria-pressed="${String(book.id === validBookId)}">${escapeHtml(book.title)}</button>
        `).join('')}
      </div>
      <div id="search-status" role="status" aria-live="polite"></div>
      <ol class="search-results" id="search-results"></ol>
    </section>`;

  const form = app.querySelector('#search-form');
  const input = app.querySelector('#search-query');
  const resultsElement = app.querySelector('#search-results');
  const statusElement = app.querySelector('#search-status');

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    location.hash = routes.search(input.value.trim(), validBookId);
  }, { signal });
  app.querySelector('#clear-search').addEventListener('click', () => {
    input.value = '';
    input.focus();
  }, { signal });
  for (const button of app.querySelectorAll('[data-book-filter]')) {
    button.addEventListener('click', () => {
      location.hash = routes.search(input.value.trim(), button.dataset.bookFilter);
    }, { signal });
  }

  if (normalizedQuery.length < 2) {
    statusElement.innerHTML = '<p class="muted">찾고 싶은 용어를 두 글자 이상 입력하세요.</p>';
    window.requestAnimationFrame(() => input.focus());
    return;
  }

  statusElement.innerHTML = '<p class="muted">암호화된 검색 색인을 여는 중…</p>';
  try {
    const books = validBookId ? [bookById(validBookId)] : catalog.books;
    const bundles = await Promise.all(books.map((book) => repository.loadSearch(book.id)));
    if (version !== renderVersion) return;
    const matches = [];
    bundles.forEach((bundle, bundleIndex) => {
      const book = books[bundleIndex];
      for (const document of bundle.documents) {
        const normalizedText = normalizeSearch(document.text);
        const position = normalizedText.indexOf(normalizedQuery);
        if (position < 0) continue;
        const target = targetSummary(book, document.targetKind, document.targetId);
        matches.push({
          ...document,
          book,
          target,
          score: position + Math.max(0, normalizedText.length - normalizedQuery.length) / 10_000,
        });
        if (matches.length >= 2_000) break;
      }
    });
    matches.sort((left, right) => left.score - right.score);
    const visible = matches.slice(0, 100);
    statusElement.innerHTML = `<p class="muted">${matches.length > 100 ? '100개 이상' : matches.length}의 결과</p>`;
    resultsElement.innerHTML = visible.map((result) => `
      <li class="search-result">
        <a href="${result.sectionId
          ? routes.reader(
              result.book.id,
              result.targetKind,
              result.targetId,
              result.sectionId,
              result.blockId,
            )
          : targetDetailRoute(
              result.book.id,
              result.targetKind,
              result.targetId,
              result.blockId,
            )}">
          <strong>${escapeHtml(result.target?.title || result.targetId)}</strong>
          <small>${escapeHtml(result.book.title)} · ${escapeHtml(result.sectionTitle || result.sectionId)}</small>
          <p>${searchSnippet(result.text, query)}</p>
        </a>
      </li>`).join('');
    if (!visible.length) {
      resultsElement.innerHTML = `
        <li class="empty-state">
          <h2>검색 결과가 없습니다</h2>
          <p>띄어쓰기나 다른 표현으로 다시 찾아보세요.</p>
        </li>`;
    }
  } catch (error) {
    if (version !== renderVersion) return;
    statusElement.innerHTML = `<p class="form-error">${escapeHtml(errorMessage(error))}</p>`;
  }
}

async function renderBookmarks(version) {
  const signal = beginView();
  const bookmarks = [...store.get().bookmarks].sort((a, b) => b.createdAt - a.createdAt);
  setPageTitle('책갈피');
  setActiveNav('bookmarks');
  document.body.dataset.reader = 'false';
  app.innerHTML = `
    <section class="page-shell narrow-shell">
      <header class="page-heading">
        <p class="eyebrow">Bookmarks</p>
        <h1>책갈피</h1>
        <p>본문 대신 위치 ID만 이 기기에 저장됩니다.</p>
      </header>
      <div id="bookmark-content">
        ${bookmarks.length ? '<div class="loading"><span>책갈피 위치를 확인하는 중…</span></div>' : `
          <div class="empty-state">
            <h2>저장한 책갈피가 없습니다</h2>
            <p>본문 상단의 ‘책갈피’ 버튼으로 다시 읽을 절을 표시할 수 있습니다.</p>
            <a class="primary-button" href="#/">서재로 이동</a>
          </div>`}
      </div>
    </section>`;
  if (!bookmarks.length) return;

  const uniqueTargets = [...new Set(
    bookmarks.map((item) => `${item.bookId}/${item.targetKind}/${item.targetId}`),
  )];
  const targetEntries = await Promise.all(uniqueTargets.map(async (key) => {
    const [bookId, targetKind, targetId] = key.split('/');
    try {
      return [key, await repository.loadContent(bookId, targetKind, targetId)];
    } catch {
      return [key, null];
    }
  }));
  if (version !== renderVersion) return;
  const targets = new Map(targetEntries);
  const container = app.querySelector('#bookmark-content');
  container.innerHTML = `
    <ol class="bookmark-list">
      ${bookmarks.map((bookmark, index) => {
        const book = bookById(bookmark.bookId);
        const target = targets.get(
          `${bookmark.bookId}/${bookmark.targetKind}/${bookmark.targetId}`,
        );
        const section = target?.sections.find((item) => item.id === bookmark.sectionId);
        return `
          <li class="bookmark-item">
            <a href="${routes.reader(
              bookmark.bookId,
              bookmark.targetKind,
              bookmark.targetId,
              bookmark.sectionId,
              bookmark.blockId,
            )}">
              <strong>${escapeHtml(section?.title || bookmark.sectionId)}</strong>
              <small>${escapeHtml(book?.title || bookmark.bookId)} · ${escapeHtml(
                target?.title || bookmark.targetId,
              )}</small>
            </a>
            <button class="icon-button" type="button" data-remove-bookmark="${index}"
              aria-label="${escapeHtml(section?.title || '책갈피')} 삭제">×</button>
          </li>`;
      }).join('')}
    </ol>`;
  for (const button of container.querySelectorAll('[data-remove-bookmark]')) {
    button.addEventListener('click', () => {
      const bookmark = bookmarks[Number(button.dataset.removeBookmark)];
      store.toggleBookmark(bookmark);
      toast('책갈피를 삭제했습니다.');
      renderBookmarks(++renderVersion);
    }, { signal });
  }
}

function renderNotFound() {
  const signal = beginView();
  setPageTitle('페이지 없음');
  setActiveNav('');
  document.body.dataset.reader = 'false';
  app.innerHTML = `
    <section class="page-shell narrow-shell">
      <div class="empty-state">
        <h1>페이지를 찾을 수 없습니다</h1>
        <p>주소가 올바른지 확인하거나 서재에서 다시 시작하세요.</p>
        <a class="primary-button" href="#/">서재로 이동</a>
      </div>
    </section>`;
  app.querySelector('a')?.addEventListener('click', () => {}, { signal });
}

async function renderRoute() {
  if (!repository.unlocked) {
    renderUnlock();
    return;
  }
  const version = ++renderVersion;
  const route = parseHash();
  setUnlockedChrome(true);
  window.scrollTo({ top: 0, behavior: 'auto' });
  if (route.name === 'library') renderLibrary();
  else if (route.name === 'book') renderBook(route.params.bookId);
  else if (route.name === 'chapter') {
    await renderContentDetail(
      route.params.bookId,
      'chapter',
      route.params.chapterId,
      version,
      route.query.block,
    );
  } else if (route.name === 'supplement') {
    await renderContentDetail(
      route.params.bookId,
      'supplement',
      route.params.supplementId,
      version,
      route.query.block,
    );
  } else if (route.name === 'reader') {
    await renderReader(
      route.params.bookId,
      route.params.targetKind,
      route.params.targetId,
      route.params.sectionId,
      route.params.blockId || route.query.block,
      version,
    );
  } else if (route.name === 'search') {
    await renderSearch(route.query.q, route.query.book, version);
  } else if (route.name === 'bookmarks') {
    await renderBookmarks(version);
  } else renderNotFound();

  const routeFocusKey = `${route.name}:${JSON.stringify(route.params)}`;
  const hasBlockTarget = route.name === 'reader'
    && Boolean(route.params.blockId || route.query.block);
  if (version === renderVersion && routeFocusKey !== lastFocusedRoute && !hasBlockTarget) {
    lastFocusedRoute = routeFocusKey;
    window.requestAnimationFrame(() => {
      const heading = app.querySelector('h1');
      const focusTarget = heading || app;
      focusTarget.tabIndex = -1;
      focusTarget.focus({ preventScroll: true });
    });
  }
}

function lock({ broadcast = true } = {}) {
  renderVersion += 1;
  beginView();
  repository.lock();
  app.replaceChildren();
  if (broadcast) lockChannel?.postMessage({ type: 'lock' });
  if (location.hash !== routes.library()) history.replaceState(null, '', routes.library());
  renderUnlock();
}

lockButton.addEventListener('click', () => lock());
searchButton.addEventListener('click', () => {
  location.hash = routes.search();
});
settingsButton.addEventListener('click', () => settingsDialog.showModal());
settingsDialog.addEventListener('click', (event) => {
  if (event.target === settingsDialog) settingsDialog.close();
});

for (const button of document.querySelectorAll('[data-theme-value]')) {
  button.addEventListener('click', () => {
    store.setSettings({ theme: button.dataset.themeValue });
    applySettings();
  });
}
for (const button of document.querySelectorAll('[data-font-size]')) {
  button.addEventListener('click', () => {
    store.setSettings({ fontSize: button.dataset.fontSize });
    applySettings();
  });
}

window.addEventListener('hashchange', renderRoute);
lockChannel?.addEventListener('message', (event) => {
  if (event.data?.type === 'lock' && repository.unlocked) lock({ broadcast: false });
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenAt = Date.now();
  } else if (hiddenAt && Date.now() - hiddenAt > 30 * 60 * 1_000 && repository.unlocked) {
    lock();
    toast('30분 동안 자리를 비워 서재를 잠갔습니다.');
  }
  if (!document.hidden) hiddenAt = null;
});

window.addEventListener('pageshow', (event) => {
  if (event.persisted && repository.unlocked) lock();
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  let reloadingForServiceWorker = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadingForServiceWorker) return;
    reloadingForServiceWorker = true;
    window.location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
      // Online reading continues if service-worker registration is unavailable.
    });
  });
}

applySettings();
renderUnlock();
