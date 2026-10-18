interface VerticalBounds { top: number; bottom: number }
interface HorizontalBounds { left: number; right: number }

/** visualViewport coordinates include the offset caused by an on-screen keyboard. */
export function locateVisibleBounds(row: HorizontalBounds, viewport: { offsetTop: number; height: number }, header?: VerticalBounds & HorizontalBounds & { position: string }): VerticalBounds {
  let top = viewport.offsetTop;
  if (header && (header.position === 'sticky' || header.position === 'fixed') && header.top <= top + 1
    && header.left < row.right && header.right > row.left) top = Math.max(top, header.bottom);
  return { top, bottom: viewport.offsetTop + viewport.height };
}

/** Smallest vertical correction that exposes the row, or its start if too tall. */
export function locateScrollDelta(row: VerticalBounds, visible: VerticalBounds, padding = 12): number {
  const top = visible.top + padding, bottom = Math.max(top, visible.bottom - padding);
  if (row.top < top || row.bottom - row.top > bottom - top) return row.top - top;
  return row.bottom > bottom ? row.bottom - bottom : 0;
}

/** One immediate page scroll after popup auto-pan settles; no persistent observer. */
export function scheduleLocatedRowScroll(target: HTMLElement, onDone: () => void): () => void {
  let frame: number | null = null, active = true, remaining = 30, stable = 0;
  let previous: DOMRect | undefined;
  const inputEvents = ['wheel', 'touchstart', 'pointerdown'] as const;
  const cancel = () => {
    active = false;
    if (frame !== null) cancelAnimationFrame(frame); frame = null;
    for (const type of inputEvents) window.removeEventListener(type, onInput, true);
    window.removeEventListener('keydown', onKey, true);
  };
  const finish = () => { if (!active) return; cancel(); onDone(); };
  const onInput = () => finish();
  const onKey = (event: KeyboardEvent) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) finish();
  };
  const check = () => {
    frame = null;
    if (!active) return;
    if (!target.isConnected || document.activeElement !== target) { finish(); return; }
    const row = target.getBoundingClientRect();
    stable = previous && Math.abs(previous.top - row.top) < .5 && Math.abs(previous.bottom - row.bottom) < .5 ? stable + 1 : 0;
    previous = row;
    if (stable < 2 && --remaining > 0) { frame = requestAnimationFrame(check); return; }
    const viewport = window.visualViewport;
    const sidebar = document.querySelector<HTMLElement>('.sidebar');
    const bounds = sidebar?.getBoundingClientRect();
    // The desktop sidebar sits beside the map, so it must not reduce its height.
    const visible = locateVisibleBounds(row, { offsetTop: viewport?.offsetTop ?? 0, height: viewport?.height ?? window.innerHeight }, bounds && sidebar
      ? { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right, position: getComputedStyle(sidebar).position } : undefined);
    const delta = locateScrollDelta(row, visible);
    if (Math.abs(delta) > .5) window.scrollBy({ top: delta, behavior: 'instant' });
    finish();
  };
  // A new user gesture wins over this pending correction. Observe input starts,
  // not scroll events, which also include browser and our own programmatic moves.
  for (const type of inputEvents) window.addEventListener(type, onInput, { capture: true, passive: true });
  window.addEventListener('keydown', onKey, { capture: true, passive: true });
  frame = requestAnimationFrame(check);
  return cancel;
}
