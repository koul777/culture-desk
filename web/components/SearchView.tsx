import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, CalendarDays, Check, FileSpreadsheet, LayoutGrid, ListChecks, LoaderCircle, Map, RefreshCw, Search, SlidersHorizontal, Table2 } from 'lucide-react';
import type { MapResult, SearchResult } from '../../shared/types';
import { api, downloadExport, errorText } from '../api';
import { useDesk } from '../desk';
import { PAGE_SIZES, defaultFilters, filterProblem, toSearchFilters, usesDetailFilter, type FilterState } from '../lib/filters';
import { SOURCES, formatDate, formatDateTime, number, sourceLabel } from '../lib/format';
import { useDebounced } from '../lib/hooks';
import { activeSummary, sourceState } from '../lib/runs';
import {
  Badge, Callout, CityCell, GenreCell, PeriodCell, PriceCell, SourceCell, TitleCell, VenueCell,
} from './Cells';
import { Pagination } from './Fields';
import { FilterPanel } from './FilterPanel';
import { useNotify } from './Notices';
import { SetupGuide } from './SetupGuide';
import { PerformanceCard } from './PerformanceCard';
import { PerformanceMap } from './PerformanceMap';
import { RegionPicker } from './RegionPicker';
import { AutomaticRefreshLink } from './AutomaticRefresh';

export function SourceStrip() {
  const { boot } = useDesk();
  return (
    <dl className="source-strip" aria-label="출처별 연결과 등록 자료">
      {boot.sources.map(s => {
        const state = sourceState(boot, s.source);
        return (
          <div key={s.source} className="source-strip-item">
            <dt>{s.label}</dt>
            <dd>
              <Badge tone={state.tone}>{state.label}</Badge>
              <span className="nums">등록 {number(s.count)}건</span>
              <span className="muted">마지막 완료 {formatDateTime(s.lastSync)}</span>
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function activeFilterCount(f: FilterState, base: FilterState, regionCount: number): number {
  return (['genre', 'q', 'status', 'price', 'age', 'source'] as const).filter(k => String(f[k]).trim() !== String(base[k])).length
    + (f.cities.length > 0 && f.cities.length < regionCount ? 1 : 0) + (f.from !== base.from || f.to !== base.to ? 1 : 0);
}

export function SearchView({ filters, setFilters, display }: { filters: FilterState; setFilters: (next: FilterState) => void; display: 'map' | 'cards' | 'table' }) {
  const { boot, signature, patch, run, isBusy, refresh, go } = useDesk();
  const notify = useNotify();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const setDisplay = (next: 'map' | 'cards' | 'table') => go(next === 'cards' ? 'search' : next);
  const nationwide = filters.cities.length === 0 || filters.cities.length === boot.cities.length;
  const mapCities = useMemo(() => filters.cities.length ? filters.cities : boot.cities.map(c => c.id), [filters.cities, boot.cities]);
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const [mapResult, setMapResult] = useState<MapResult | null>(null);
  const [mapFailed, setMapFailed] = useState(false);
  const q = useDebounced(filters.q, 350);
  const age = useDebounced(filters.age, 350);
  const effective = useMemo(() => ({ ...filters, cities: nationwide ? [] : filters.cities, q, age }), [filters, nationwide, q, age]);
  const searchFilters = useMemo(() => toSearchFilters(effective), [effective]);
  const key = JSON.stringify([searchFilters, effective.limit]);
  const [pageState, setPageState] = useState({ key, page: 1 });
  const page = pageState.key === key ? pageState.page : 1;
  const problem = filterProblem(effective);
  const hasData = boot.sources.some(s => s.count > 0);

  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const id = ++seq.current;
    if (problem || !hasData) { setLoading(false); return; }
    setLoading(true);
    api.search(toSearchFilters(effective, page))
      .then(r => { if (id === seq.current) { setResult(r); setError(null); } })
      .catch(e => { if (id === seq.current) setError(errorText(e)); })
      .finally(() => { if (id === seq.current) setLoading(false); });
    // `key` captures every effective filter value; `signature` refetches as collection progresses.
  }, [key, page, signature, problem, hasData, retry]);

  useEffect(() => {
    if (problem || !hasData || display !== 'map') return;
    let cancelled = false;
    setMapResult(null); setMapFailed(false); setFocusedId(null);
    api.map(searchFilters)
      .then(r => { if (!cancelled) setMapResult(r); })
      .catch(() => { if (!cancelled) setMapFailed(true); });
    return () => { cancelled = true; };
  }, [JSON.stringify(searchFilters), signature, display, problem, hasData, retry]);

  useEffect(() => {
    if (patch) setResult(r => r && { ...r, items: r.items.map(i => (i.id === patch.item.id ? patch.item : i)) });
  }, [patch]);

  const base = useMemo(() => defaultFilters(boot), [boot]);
  const changed = activeFilterCount(filters, base, boot.cities.length);
  const detailFilter = usesDetailFilter(effective);
  const pending = result?.pendingDetails ?? 0;
  const progress = activeSummary(boot.runs);
  const exporting = isBusy('export:search');
  const requesting = isBusy('details:search');

  const requestDetails = () => run('details:search', async () => {
    try {
      const r = await api.requestDetails(searchFilters);
      notify(r.queued ? 'ok' : 'info', r.queued
        ? `상세 보충 ${number(r.queued)}건을 작업에 추가했습니다. 3초마다 진행 상태를 반영합니다.`
        : '새로 추가할 상세 보충 작업이 없습니다. 이미 대기 중이거나 API 키가 없는 출처의 공연입니다.');
      await refresh();
    } catch (e) { notify('error', errorText(e)); }
  });
  const exportResults = () => run('export:search', async () => {
    try {
      const name = await downloadExport(searchFilters);
      notify('ok', `검색 결과 엑셀을 내려받았습니다: ${name}${result?.partial ? ' (부분 자료로 기록됨)' : ''}`);
    } catch (e) { notify('error', errorText(e)); }
  });

  const start = result && result.total ? (result.page - 1) * effective.limit + 1 : 0;
  const end = result ? Math.min(result.total, result.page * effective.limit) : 0;

  return (
    <section className={`view explore-view${display === 'map' ? ' is-map-view' : ''}`} aria-labelledby="search-title">
      <div className="workspace-bar"><span><span className="workspace-dot" />지역별 공연 정보</span><span><CalendarDays size={14} aria-hidden="true" />{formatDate(boot.today)}</span></div>
      <header className="view-head explore-head">
        <div>
          <p className="eyebrow">CULTURE DESK · 공연 탐색</p>
          <h1 id="search-title">전국 주요 공연 검색<span>.</span></h1>
          <p className="view-sub">전국의 공연을 둘러보고, 지역을 체크해 원하는 무대를 찾아보세요.</p>
        </div>
        <div className="explore-head-actions">
          <a className="button button-primary map-discovery-link" href={display === 'map' ? '#search' : '#map'}>
            {display === 'map' ? <LayoutGrid size={20} aria-hidden="true" /> : <Map size={20} aria-hidden="true" />}
            {display === 'map' ? '공연 목록 보기' : '지도에서 보기'}<ArrowUpRight size={17} aria-hidden="true" />
          </a>
        </div>
      </header>

      <div className="search-overview">
        <span><Check size={15} aria-hidden="true" />전시 제외 · 공연 정보만</span>
        <span>KOPIS · 문화포털</span>
        <span>전국 {number(boot.cities.length)}개 지역 검색</span>
        <AutomaticRefreshLink />
      </div>

      {!hasData ? <SetupGuide /> : (
        <>
          <div className="explore-filter-bar">
            <div className="explore-region-bar">
              <RegionPicker cities={boot.cities} selected={filters.cities} onChange={cities => setFilters({ ...filters, cities })} emptyMeansAll />
              {filters.cities.length > 0 && <button className="text-button region-reset" type="button" onClick={() => setFilters({ ...filters, cities: [] })}>전국으로 초기화</button>}
            </div>
            <p className="region-search-help">미선택·전체 선택은 전국, 일부 선택은 해당 지역만 조회합니다.</p>
            <div className="search-toolbar">
              <label className="quick-search"><Search size={18} aria-hidden="true" /><span className="visually-hidden">공연명·공연장 검색</span><input type="search" value={filters.q} maxLength={200} placeholder="어떤 공연을 찾고 계신가요?" onChange={e => setFilters({ ...filters, q: e.target.value })} /></label>
              <div className="quick-period"><CalendarDays size={17} aria-hidden="true" /><label><span className="visually-hidden">빠른 조회 시작일</span><input type="date" value={filters.from} onChange={e => setFilters({ ...filters, from: e.target.value })} /></label><span className="muted">—</span><label><span className="visually-hidden">빠른 조회 종료일</span><input type="date" value={filters.to} onChange={e => setFilters({ ...filters, to: e.target.value })} /></label></div>
              <button type="button" className={`button filter-toggle${filtersOpen ? ' is-open' : ''}`} aria-expanded={filtersOpen} aria-controls="search-filters" onClick={() => setFiltersOpen(o => !o)}><SlidersHorizontal size={17} aria-hidden="true" />상세 조건{changed > 0 && <span className="filter-count">{changed}</span>}</button>
            </div>
          </div>
          <FilterPanel filters={filters} onChange={setFilters} onReset={() => setFilters(base)} open={filtersOpen} />

          <section className="results" aria-labelledby="results-title" aria-busy={loading}>
            <div className="results-head">
              <div>
                <p className="results-view-context">{nationwide ? '전국' : `${number(filters.cities.length)}개 지역`} · {display === 'map' ? '지도와 목록' : display === 'table' ? '표로 보기' : '목록으로 보기'}</p>
                <h2 id="results-title" aria-live="polite" aria-atomic="true">공연 목록 <span className="result-total">{result ? number(result.total) : '—'}</span></h2>
                {result && (
                  <p className="result-counts">
                    {SOURCES.map(s => (
                      <span key={s} className="nums">{sourceLabel(boot, s)} <strong>{number(result.sourceCounts[s] ?? 0)}</strong>건</span>
                    ))}
                    <span className="muted">출처 간 중복 포함 · 시작일 최신순</span>
                  </p>
                )}
              </div>
              <div className="results-actions">
                <div className="view-switch" role="group" aria-label="공연 보기 방식">
                  {([{ id: 'cards', label: '카드', Icon: LayoutGrid }, { id: 'table', label: '표', Icon: Table2 }, { id: 'map', label: '지도 + 목록', Icon: Map }] as const).map(({ id, label, Icon }) => <button key={id} type="button" aria-pressed={display === id} onClick={() => setDisplay(id)}><Icon size={17} aria-hidden="true" />{label}</button>)}
                </div>
                {loading && <span className="loading-inline" role="status"><LoaderCircle size={16} className="spin" aria-hidden="true" />불러오는 중</span>}
                <button type="button" className="button" onClick={() => void exportResults()} disabled={exporting || !!problem || !result} aria-busy={exporting}>
                  <FileSpreadsheet size={16} aria-hidden="true" />{exporting ? '내보내는 중…' : '엑셀 내보내기'}
                </button>
              </div>
            </div>

            {problem && <Callout tone="warn" title="검색 조건을 확인하세요">{problem}</Callout>}
            {error && !problem && (
              <Callout tone="danger" title="검색 결과를 불러오지 못했습니다"
                action={<button type="button" className="button button-small" onClick={() => setRetry(n => n + 1)}><RefreshCw size={14} aria-hidden="true" />다시 시도</button>}>
                {error}
              </Callout>
            )}

            {result && !problem && detailFilter && pending > 0 && (
              <Callout tone="warn" title={`부분 결과 · 상세 미수집 ${number(pending)}건은 관람료·연령 조건을 아직 판단하지 못했습니다`}
                action={boot.published ? undefined : (
                  <button type="button" className="button button-small" onClick={() => void requestDetails()} disabled={requesting || !!boot.fallback} aria-busy={requesting}>
                    <ListChecks size={14} aria-hidden="true" />상세 보충 요청
                  </button>
                )}>
                해당 공연은 표에서 빠져 있으며, 상세가 수집되면 조건에 맞는 공연이 추가됩니다.
                {progress.active > 0 && ` 진행 중인 수집 작업 ${number(progress.active)}개 · 남은 요청 ${number(progress.remaining)}건.`}
              </Callout>
            )}
            {result && !problem && result.partial && !(detailFilter && pending > 0) && (
              <details className="coverage-note">
                <summary>현재 수집된 공연 자료를 표시합니다 <span>수집 범위 안내</span></summary>
                <div><p>선택한 지역·기간 중 아직 수집하지 않은 범위가 있습니다. 결과가 없더라도 해당 지역에 공연이 없다는 뜻은 아닙니다.{progress.active > 0 && ` 현재 수집 ${number(progress.active)}개가 진행 중입니다.`}</p><button type="button" className="text-button" onClick={() => go('connection')}>{boot.published ? '갱신 상태 보기' : '공연 더 가져오기'}<ArrowUpRight size={14} aria-hidden="true" /></button></div>
              </details>
            )}
            {result && !problem && !detailFilter && pending > 0 && (
              <p className="inline-note">
                상세 미수집 {number(pending)}건 · 관람료·연령·출연진은 상세 수집 후 표시됩니다.
                {!boot.published && <button type="button" className="text-button" onClick={() => void requestDetails()} disabled={requesting || !!boot.fallback} aria-busy={requesting}>상세 보충 요청</button>}
              </p>
            )}

            {result && !problem && display === 'map' && <>
              <div className="map-result-layout">
                <PerformanceMap items={mapResult?.items ?? result.items} selectedCities={mapCities} focusedId={focusedId} onCity={id => setFilters({ ...filters, cities: [id] })} onFocus={setFocusedId} />
                <div className="map-results-column">
                  <div className="map-list-heading"><span>공연 둘러보기</span><span>{number(start)}–{number(end)} / {number(result.total)}건</span></div>
                  <div className="map-result-list">{result.items.map(p => <PerformanceCard key={p.id} item={p} compact active={focusedId === p.id} onLocate={() => setFocusedId(p.id)} />)}{!result.items.length && <div className="empty"><Search size={28} aria-hidden="true" /><h3>조건에 맞는 자료가 없습니다</h3><p>기간을 넓히거나 상세 조건을 조정해 보세요.</p><button type="button" className="button" onClick={() => setFilters(base)}>조건 초기화</button></div>}</div>
                </div>
              </div>
              <p className="map-scope-note">{mapResult ? `검색 결과 ${number(mapResult.items.length)}건 중 위치가 확인된 공연을 지도에 표시합니다.${mapResult.truncated ? ` 전체 ${number(mapResult.total)}건 중 일부를 조회했습니다. 지역·기간을 좁히면 나머지 공연도 확인할 수 있습니다.` : ''}` : mapFailed ? '전체 지도 자료를 불러오지 못해 현재 목록 페이지만 표시합니다.' : '공연장 위치를 불러오는 중입니다.'} 목록은 페이지 단위로 표시합니다.</p>
            </>}

            {result && !problem && display === 'cards' && result.items.length > 0 && <div className="performance-grid">{result.items.map(p => <PerformanceCard key={p.id} item={p} />)}</div>}

            {result && !problem && display !== 'map' && (result.items.length ? display === 'table' && (
              <div className="table-wrap">
                <table className="data-table search-table">
                  <caption className="visually-hidden">검색 결과 공연 목록 {result.page}페이지. 공연명 버튼으로 상세를 엽니다.</caption>
                  <thead>
                    <tr>
                      <th scope="col">도시</th>
                      <th scope="col">공연명</th>
                      <th scope="col">기간</th>
                      <th scope="col">장르</th>
                      <th scope="col">공연장</th>
                      <th scope="col">관람료</th>
                      <th scope="col">출처</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.items.map(p => (
                      <tr key={p.id}>
                        <td data-label="도시"><CityCell item={p} /></td>
                        <th scope="row" className="col-title"><TitleCell item={p} /></th>
                        <td data-label="기간"><PeriodCell item={p} /></td>
                        <td data-label="장르"><GenreCell item={p} /></td>
                        <td data-label="공연장"><VenueCell item={p} /></td>
                        <td data-label="관람료"><PriceCell item={p} /></td>
                        <td data-label="출처"><SourceCell item={p} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty">
                <h3>선택 조건의 등록 자료 0건</h3>
                <p>해당 도시에 공연이 없다는 뜻이 아닙니다. 수집한 API 자료 중 조건에 맞는 항목이 없거나, 아직 수집하지 않은 범위일 수 있습니다.</p>
                <ul className="empty-coverage">
                  {boot.sources.map(s => {
                    const state = sourceState(boot, s.source);
                    return <li key={s.source}><strong>{s.label}</strong> <Badge tone={state.tone}>{state.label}</Badge> 마지막 완료 수집 {formatDateTime(s.lastSync)}</li>;
                  })}
                </ul>
                {detailFilter && <p className="muted">관람료·연령 조건은 상세 수집이 끝난 공연만 판단합니다.</p>}
                <button type="button" className="button" onClick={() => go('connection')}>수집 범위 확인</button>
              </div>
            ))}

            {result && !problem && (
              <footer className="results-foot">
                <p className="muted nums">
                  {result.total ? `목록 행 ${number(start)}–${number(end)} / ${number(result.total)}` : '목록 행 0'} · 조회 시각 {formatDateTime(result.snapshotAt)}
                </p>
                <label className="field field-inline">
                  <span className="field-label">쪽당</span>
                  <select value={filters.limit} onChange={e => setFilters({ ...filters, limit: Number(e.target.value) })}>
                    {PAGE_SIZES.map(n => <option key={n} value={n}>{n}행</option>)}
                  </select>
                </label>
                <Pagination label="검색 결과 페이지" page={result.page} pages={result.pages} disabled={loading}
                  onPage={n => { setPageState({ key, page: n }); document.getElementById('results-title')?.scrollIntoView({ block: 'start' }); }} />
              </footer>
            )}
          </section>
          <div className="explore-sources"><SourceStrip /><p>자료의 최신 일정과 예매 조건은 공연 원문에서 확인하세요.</p></div>
        </>
      )}
    </section>
  );
}
