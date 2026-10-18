import type { MapPerformance } from '../../shared/types';
import { directionLinks } from './directions';
import { formatPeriod, number } from './format';
import { revealVenuePopupItem, venuePopupPage, venuePopupSummary } from './map-popup-model';

export interface VenuePopupActions {
  onSelect: (item: MapPerformance) => void;
  onThreeD: (item: MapPerformance) => void;
  onClose: () => void;
  onLayout: () => void;
  onInteract?: () => void;
}

export interface VenuePopupController {
  element: HTMLElement;
  /** Returns false for a foreign id. Local search is cleared only if it hides this id. */
  reveal: (id: number) => boolean;
  focusItem: (id?: number) => boolean;
  focusWhenReady: (id?: number, onFocused?: (target: HTMLElement) => void) => void;
  dispose: () => void;
}

/** A small stable control surface; only the current page of show rows is replaced. */
export function createVenuePopup(items: readonly MapPerformance[], label: string, actions: VenuePopupActions): VenuePopupController {
  const first = items[0];
  if (!first) throw new Error('A venue popup requires at least one performance');
  const summary = venuePopupSummary(items);
  const content = document.createElement('div'); content.className = 'map-popup';
  content.setAttribute('role', 'dialog'); content.setAttribute('aria-label', label);
  const heading = document.createElement('strong');
  heading.textContent = summary.hasSingleVenue ? `${first.venue} · ${number(items.length)}건` : `이 위치의 공연 · ${number(items.length)}건`;
  const hint = document.createElement('p'); hint.className = 'map-popup-hint';
  const venueSummary = [summary.venueNames.length ? `공연장 표기 ${number(summary.venueNames.length)}개` : '', summary.unknownVenueCount ? `공연장 정보 없음 ${number(summary.unknownVenueCount)}건` : ''].filter(Boolean).join(' · ');
  hint.textContent = summary.hasSingleVenue ? '공연장 3D, 길찾기 또는 공연 상세를 확인하세요.'
    : `${venueSummary} · 공연 상세에서 해당 공연장의 3D와 길찾기를 확인하세요.`;
  content.append(heading, hint);
  if (summary.hasSingleVenue) {
    const threeD = document.createElement('button'); threeD.type = 'button'; threeD.className = 'map-popup-3d';
    threeD.textContent = '공연장 3D로 보기'; threeD.setAttribute('aria-label', `${first.venue || '공연장'} 3D로 보기`);
    threeD.onclick = () => actions.onThreeD(first); content.append(threeD);
    const route = directionLinks(first);
    if (route) {
      const link = document.createElement('a'); link.className = 'map-popup-route'; link.href = route.kakao;
      link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = route.precise ? '카카오맵 길찾기' : '카카오맵에서 찾기';
      link.setAttribute('aria-label', `${first.venue || '공연장'} ${link.textContent} (새 창)`); content.append(link);
    }
  }
  const searchLabel = document.createElement('label'); searchLabel.className = 'map-popup-search';
  const searchName = document.createElement('span'); searchName.className = 'visually-hidden'; searchName.textContent = '이 위치의 공연명·공연장 검색';
  const search = document.createElement('input'); search.type = 'search'; search.placeholder = '공연명·공연장 검색'; search.maxLength = 200;
  search.autocomplete = 'off'; search.spellcheck = false; searchLabel.append(searchName, search);
  // Small groups retain their simple list. A stable search field is available for
  // groups where local narrowing is useful, including mixed hall names.
  if (items.length > 20 || !summary.hasSingleVenue) content.append(searchLabel);
  const status = document.createElement('p'); status.className = 'map-popup-count'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.setAttribute('aria-atomic', 'true');
  const list = document.createElement('div'); list.className = 'map-popup-list';
  const pager = document.createElement('div'); pager.className = 'map-popup-pagination'; pager.setAttribute('role', 'group'); pager.setAttribute('aria-label', '이 위치의 공연 페이지');
  const previous = document.createElement('button'); previous.type = 'button'; previous.textContent = '이전'; previous.setAttribute('aria-label', '이 위치의 공연 이전 페이지');
  const pageLabel = document.createElement('span'); pageLabel.className = 'map-popup-page';
  const next = document.createElement('button'); next.type = 'button'; next.textContent = '다음'; next.setAttribute('aria-label', '이 위치의 공연 다음 페이지');
  pager.append(previous, pageLabel, next); content.append(status, list, pager);

  let query = '', page = 1, composing = false, disposed = false;
  let pendingFocus: number | undefined, frame: number | null = null;
  let current = venuePopupPage(items, query, page);
  const rowButtons = new Map<number, HTMLButtonElement>();
  const cancelPendingFocus = () => { if (frame !== null) cancelAnimationFrame(frame); frame = null; };
  const scrollToVisible = (target: HTMLElement) => {
    const scroll = content.closest<HTMLElement>('.leaflet-popup-content');
    if (!scroll) return;
    const targetRect = target.getBoundingClientRect(), viewport = scroll.getBoundingClientRect();
    if (targetRect.top < viewport.top || targetRect.height > viewport.height) scroll.scrollTop += targetRect.top - viewport.top;
    else if (targetRect.bottom > viewport.bottom) scroll.scrollTop += targetRect.bottom - viewport.bottom;
  };
  const focusItem = (id?: number): boolean => {
    cancelPendingFocus();
    // Reopening is not a new locate request: keep the user's local query/page.
    // Prefer the selected row only when it is already here; an empty search
    // returns to its stable input so the user can change the query immediately.
    const target = (id === undefined ? undefined : rowButtons.get(id))
      ?? rowButtons.values().next().value
      ?? (search.isConnected ? search : undefined);
    if (!target || !target.isConnected || getComputedStyle(target).visibility !== 'visible') return false;
    target.focus({ preventScroll: true }); scrollToVisible(target);
    return document.activeElement === target;
  };
  const focusAfterLayout = (id?: number, onFocused?: (target: HTMLElement) => void) => {
    pendingFocus = id;
    cancelPendingFocus();
    let remaining = 30;
    const attempt = () => {
      frame = null;
      if (disposed || !content.isConnected) return;
      if (focusItem(pendingFocus)) onFocused?.(document.activeElement as HTMLElement);
      else if (remaining-- > 0) frame = requestAnimationFrame(attempt);
    };
    frame = requestAnimationFrame(attempt);
  };
  const render = (notifyLayout = true) => {
    current = venuePopupPage(items, query, page); page = current.page;
    status.textContent = current.total ? `${number(current.from)}–${number(current.to)} / ${number(current.total)}건${query.trim() ? ` · 전체 ${number(items.length)}건` : ''}` : `검색 결과 0건 · 전체 ${number(items.length)}건`;
    previous.disabled = current.page === 1; next.disabled = current.page === current.pages;
    pageLabel.textContent = `${current.page} / ${current.pages}`; pager.hidden = current.pages === 1;
    rowButtons.clear(); list.replaceChildren();
    for (const item of current.items) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'map-popup-show'; button.dataset.performanceId = String(item.id);
      const venueLabel = typeof item.venue === 'string' && item.venue.trim() ? item.venue : '공연장 정보 없음';
      button.setAttribute('aria-label', summary.hasSingleVenue ? `${item.title} 상세 보기` : `${item.title} · ${venueLabel} 상세 보기`);
      const title = document.createElement('span'); title.textContent = item.title;
      const venue = document.createElement('span'); venue.className = 'map-popup-venue'; venue.textContent = venueLabel;
      const date = document.createElement('small'); date.textContent = formatPeriod(item.startDate, item.endDate);
      const more = document.createElement('span'); more.className = 'map-popup-more'; more.textContent = '상세 보기 →';
      button.append(title, venue, date, more); button.onclick = () => actions.onSelect(item);
      rowButtons.set(item.id, button); list.append(button);
    }
    if (!current.total) { const empty = document.createElement('p'); empty.className = 'map-popup-empty'; empty.textContent = '일치하는 공연이 없습니다. 검색어를 바꿔보세요.'; list.append(empty); }
    if (notifyLayout) actions.onLayout();
  };
  const applySearch = () => {
    if (composing || query === search.value) return;
    cancelPendingFocus();
    query = search.value; page = 1; render();
    // Preserve the user's caret and reveal the field after popup layout changes.
    scrollToVisible(search);
  };
  search.addEventListener('focus', cancelPendingFocus);
  search.addEventListener('compositionstart', () => { actions.onInteract?.(); cancelPendingFocus(); composing = true; });
  search.addEventListener('compositionend', () => { composing = false; applySearch(); });
  search.addEventListener('input', event => { actions.onInteract?.(); if (!(event as InputEvent).isComposing) applySearch(); });
  previous.onclick = () => { actions.onInteract?.(); if (page <= 1) return; page--; render(); focusAfterLayout(); };
  next.onclick = () => { actions.onInteract?.(); if (page >= current.pages) return; page++; render(); focusAfterLayout(); };
  content.addEventListener('pointerdown', () => { cancelPendingFocus(); actions.onInteract?.(); });
  content.addEventListener('focusout', event => {
    // Leaflet temporarily detaches/reappends this content during update(); that
    // blur has no related target. Only an explicit move to another control wins.
    if (event.relatedTarget instanceof Node && !content.contains(event.relatedTarget)) cancelPendingFocus();
  });
  content.addEventListener('keydown', event => {
    cancelPendingFocus();
    actions.onInteract?.();
    event.stopPropagation();
    if (event.key === 'Escape' && !event.isComposing && !composing) { event.preventDefault(); actions.onClose(); }
  });
  render(false);
  return { element: content, focusItem, focusWhenReady: focusAfterLayout,
    reveal: id => {
      const nextState = revealVenuePopupItem(items, query, id);
      if (!nextState) return false;
      if (nextState.query !== query || nextState.page !== page) {
        cancelPendingFocus();
        query = nextState.query; page = nextState.page; search.value = query; composing = false; render();
      }
      return true;
    },
    dispose: () => { disposed = true; cancelPendingFocus(); },
  };
}
