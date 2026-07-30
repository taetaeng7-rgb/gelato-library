const BLOCKED_KEY_TARGETS = [
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="link"]',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '.table-scroll',
  'pre',
].join(', ');

function nonNegativeNumber(value) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function readerKeyDirection(
  event,
  { dialogOpen = false, selectionActive = false } = {},
) {
  if (!event
      || event.defaultPrevented
      || event.repeat
      || event.isComposing
      || event.altKey
      || event.ctrlKey
      || event.metaKey
      || event.shiftKey
      || dialogOpen
      || selectionActive
      || event.target?.closest?.(BLOCKED_KEY_TARGETS)) {
    return 0;
  }
  if (event.key === 'ArrowRight') return 1;
  if (event.key === 'ArrowLeft') return -1;
  return 0;
}

export function readerPageAction(
  direction,
  {
    scrollTop = 0,
    viewportHeight = 0,
    documentHeight = 0,
    edgeThreshold = 8,
  } = {},
) {
  if (direction !== -1 && direction !== 1) return 'none';
  const top = nonNegativeNumber(scrollTop);
  const viewport = nonNegativeNumber(viewportHeight);
  const document = nonNegativeNumber(documentHeight);
  const threshold = nonNegativeNumber(edgeThreshold);
  const maximum = Math.max(0, document - viewport);
  if (direction === 1 && top >= maximum - threshold) return 'next';
  if (direction === -1 && top <= threshold) return 'previous';
  return 'scroll';
}

export function readerPageDistance({
  viewportHeight = 0,
  headerHeight = 0,
  bottomInset = 0,
  overlap = 32,
} = {}) {
  const visible = nonNegativeNumber(viewportHeight)
    - nonNegativeNumber(headerHeight)
    - nonNegativeNumber(bottomInset)
    - nonNegativeNumber(overlap);
  return Math.max(1, Math.floor(visible));
}

export function sectionOutlineEntries(sections) {
  if (!Array.isArray(sections) || sections.length === 0) return [];
  const levels = sections.map((section) =>
    Math.min(3, Math.max(1, Number.isInteger(section?.level) ? section.level : 1))
  );
  const baseLevel = Math.min(...levels);
  const counters = [0, 0, 0];
  return sections.map((section, index) => {
    const level = levels[index];
    const counterIndex = level - 1;
    counters[counterIndex] += 1;
    for (let deeper = counterIndex + 1; deeper < counters.length; deeper += 1) {
      counters[deeper] = 0;
    }
    const label = counters
      .slice(baseLevel - 1, counterIndex + 1)
      .filter((value) => value > 0)
      .join('.');
    return {
      section,
      label,
      depth: level - baseLevel,
    };
  });
}
