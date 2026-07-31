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

function normalizedSectionTitle(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('ko');
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

export function readerSwipeDirection(
  start,
  end,
  {
    minDistance = 56,
    maxDuration = 700,
    axisRatio = 1.25,
  } = {},
) {
  const values = [
    start?.x,
    start?.y,
    start?.time,
    end?.x,
    end?.y,
    end?.time,
  ];
  if (values.some((value) => !Number.isFinite(value))) return 0;

  const duration = end.time - start.time;
  if (duration < 0 || duration > nonNegativeNumber(maxDuration)) return 0;

  const horizontal = end.x - start.x;
  const vertical = end.y - start.y;
  const requiredDistance = nonNegativeNumber(minDistance);
  const requiredRatio = Math.max(1, nonNegativeNumber(axisRatio));
  if (Math.abs(horizontal) < requiredDistance
      || Math.abs(horizontal) < Math.abs(vertical) * requiredRatio) {
    return 0;
  }
  return horizontal < 0 ? 1 : -1;
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

function sectionHasOwnReadableBody(section) {
  if (!section || !Array.isArray(section.blocks)) return false;
  const title = normalizedSectionTitle(section.title);
  let foldedHeading = false;
  for (const block of section.blocks) {
    if (!block || block.type === 'sourceAnchor' || block.type === 'thematicBreak') continue;
    if (!foldedHeading
        && block.type === 'heading'
        && normalizedSectionTitle(block.text) === title) {
      foldedHeading = true;
      continue;
    }
    return true;
  }
  return false;
}

export function sectionHasReadableContent(section, index = -1, sections = [section]) {
  if (sectionHasOwnReadableBody(section)) return true;
  const resolvedIndex = Number.isInteger(index) && index >= 0
    ? index
    : sections.indexOf(section);
  const nextSection = resolvedIndex >= 0 ? sections[resolvedIndex + 1] : null;
  const level = Number.isInteger(section?.level) ? section.level : 1;
  const nextLevel = Number.isInteger(nextSection?.level) ? nextSection.level : 1;
  // A title-only item is a non-reading group only when it directly owns a
  // deeper child. A leaf heading such as a dedication remains readable.
  return !(nextSection && nextLevel > level);
}

export function resolveReadableSection(sections, sectionId) {
  if (!Array.isArray(sections) || sections.length === 0) return null;
  const requestedIndex = sections.findIndex((section) => section?.id === sectionId);
  if (requestedIndex >= 0
      && sectionHasReadableContent(sections[requestedIndex], requestedIndex, sections)) {
    return sections[requestedIndex];
  }
  const start = requestedIndex >= 0 ? requestedIndex : -1;
  for (let index = start + 1; index < sections.length; index += 1) {
    if (sectionHasReadableContent(sections[index], index, sections)) return sections[index];
  }
  for (let index = start - 1; index >= 0; index -= 1) {
    if (sectionHasReadableContent(sections[index], index, sections)) return sections[index];
  }
  return sections.find((section, index) =>
    sectionHasReadableContent(section, index, sections)
  ) ?? null;
}
