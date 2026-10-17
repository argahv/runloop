/**
 * Scroll `el` into view inside `container` only. Element.scrollIntoView also
 * scrolls every ancestor, which on phones (where the page itself scrolls)
 * would jump the whole page.
 */
export function scrollWithin(container: HTMLElement, el: HTMLElement, block: 'nearest' | 'center' = 'nearest'): void {
  const c = container.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (block === 'center') {
    container.scrollTop += r.top - c.top - (c.height - r.height) / 2;
    return;
  }
  if (r.top < c.top) container.scrollTop -= c.top - r.top;
  else if (r.bottom > c.bottom) container.scrollTop += r.bottom - c.bottom;
}
