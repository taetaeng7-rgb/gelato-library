const ALLOWED_ELEMENTS = new Set([
  'A', 'BLOCKQUOTE', 'BR', 'CODE', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'EM',
  'FIGCAPTION', 'FIGURE', 'H2', 'H3', 'H4', 'HR', 'IMG', 'LI', 'OL', 'P',
  'PRE', 'S', 'SMALL', 'STRONG', 'SUB', 'SUMMARY', 'SUP', 'TABLE', 'TBODY',
  'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'U', 'UL',
]);
const DROP_CONTENT_ELEMENTS = new Set(['IFRAME', 'OBJECT', 'SCRIPT', 'STYLE', 'SVG', 'TEMPLATE']);
const GLOBAL_ATTRIBUTES = new Set(['class', 'id', 'lang', 'title']);
const ELEMENT_ATTRIBUTES = {
  A: new Set(['href']),
  IMG: new Set(['alt', 'height', 'loading', 'src', 'width']),
  OL: new Set(['start']),
  TD: new Set(['colspan', 'rowspan']),
  TH: new Set(['colspan', 'rowspan', 'scope']),
};
const SAFE_ID = /^[a-zA-Z][a-zA-Z0-9._:-]{0,159}$/u;

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeAssetUrl(value, kind) {
  if (typeof value !== 'string' || value.length > 500) return null;
  if (kind === 'A' && value.startsWith('#') && SAFE_ID.test(value.slice(1))) return value;
  try {
    const url = new URL(value, globalThis.location?.href || 'https://local.invalid/');
    const origin = globalThis.location?.origin || 'https://local.invalid';
    if (url.origin !== origin) return null;
    if (kind === 'IMG' && !/\.(?:avif|gif|jpe?g|png|svg|webp)$/iu.test(url.pathname)) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function sanitizeNode(source, targetDocument) {
  if (source.nodeType === 3) return targetDocument.createTextNode(source.textContent || '');
  if (source.nodeType !== 1) return null;
  if (DROP_CONTENT_ELEMENTS.has(source.tagName)) return null;

  if (!ALLOWED_ELEMENTS.has(source.tagName)) {
    const fragment = targetDocument.createDocumentFragment();
    for (const child of source.childNodes) {
      const safeChild = sanitizeNode(child, targetDocument);
      if (safeChild) fragment.append(safeChild);
    }
    return fragment;
  }

  const element = targetDocument.createElement(source.tagName.toLowerCase());
  const allowed = ELEMENT_ATTRIBUTES[source.tagName] || new Set();
  for (const attribute of source.attributes) {
    const name = attribute.name.toLowerCase();
    if (!GLOBAL_ATTRIBUTES.has(name) && !allowed.has(name)) continue;
    if (name === 'id') {
      if (SAFE_ID.test(attribute.value)) element.id = attribute.value;
      continue;
    }
    if (name === 'class') {
      const classes = attribute.value
        .split(/\s+/u)
        .filter((item) => /^(?:align-|figure-|note|table-|language-)[a-z0-9_-]+$/iu.test(item));
      if (classes.length) element.className = classes.join(' ');
      continue;
    }
    if (name === 'href' || name === 'src') {
      const safeUrl = safeAssetUrl(attribute.value, source.tagName);
      if (safeUrl) element.setAttribute(name, safeUrl);
      continue;
    }
    if (name === 'loading') {
      element.setAttribute(name, 'lazy');
      continue;
    }
    if (['colspan', 'rowspan', 'start', 'width', 'height'].includes(name)) {
      const number = Number.parseInt(attribute.value, 10);
      if (Number.isInteger(number) && number > 0 && number <= 10_000) {
        element.setAttribute(name, String(number));
      }
      continue;
    }
    element.setAttribute(name, attribute.value.slice(0, 200));
  }
  if (source.tagName === 'IMG') {
    element.loading = 'lazy';
    element.decoding = 'async';
  }
  for (const child of source.childNodes) {
    const safeChild = sanitizeNode(child, targetDocument);
    if (safeChild) element.append(safeChild);
  }
  return element;
}

export function sanitizedFragment(html, targetDocument = globalThis.document) {
  const parser = new DOMParser();
  const parsed = parser.parseFromString(String(html || ''), 'text/html');
  const fragment = targetDocument.createDocumentFragment();
  for (const child of parsed.body.childNodes) {
    const safeChild = sanitizeNode(child, targetDocument);
    if (safeChild) fragment.append(safeChild);
  }
  return fragment;
}

export function wrapWideTables(container) {
  for (const table of container.querySelectorAll('table')) {
    if (table.parentElement?.classList.contains('table-scroll')) continue;
    const wrapper = document.createElement('div');
    wrapper.className = 'table-scroll';
    wrapper.tabIndex = 0;
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute('aria-label', '가로로 스크롤할 수 있는 표');
    table.before(wrapper);
    wrapper.append(table);
  }
}
