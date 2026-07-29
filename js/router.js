const SAFE_SEGMENT = /^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,159}$/u;

function cleanSegment(value) {
  if (typeof value !== 'string' || !SAFE_SEGMENT.test(value)) return null;
  return value;
}

function readSearchParams(value = '') {
  const params = new URLSearchParams(value);
  const result = {};
  for (const key of ['q', 'book', 'block']) {
    const item = params.get(key);
    if (item != null) result[key] = item.slice(0, key === 'q' ? 120 : 160);
  }
  return result;
}

export function parseHash(input = globalThis.location?.hash || '#/') {
  const raw = input.startsWith('#') ? input.slice(1) : input;
  const [rawPath = '/', rawQuery = ''] = raw.split('?', 2);
  let parts;
  try {
    parts = rawPath.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    return { name: 'notFound', params: {}, query: {} };
  }
  const query = readSearchParams(rawQuery);
  if (parts.length === 0) return { name: 'library', params: {}, query };
  if (parts.length === 1 && parts[0] === 'search') return { name: 'search', params: {}, query };
  if (parts.length === 1 && parts[0] === 'bookmarks') return { name: 'bookmarks', params: {}, query };
  if (parts.length === 2 && parts[0] === 'book') {
    const bookId = cleanSegment(parts[1]);
    return bookId
      ? { name: 'book', params: { bookId }, query }
      : { name: 'notFound', params: {}, query };
  }
  if (parts.length === 4 && parts[0] === 'book' && parts[2] === 'chapter') {
    const bookId = cleanSegment(parts[1]);
    const chapterId = cleanSegment(parts[3]);
    return bookId && chapterId
      ? { name: 'chapter', params: { bookId, chapterId }, query }
      : { name: 'notFound', params: {}, query };
  }
  if (parts.length === 4 && parts[0] === 'book' && parts[2] === 'supplement') {
    const bookId = cleanSegment(parts[1]);
    const supplementId = cleanSegment(parts[3]);
    return bookId && supplementId
      ? { name: 'supplement', params: { bookId, supplementId }, query }
      : { name: 'notFound', params: {}, query };
  }
  if ((parts.length === 5 || parts.length === 6)
      && parts[0] === 'read'
      && ['chapter', 'supplement'].includes(parts[2])) {
    const bookId = cleanSegment(parts[1]);
    const targetKind = parts[2];
    const targetId = cleanSegment(parts[3]);
    const sectionId = cleanSegment(parts[4]);
    const blockId = parts[5] == null ? null : cleanSegment(parts[5]);
    return bookId && targetId && sectionId && (parts[5] == null || blockId)
      ? {
          name: 'reader',
          params: { bookId, targetKind, targetId, sectionId, blockId },
          query,
        }
      : { name: 'notFound', params: {}, query };
  }
  // Existing chapter deep links remain valid after the route gained targetKind.
  if ((parts.length === 4 || parts.length === 5) && parts[0] === 'read') {
    const bookId = cleanSegment(parts[1]);
    const targetId = cleanSegment(parts[2]);
    const sectionId = cleanSegment(parts[3]);
    const blockId = parts[4] == null ? null : cleanSegment(parts[4]);
    return bookId && targetId && sectionId && (parts[4] == null || blockId)
      ? {
          name: 'reader',
          params: { bookId, targetKind: 'chapter', targetId, sectionId, blockId },
          query,
        }
      : { name: 'notFound', params: {}, query };
  }
  return { name: 'notFound', params: {}, query };
}

const encode = (value) => encodeURIComponent(value);

export const routes = {
  library: () => '#/',
  book: (bookId) => `#/book/${encode(bookId)}`,
  chapter: (bookId, chapterId, blockId = null) => {
    const base = `#/book/${encode(bookId)}/chapter/${encode(chapterId)}`;
    return blockId ? `${base}?block=${encode(blockId)}` : base;
  },
  supplement: (bookId, supplementId, blockId = null) => {
    const base = `#/book/${encode(bookId)}/supplement/${encode(supplementId)}`;
    return blockId ? `${base}?block=${encode(blockId)}` : base;
  },
  target: (bookId, targetKind, targetId, blockId = null) => (
    targetKind === 'supplement'
      ? routes.supplement(bookId, targetId, blockId)
      : routes.chapter(bookId, targetId, blockId)
  ),
  reader: (bookId, targetKind, targetId, sectionId, blockId = null) => {
    const base = `#/read/${encode(bookId)}/${encode(targetKind)}/${encode(targetId)}/${encode(sectionId)}`;
    return blockId ? `${base}/${encode(blockId)}` : base;
  },
  search: (query = '', bookId = '') => {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (bookId) params.set('book', bookId);
    const suffix = params.toString();
    return `#/search${suffix ? `?${suffix}` : ''}`;
  },
  bookmarks: () => '#/bookmarks',
};
