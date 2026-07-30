const STORAGE_KEY = 'gelato.library.state.v1';
const ALLOWED_THEMES = new Set(['light', 'sepia', 'dark']);
const ALLOWED_FONT_SIZES = new Set(['small', 'medium', 'large', 'xlarge']);

const defaultState = () => ({
  settings: {
    theme: 'light',
    fontSize: 'medium',
  },
  progress: {},
  bookmarks: [],
  recent: null,
});

function cleanId(value) {
  return typeof value === 'string' && /^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,159}$/u.test(value)
    ? value
    : null;
}

function cleanTargetKind(value) {
  return value === 'chapter' || value === 'supplement' ? value : null;
}

export function targetProgressKey(targetKind, targetId) {
  const kind = cleanTargetKind(targetKind);
  const id = cleanId(targetId);
  return kind && id ? `${kind}:${id}` : null;
}

function sanitizeProgress(progress) {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) return {};
  const result = {};
  for (const [bookId, targets] of Object.entries(progress)) {
    if (!cleanId(bookId) || !targets || typeof targets !== 'object') continue;
    result[bookId] = {};
    for (const [rawTargetKey, target] of Object.entries(targets)) {
      const separator = rawTargetKey.indexOf(':');
      const possibleKind = separator > 0 ? rawTargetKey.slice(0, separator) : 'chapter';
      const possibleId = separator > 0 ? rawTargetKey.slice(separator + 1) : rawTargetKey;
      const targetKey = targetProgressKey(possibleKind, possibleId);
      if (!targetKey || !target || typeof target !== 'object') continue;
      const sections = {};
      for (const [sectionId, section] of Object.entries(target.sections || {})) {
        if (!cleanId(sectionId) || !section || typeof section !== 'object') continue;
        const blockIndex = Number.isInteger(section.blockIndex) ? Math.max(-1, section.blockIndex) : -1;
        const totalBlocks = Number.isInteger(section.totalBlocks) ? Math.max(0, section.totalBlocks) : 0;
        sections[sectionId] = {
          blockIndex: Math.min(blockIndex, Math.max(-1, totalBlocks - 1)),
          totalBlocks,
          complete: Boolean(section.complete),
        };
      }
      result[bookId][targetKey] = {
        sections,
        totalSections: Number.isInteger(target.totalSections) ? Math.max(0, target.totalSections) : 0,
      };
    }
  }
  return result;
}

function sanitizeBookmarks(bookmarks) {
  if (!Array.isArray(bookmarks)) return [];
  const unique = new Map();
  for (const item of bookmarks.slice(-500)) {
    const bookId = cleanId(item?.bookId);
    const targetKind = cleanTargetKind(item?.targetKind || (item?.chapterId ? 'chapter' : null));
    const targetId = cleanId(item?.targetId || item?.chapterId);
    const sectionId = cleanId(item?.sectionId);
    const blockId = item?.blockId == null ? null : cleanId(item.blockId);
    if (!bookId || !targetKind || !targetId || !sectionId) continue;
    const key = `${bookId}/${targetKind}/${targetId}/${sectionId}/${blockId || ''}`;
    unique.set(key, {
      bookId,
      targetKind,
      targetId,
      sectionId,
      blockId,
      createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
    });
  }
  return [...unique.values()];
}

function sanitizeRecent(recent) {
  if (!recent || typeof recent !== 'object') return null;
  const bookId = cleanId(recent.bookId);
  const targetKind = cleanTargetKind(recent.targetKind || (recent.chapterId ? 'chapter' : null));
  const targetId = cleanId(recent.targetId || recent.chapterId);
  const sectionId = cleanId(recent.sectionId);
  if (!bookId || !targetKind || !targetId || !sectionId) return null;
  return { bookId, targetKind, targetId, sectionId };
}

export function sanitizeState(value) {
  const clean = defaultState();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return clean;
  if (ALLOWED_THEMES.has(value.settings?.theme)) clean.settings.theme = value.settings.theme;
  if (ALLOWED_FONT_SIZES.has(value.settings?.fontSize)) {
    clean.settings.fontSize = value.settings.fontSize;
  }
  clean.progress = sanitizeProgress(value.progress);
  clean.bookmarks = sanitizeBookmarks(value.bookmarks);
  clean.recent = sanitizeRecent(value.recent);
  return clean;
}

export function createStore(storage = globalThis.localStorage) {
  let state = defaultState();
  try {
    state = sanitizeState(JSON.parse(storage?.getItem(STORAGE_KEY) || 'null'));
  } catch {
    state = defaultState();
  }

  const listeners = new Set();

  const save = () => {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Reading must continue when storage is blocked or full.
    }
    for (const listener of listeners) listener(state);
  };

  return {
    get() {
      return state;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    setSettings(patch) {
      const settings = { ...state.settings };
      if (ALLOWED_THEMES.has(patch.theme)) settings.theme = patch.theme;
      if (ALLOWED_FONT_SIZES.has(patch.fontSize)) settings.fontSize = patch.fontSize;
      state = { ...state, settings };
      save();
    },

    setRecent(bookId, targetKind, targetId, sectionId) {
      const recent = sanitizeRecent({ bookId, targetKind, targetId, sectionId });
      if (!recent) return;
      state = { ...state, recent };
      save();
    },

    setSectionProgress(
      bookId,
      targetKind,
      targetId,
      sectionId,
      blockIndex,
      totalBlocks,
      totalSections,
    ) {
      const targetKey = targetProgressKey(targetKind, targetId);
      if (!cleanId(bookId) || !targetKey || !cleanId(sectionId)) return;
      const safeTotal = Number.isInteger(totalBlocks) ? Math.max(0, totalBlocks) : 0;
      const safeIndex = Number.isInteger(blockIndex)
        ? Math.min(Math.max(-1, blockIndex), Math.max(-1, safeTotal - 1))
        : -1;
      const oldTarget = state.progress[bookId]?.[targetKey] || { sections: {}, totalSections: 0 };
      const oldSection = oldTarget.sections?.[sectionId] || { blockIndex: -1 };
      const nextIndex = Math.max(oldSection.blockIndex ?? -1, safeIndex);
      const nextProgress = {
        ...state.progress,
        [bookId]: {
          ...(state.progress[bookId] || {}),
          [targetKey]: {
            ...oldTarget,
            totalSections: Number.isInteger(totalSections)
              ? Math.max(oldTarget.totalSections || 0, totalSections)
              : oldTarget.totalSections || 0,
            sections: {
              ...(oldTarget.sections || {}),
              [sectionId]: {
                blockIndex: nextIndex,
                totalBlocks: safeTotal,
                complete: safeTotal > 0 && nextIndex >= safeTotal - 1,
              },
            },
          },
        },
      };
      state = { ...state, progress: nextProgress };
      save();
    },

    reconcileReaderSections(
      bookId,
      targetKind,
      targetId,
      sections,
    ) {
      const targetKey = targetProgressKey(targetKind, targetId);
      if (!cleanId(bookId) || !targetKey || !Array.isArray(sections)) return;
      const current = sections
        .map((section) => ({
          id: cleanId(section?.id),
          totalBlocks: Number.isInteger(section?.totalBlocks)
            ? Math.max(0, section.totalBlocks)
            : 0,
        }))
        .filter((section) => section.id && section.totalBlocks > 0);
      if (current.length === 0 || new Set(current.map((section) => section.id)).size !== current.length) {
        return;
      }

      const oldTarget = state.progress[bookId]?.[targetKey]
        || { sections: {}, totalSections: 0 };
      const nextSections = {};
      for (const section of current) {
        const oldSection = oldTarget.sections?.[section.id];
        if (!oldSection) continue;
        const blockIndex = Math.min(
          Math.max(-1, oldSection.blockIndex ?? -1),
          section.totalBlocks - 1,
        );
        nextSections[section.id] = {
          blockIndex,
          totalBlocks: section.totalBlocks,
          complete: blockIndex >= section.totalBlocks - 1,
        };
      }
      state = {
        ...state,
        progress: {
          ...state.progress,
          [bookId]: {
            ...(state.progress[bookId] || {}),
            [targetKey]: {
              ...oldTarget,
              totalSections: current.length,
              sections: nextSections,
            },
          },
        },
      };
      save();
    },

    toggleBookmark(bookmark) {
      const clean = sanitizeBookmarks([bookmark])[0];
      if (!clean) return false;
      const matches = (item) => item.bookId === clean.bookId
        && item.targetKind === clean.targetKind
        && item.targetId === clean.targetId
        && item.sectionId === clean.sectionId
        && (item.blockId || null) === (clean.blockId || null);
      const exists = state.bookmarks.some(matches);
      state = {
        ...state,
        bookmarks: exists
          ? state.bookmarks.filter((item) => !matches(item))
          : [...state.bookmarks, clean],
      };
      save();
      return !exists;
    },

    isBookmarked(bookId, targetKind, targetId, sectionId, blockId = null) {
      return state.bookmarks.some((item) => item.bookId === bookId
        && item.targetKind === targetKind
        && item.targetId === targetId
        && item.sectionId === sectionId
        && (item.blockId || null) === blockId);
    },
  };
}

export function chapterProgressPercent(chapterState) {
  if (!chapterState?.sections) return 0;
  const sections = Object.values(chapterState.sections);
  const denominator = Math.max(chapterState.totalSections || 0, sections.length);
  if (denominator === 0) return 0;
  const completed = sections.reduce((sum, section) => {
    if (section.complete) return sum + 1;
    if (!section.totalBlocks) return sum;
    return sum + Math.max(0, section.blockIndex + 1) / section.totalBlocks;
  }, 0);
  return Math.min(100, Math.round((completed / denominator) * 100));
}

export function getTargetProgress(progress, bookId, targetKind, targetId) {
  const key = targetProgressKey(targetKind, targetId);
  if (!key) return null;
  return progress?.[bookId]?.[key] || null;
}

export function bookProgressPercent(bookId, chapters, progress) {
  if (!Array.isArray(chapters) || chapters.length === 0) return 0;
  const total = chapters.reduce(
    (sum, chapter) => sum + chapterProgressPercent(
      getTargetProgress(progress, bookId, 'chapter', chapter.id),
    ),
    0,
  );
  return Math.round(total / chapters.length);
}
