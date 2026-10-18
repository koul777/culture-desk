import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Expand, MapPin, Navigation } from 'lucide-react';
import type { City, MapPerformance } from '../../shared/types';
import { useDesk } from '../desk';
import { directionLinks } from '../lib/directions';
import { formatPeriod, number } from '../lib/format';
import { clusterProjectedPoints } from '../lib/map-clusters';
import { groupVenueCoordinates } from '../lib/map-data';
import { markAfterPaint, measurePerformance, startPerformanceMeasure, type ResultTrace } from '../lib/performance';
import '../map-refinement.css';
import { Venue3D } from './Venue3D';

export function hasVenueLocation(item: MapPerformance): boolean {
  return item.locationPrecision === 'venue' && Number.isFinite(item.latitude) && Number.isFinite(item.longitude)
    && item.latitude! >= 33 && item.latitude! <= 39 && item.longitude! >= 124 && item.longitude! <= 132;
}

function cityPosition(city: City): L.LatLngTuple | null {
  return Number.isFinite(city.latitude) && Number.isFinite(city.longitude) ? [city.latitude!, city.longitude!] : null;
}

function cityIcon(city: City, count: number, active: boolean, zoom: number) {
  const el = document.createElement('span');
  el.className = `city-map-label${active ? ' is-active' : ''}${zoom < 10 ? ' is-city-overview' : ''}`;
  const name = document.createElement('span'); name.textContent = city.name;
  const badge = document.createElement('b'); badge.textContent = String(count);
  el.append(name, badge);
  return L.divIcon({ className: 'city-map-marker', html: el, iconSize: zoom < 10 ? [34, 34] : [100, 44], iconAnchor: zoom < 10 ? [17, 17] : [50, 22] });
}

function accessibleMarker(marker: L.Marker, label: string, openPopupFromKeyboard?: () => void) {
  marker.on('add', () => {
    const element = marker.getElement();
    if (!element) return;
    element.setAttribute('role', 'button');
    element.setAttribute('aria-label', label);
    if (openPopupFromKeyboard) element.setAttribute('aria-haspopup', 'dialog');
    element.addEventListener('keydown', event => {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault(); event.stopPropagation();
        if (openPopupFromKeyboard) openPopupFromKeyboard();
        else marker.fire('click', { originalEvent: event });
      }
    });
  });
}

function accessiblePopup(popup: HTMLElement, marker: L.Marker, label: string) {
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', label);
  popup.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation();
    marker.closePopup(); marker.getElement()?.focus({ preventScroll: true });
  });
}

function updatePopupKeepingFocus(popup: L.Popup) {
  const active = document.activeElement;
  const restore = active instanceof HTMLElement && popup.getElement()?.contains(active);
  popup.update();
  // Leaflet hides the container, detaches/reappends its content, then makes it visible.
  // Restore only after update() returns; contentupdate fires while it is still hidden.
  if (restore && active.isConnected) active.focus({ preventScroll: true });
}

export interface PerformanceMapProps {
  items: MapPerformance[]; selectedCities: string[]; focusedId: number | null;
  onCity: (cityId: string) => void; onFocus: (id: number) => void;
  trace?: ResultTrace;
}

export function PerformanceMap({ items, selectedCities, focusedId, onCity, onFocus, trace }: PerformanceMapProps) {
  const { boot, openDetail } = useDesk();
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layers = useRef<L.LayerGroup | null>(null);
  const markers = useRef(new Map<number, L.Marker>());
  const pendingFocus = useRef<number | null>(null);
  const pendingKeyboardFocus = useRef<number | null>(null);
  const popupFocusFrame = useRef<number | null>(null);
  const actions = useRef({ onCity, onFocus, openDetail });
  actions.current = { onCity, onFocus, openDetail };
  const [tileError, setTileError] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [zoom, setZoom] = useState(7);
  const [venue3D, setVenue3D] = useState<MapPerformance | null>(null);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const selectionKey = [...selectedCities].sort().join(',');
  const selectedSet = useMemo(() => new Set(selectedCities.length ? selectedCities : boot.cities.map(c => c.id)), [selectionKey, boot.cities]);
  const regions = useMemo(() => boot.cities.filter(c => selectedSet.has(c.id)), [boot.cities, selectedSet]);
  const selectedItems = useMemo(() => items.filter(p => selectedSet.has(p.cityId)), [items, selectedSet]);
  const venueItems = useMemo(() => selectedItems.filter(hasVenueLocation), [selectedItems]);
  const venueGroups = useMemo(() => measurePerformance('map-group', { count: venueItems.length }, () => groupVenueCoordinates(venueItems)), [venueItems]);
  const nationwide = !selectedCities.length || regions.length === boot.cities.length;
  const unknownItems = selectedItems.length - venueItems.length;
  const focusedItem = selectedItems.find(p => p.id === focusedId);
  const missingFocus = focusedItem && !hasVenueLocation(focusedItem) ? focusedItem : undefined;
  const unknownCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of selectedItems) if (!hasVenueLocation(item)) counts.set(item.cityId, (counts.get(item.cityId) ?? 0) + 1);
    return counts;
  }, [selectedItems]);
  const centreCities = regions.filter(c => cityPosition(c) && unknownCounts.has(c.id));
  const fitResults = () => {
    map.current?.closePopup();
    const positions: L.LatLngTuple[] = venueItems.map(p => [p.latitude!, p.longitude!]);
    if (nationwide) positions.push([33.1, 125.6], [38.6, 129.7]);
    else if (!positions.length) positions.push(...regions.map(cityPosition).filter((p): p is L.LatLngTuple => !!p));
    if (positions.length) map.current?.fitBounds(L.latLngBounds(positions), {
      paddingTopLeft: [35, 86], paddingBottomRight: [45, 65], maxZoom: regions.length === 1 ? 13 : 10, animate: false,
    });
    else map.current?.fitBounds([[33.1, 125.6], [38.6, 129.7]], { padding: [22, 30], animate: false });
  };

  useEffect(() => { pendingKeyboardFocus.current = null; }, [items, selectionKey]);

  useEffect(() => {
    if (!host.current) return;
    const instance = L.map(host.current, { center: [36.25, 127.8], zoom: 7, minZoom: 5, maxZoom: 18, zoomSnap: .25,
      zoomControl: false, scrollWheelZoom: false, zoomAnimation: false, markerZoomAnimation: false, fadeAnimation: !reduced });
    map.current = instance;
    instance.on('zoomend', () => setZoom(instance.getZoom()));
    L.control.zoom({ position: 'bottomright', zoomInTitle: '지도 확대', zoomOutTitle: '지도 축소' }).addTo(instance);
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
    }).addTo(instance);
    tiles.on('tileerror', () => setTileError(true));
    tiles.on('load', () => { if (host.current?.querySelector('img.leaflet-tile-loaded')) setTileError(false); });
    layers.current = L.layerGroup().addTo(instance);
    const resize = new ResizeObserver(() => {
      if (map.current !== instance) return;
      instance.invalidateSize({ pan: false });
      instance.eachLayer(layer => { if (layer instanceof L.Popup && layer.isOpen()) updatePopupKeepingFocus(layer); });
    });
    resize.observe(host.current);
    setMapReady(true);
    return () => {
      if (popupFocusFrame.current !== null) window.cancelAnimationFrame(popupFocusFrame.current);
      pendingKeyboardFocus.current = null;
      resize.disconnect(); instance.stop(); instance.remove(); map.current = null; layers.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mapReady || !map.current || !layers.current) return;
    const detail = { ...trace, count: selectedItems.length, locatedCount: venueItems.length, venueCount: venueGroups.length, zoom };
    const projected = measurePerformance('map-project', detail, () => venueGroups.map(group => {
      const position: L.LatLngTuple = [group[0].latitude!, group[0].longitude!];
      const point = map.current!.project(position, zoom);
      return { group, position, x: point.x, y: point.y };
    }));
    const bundles = measurePerformance('map-cluster', detail, () => clusterProjectedPoints(projected, zoom));
    const finishLayers = startPerformanceMeasure('map-layers', detail);
    layers.current.clearLayers(); markers.current.clear();
    for (const city of centreCities) {
      const pos = cityPosition(city); if (!pos) continue;
      const count = unknownCounts.get(city.id)!;
      const label = `${city.sido} ${city.name} · 위치 미확인 공연 ${count}건 · 도시 중심에서 지역 선택`;
      const marker = L.marker(pos, { icon: cityIcon(city, count, regions.length === 1, zoom), keyboard: true,
        title: label, alt: label, zIndexOffset: -200 });
      accessibleMarker(marker, label);
      marker.on('click', () => actions.current.onCity(city.id));
      marker.addTo(layers.current);
    }
    for (const bundle of bundles) {
      if (bundle.length > 1) {
        const count = bundle.reduce((sum, venue) => sum + venue.group.length, 0);
        const centre = L.point(bundle.reduce((sum, venue) => sum + venue.x, 0) / bundle.length, bundle.reduce((sum, venue) => sum + venue.y, 0) / bundle.length);
        const point = map.current!.unproject(centre, zoom);
        const dot = document.createElement('span'); dot.className = 'venue-cluster-dot';
        const total = document.createElement('strong'); total.textContent = number(count);
        const caption = document.createElement('small'); caption.textContent = '공연'; dot.append(total, caption);
        const label = `공연 ${number(count)}건 · 공연장 ${number(bundle.length)}곳 묶음 · 눌러서 확대`;
        const marker = L.marker(point, { icon: L.divIcon({ className: 'venue-cluster-marker', html: dot, iconSize: [54, 54], iconAnchor: [27, 27] }), keyboard: true, title: label, alt: label, zIndexOffset: 150 });
        accessibleMarker(marker, label);
        marker.on('add', () => { const element = marker.getElement(); if (element) element.dataset.performanceCount = String(count); });
        marker.on('click', () => {
          const instance = map.current; if (!instance) return;
          instance.closePopup();
          const before = instance.getZoom();
          instance.fitBounds(L.latLngBounds(bundle.map(venue => venue.position)), { paddingTopLeft: [55, 85], paddingBottomRight: [55, 70], maxZoom: 15, animate: false });
          if (instance.getZoom() <= before) instance.setZoom(Math.min(15, before + 1));
        });
        marker.addTo(layers.current);
        continue;
      }
      const group = bundle[0].group;
      const item = group[0];
      const dot = document.createElement('span'); dot.className = 'venue-map-dot'; dot.textContent = String(group.length);
      const icon = L.divIcon({ className: 'venue-map-marker', html: dot, iconSize: [44, 44], iconAnchor: [22, 22] });
      const label = `${item.venue || '공연장'} · 공연 ${group.length}건 · 공연 목록 열기`;
      const marker = L.marker([item.latitude!, item.longitude!], { icon, keyboard: true, title: label, alt: label, zIndexOffset: 100 });
      // Keep locate-by-id available before opening a popup; popup DOM is needed only on demand.
      for (const show of group) markers.current.set(show.id, marker);
      let popup: HTMLElement | undefined;
      const popupContent = () => popup ??= measurePerformance('map-popup', { ...detail, count: group.length }, () => {
        const content = document.createElement('div'); content.className = 'map-popup';
        const heading = document.createElement('strong'); heading.textContent = `${item.venue || '공연장'} · ${group.length}건`;
        const hint = document.createElement('p'); hint.textContent = '공연장 3D, 길찾기 또는 공연 상세를 확인하세요.';
        content.append(heading, hint);
        const threeD = document.createElement('button'); threeD.type = 'button'; threeD.className = 'map-popup-3d';
        threeD.textContent = '공연장 3D로 보기'; threeD.setAttribute('aria-label', `${item.venue || '공연장'} 3D로 보기`);
        threeD.onclick = () => setVenue3D(item); content.append(threeD);
        const route = directionLinks(item);
        if (route) {
          const link = document.createElement('a'); link.className = 'map-popup-route'; link.href = route.kakao;
          link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = route.precise ? '카카오맵 길찾기' : '카카오맵에서 찾기';
          link.setAttribute('aria-label', `${item.venue || '공연장'} ${link.textContent} (새 창)`); content.append(link);
        }
        for (const show of group) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'map-popup-show';
          button.setAttribute('aria-label', `${show.title} 상세 보기`);
          const title = document.createElement('span'); title.textContent = show.title;
          const date = document.createElement('small'); date.textContent = formatPeriod(show.startDate, show.endDate);
          const more = document.createElement('span'); more.className = 'map-popup-more'; more.textContent = '상세 보기 →';
          button.append(title, date, more); button.addEventListener('click', () => { actions.current.onFocus(show.id); actions.current.openDetail(show.id); });
          content.append(button);
        }
        accessiblePopup(content, marker, label);
        return content;
      });
      accessibleMarker(marker, label, () => {
        const instance = map.current;
        if (!instance) return;
        pendingKeyboardFocus.current = item.id;
        if (instance.getZoom() < 14) {
          pendingFocus.current = item.id;
          instance.setView(marker.getLatLng(), 15, { animate: false });
        } else marker.openPopup();
        actions.current.onFocus(item.id);
      });
      marker.on('add', () => { const element = marker.getElement(); if (element) element.dataset.performanceCount = String(group.length); });
      marker.bindPopup(popupContent, { maxWidth: 300, minWidth: 210, autoPanPaddingTopLeft: [20, 80], autoPanPaddingBottomRight: [20, 30] });
      marker.on('popupopen', () => {
        // The focus effect zooms to 15 and replaces low-zoom markers. Carry keyboard
        // intent to that final popup instead of focusing DOM about to be removed.
        if (map.current!.getZoom() < 14 || !group.some(show => show.id === pendingKeyboardFocus.current)) return;
        if (popupFocusFrame.current !== null) window.cancelAnimationFrame(popupFocusFrame.current);
        let remainingFrames = 30;
        const focusVisiblePopup = () => {
          popupFocusFrame.current = null;
          if (!marker.isPopupOpen() || !popup?.isConnected || !group.some(show => show.id === pendingKeyboardFocus.current)) return;
          const target = popup.querySelector<HTMLButtonElement>('.map-popup-show');
          // Leaflet can still be finishing popup visibility at popupopen/first frame.
          // A hidden connected control ignores focus; wait for visibility, with cleanup and a bound.
          if (target && getComputedStyle(target).visibility !== 'visible') {
            if (remainingFrames-- > 0) popupFocusFrame.current = window.requestAnimationFrame(focusVisiblePopup);
            else pendingKeyboardFocus.current = null;
            return;
          }
          target?.focus({ preventScroll: true });
          pendingKeyboardFocus.current = null;
        };
        popupFocusFrame.current = window.requestAnimationFrame(focusVisiblePopup);
      });
      marker.on('click', () => actions.current.onFocus(item.id)); marker.addTo(layers.current);
    }
    if (pendingFocus.current !== null) {
      const marker = markers.current.get(pendingFocus.current);
      if (marker) { marker.openPopup(); pendingFocus.current = null; }
    }
    finishLayers();
    const cancelReady = markAfterPaint('map-ready', { ...detail, markers: layers.current.getLayers().length });
    return () => {
      cancelReady();
      if (popupFocusFrame.current !== null) { window.cancelAnimationFrame(popupFocusFrame.current); popupFocusFrame.current = null; }
    };
  }, [items, boot.cities, selectionKey, mapReady, zoom, trace?.requestId, trace?.filterKey, trace?.dataSource]);

  const locationKey = useMemo(() => venueItems.map(p => `${p.id}:${p.latitude}:${p.longitude}`).join('|'), [venueItems]);
  useEffect(() => {
    if (!mapReady || !map.current) return;
    fitResults();
  }, [selectionKey, locationKey, mapReady]);

  useEffect(() => {
    if (!mapReady || !map.current) return;
    if (focusedId === null) { pendingFocus.current = null; map.current.closePopup(); return; }
    const venue = selectedItems.find(item => item.id === focusedId && hasVenueLocation(item));
    if (venue && map.current.getZoom() < 14) {
      pendingFocus.current = focusedId;
      map.current.setView([venue.latitude!, venue.longitude!], 15, { animate: false });
      return;
    }
    const marker = markers.current.get(focusedId);
    if (marker) {
      map.current.setView(marker.getLatLng(), Math.max(13, map.current.getZoom()), { animate: false });
      if (!marker.isPopupOpen()) marker.openPopup();
    }
    else {
      const item = missingFocus;
      if (!item) { map.current.closePopup(); return; }
      const city = boot.cities.find(c => c.id === item.cityId);
      const pos = city && cityPosition(city);
      if (pos) {
        map.current.setView(pos, 11, { animate: false });
        const content = document.createElement('div'); content.className = 'map-popup';
        const title = document.createElement('strong'); title.textContent = item.title;
        const note = document.createElement('p'); note.textContent = '공연장 위치가 없어 도시 중심을 표시합니다.';
        const button = document.createElement('button'); button.type = 'button'; button.className = 'map-popup-show'; button.textContent = '공연 상세 보기';
        button.onclick = () => actions.current.openDetail(item.id); content.append(title, note, button);
        L.popup({ maxWidth: 280 }).setLatLng(pos).setContent(content).openOn(map.current);
      } else map.current.closePopup();
    }
  }, [focusedId, mapReady, items, selectionKey]);

  return (
    <><div className="map-panel map-panel-refined">
      <div ref={host} className="performance-map" role="region" aria-label="공연 지도. Tab으로 공연장 마커를 이동하고 Enter로 공연 목록을 확인할 수 있습니다." />
      <div className="map-heading"><span className="map-heading-icon"><Navigation size={17} aria-hidden="true" /></span><div><strong>{nationwide ? '전국 공연 지도' : regions.length === 1 ? `${regions[0].name} 공연 지도` : '선택 지역 공연 지도'}</strong><span>묶음을 확대하면 공연장 · 3D 보기</span></div></div>
      <button type="button" className="map-fit" onClick={fitResults} aria-label="검색 결과가 보이도록 지도 맞추기"><Expand size={16} aria-hidden="true" />결과 맞춤</button>
      <div className="map-legend"><span><i className="legend-cluster" />묶음 · 누르면 확대</span><span><i className="legend-venue" />공연장 · 숫자는 공연 수</span>{centreCities.length > 0 && <span><i className="legend-city" />도시 중심 · 위치 미확인</span>}</div>
      {tileError && <div className="map-tile-error" role="status">지도 배경을 불러오지 못했습니다. 공연 마커와 목록은 계속 이용할 수 있습니다.</div>}
      {!venueItems.length && !centreCities.length && <div className="map-empty-state"><MapPin size={22} aria-hidden="true" /><strong>{selectedItems.length ? '표시할 공연장 위치가 없습니다' : '이 조건의 공연이 없습니다'}</strong><span>{selectedItems.length ? '공연 정보는 목록에서 확인할 수 있어요.' : '지역이나 기간을 바꿔서 찾아보세요.'}</span></div>}
      <div className="map-caption"><div className="map-status-summary" role="status"><MapPin size={14} aria-hidden="true" /><span>공연장 위치 {number(venueItems.length)}건 · 위치 미확인 {number(unknownItems)}건</span></div>{missingFocus && <div className="map-focus-note"><span title={missingFocus.title}>위치 미확인 · {missingFocus.title}</span><button type="button" onClick={() => openDetail(missingFocus.id)}>상세 보기</button></div>}</div>
    </div>{venue3D && <Venue3D item={venue3D} onClose={() => setVenue3D(null)} />}</>
  );
}
