import { useId } from 'react';
import { RotateCcw } from 'lucide-react';
import type { PriceType, Source } from '../../shared/types';
import { useDesk } from '../desk';
import type { FilterState } from '../lib/filters';
import { GENRES, PRICE_LABEL, SOURCES, STATUS_LABEL, formatDate, sourceLabel } from '../lib/format';
import { CityChips, PeriodFields } from './Fields';

const AGE_HINTS = ['전체', '7세', '8세', '12세', '13세', '15세', '19세'];

export function FilterPanel({ filters, onChange, onReset, open }: {
  filters: FilterState; onChange: (next: FilterState) => void; onReset: () => void; open: boolean;
}) {
  const { boot } = useDesk();
  const id = useId();
  const set = (patch: Partial<FilterState>) => onChange({ ...filters, ...patch });
  return (
    <form
      id="search-filters"
      className={`filters${open ? ' is-open' : ''}`}
      role="search"
      aria-label="공연 검색 조건"
      onSubmit={e => e.preventDefault()}
    >
      <div className="filters-top">
        <CityChips legend="지역" cities={boot.cities} selected={filters.cities} onChange={cities => set({ cities })} emptyMeansAll />
        <PeriodFields legend="조회 기간" from={filters.from} to={filters.to} today={boot.today} onChange={range => set(range)} />
      </div>
      <div className="filter-grid">
        <label className="field field-q" htmlFor={`${id}-q`}>
          <span className="field-label">제목·공연장</span>
          <input id={`${id}-q`} type="search" value={filters.q} maxLength={200} placeholder="예: 오케스트라, 문화예술회관"
            onChange={e => set({ q: e.target.value })} />
        </label>
        <label className="field" htmlFor={`${id}-genre`}>
          <span className="field-label">장르</span>
          <select id={`${id}-genre`} value={filters.genre} onChange={e => set({ genre: e.target.value })}>
            <option value="">전체 장르</option>
            {GENRES.map(g => <option key={g} value={g}>{g === '기타' ? '기타·장르 미상' : g}</option>)}
          </select>
        </label>
        <fieldset className="field segmented">
          <legend className="field-label">진행 상태 <small className="muted">오늘 {formatDate(boot.today)} 기준</small></legend>
          <div className="segments">
            {([['', '전체'], ...Object.entries(STATUS_LABEL)] as [FilterState['status'], string][]).map(([value, label]) => (
              <label key={value || 'all'} className="segment">
                <input type="radio" name={`${id}-status`} value={value} checked={filters.status === value} onChange={() => set({ status: value })} />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="field" htmlFor={`${id}-price`}>
          <span className="field-label">관람료 <small className="detail-flag">상세 정보 기준</small></span>
          <select id={`${id}-price`} value={filters.price} aria-describedby={`${id}-detail-hint`}
            onChange={e => set({ price: e.target.value as '' | PriceType })}>
            <option value="">전체</option>
            {(Object.keys(PRICE_LABEL) as PriceType[]).map(p => <option key={p} value={p}>{PRICE_LABEL[p]}</option>)}
          </select>
        </label>
        <label className="field" htmlFor={`${id}-age`}>
          <span className="field-label">관람 연령 <small className="detail-flag">상세 정보 기준</small></span>
          <input id={`${id}-age`} type="text" list={`${id}-ages`} value={filters.age} maxLength={50} placeholder="예: 전체, 12세"
            aria-describedby={`${id}-detail-hint`} onChange={e => set({ age: e.target.value })} />
          <datalist id={`${id}-ages`}>{AGE_HINTS.map(a => <option key={a} value={a} />)}</datalist>
        </label>
        <label className="field" htmlFor={`${id}-source`}>
          <span className="field-label">출처</span>
          <select id={`${id}-source`} value={filters.source} onChange={e => set({ source: e.target.value as '' | Source })}>
            <option value="">전체 출처</option>
            {SOURCES.map(s => <option key={s} value={s}>{sourceLabel(boot, s)}</option>)}
          </select>
        </label>
      </div>
      <div className="filters-foot">
        <p id={`${id}-detail-hint`} className="muted">
          관람료·관람 연령은 상세 수집이 끝난 공연만 판단합니다. 연령은 원문에 들어 있는 글자로 찾습니다. 정보 없음은 무료로 보지 않습니다.
        </p>
        <button type="button" className="text-button" onClick={onReset}>
          <RotateCcw size={14} aria-hidden="true" />조건 초기화
        </button>
      </div>
    </form>
  );
}
