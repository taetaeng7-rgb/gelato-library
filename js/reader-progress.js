export function progressIndexAtViewport(
  items,
  viewportHeight,
  pageAtEnd = false,
) {
  if (!Array.isArray(items) || items.length === 0 || !(viewportHeight > 0)) return -1;
  const readingLine = viewportHeight * 0.7;
  let candidate = -1;
  for (const item of items) {
    if (item?.rect?.top <= readingLine && Number.isInteger(item.index)) {
      candidate = Math.max(candidate, item.index);
    }
  }

  const last = items.at(-1);
  if (!last || candidate < last.index) return candidate;
  const lastFinished = pageAtEnd || last.rect.bottom <= viewportHeight * 0.9;
  if (lastFinished) return last.index;

  const earlier = items
    .slice(0, -1)
    .filter((item) => item.rect.top <= readingLine)
    .reduce((highest, item) => Math.max(highest, item.index), -1);
  // If the section title heading was visually folded into the reader header,
  // its original index is immediately before the first visible content block.
  return Math.max(earlier, last.index - 1);
}
