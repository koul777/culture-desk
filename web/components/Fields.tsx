import { useId } from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import type { City } from '../../shared/types';
import { PERIOD_PRESETS } from '../lib/format';
import { RegionPicker } from './RegionPicker';

export function CityChips({ cities, selected, onChange, legend, emptyMeansAll = false }: {
  cities: City[]; selected: string[]; onChange: (ids: string[]) => void; legend: string; emptyMeansAll?: boolean;
}) {
  return (
    <fieldset className="field-group">
      <legend>
        {legend}
        <span className="legend-meta">{emptyMeansAll && !selected.length ? '전국 조회' : `${selected.length}/${cities.length}곳 선택`}</span>
      </legend>
      <RegionPicker cities={cities} selected={selected} onChange={onChange} label={legend} emptyMeansAll={emptyMeansAll} />
    </fieldset>
  );
}

export function PeriodFields({ from, to, today, onChange, legend }: {
  from: string; to: string; today: string; legend: string; onChange: (range: { from: string; to: string }) => void;
}) {
  const id = useId();
  const active = PERIOD_PRESETS.find(p => { const r = p.range(today); return r.from === from && r.to === to; })?.id;
  const invalid = !!from && !!to && from > to;
  return (
    <fieldset className="field-group">
      <legend>{legend}</legend>
      <div className="period">
        <div className="period-dates">
          <label className="field" htmlFor={`${id}-from`}>
            <span className="field-label">시작일</span>
            <input id={`${id}-from`} type="date" value={from} required aria-invalid={invalid || !from}
              aria-describedby={invalid ? `${id}-error` : undefined}
              onChange={e => onChange({ from: e.target.value, to })} />
          </label>
          <span className="period-sep" aria-hidden="true">–</span>
          <label className="field" htmlFor={`${id}-to`}>
            <span className="field-label">종료일</span>
            <input id={`${id}-to`} type="date" value={to} required aria-invalid={invalid || !to}
              aria-describedby={invalid ? `${id}-error` : undefined}
              onChange={e => onChange({ from, to: e.target.value })} />
          </label>
        </div>
        <div className="presets" role="group" aria-label={`${legend} 바로가기`}>
          {PERIOD_PRESETS.map(p => (
            <button key={p.id} type="button" className="preset" aria-pressed={active === p.id} onClick={() => onChange(p.range(today))}>
              <span>{p.label}</span>
              <small>{p.hint}</small>
            </button>
          ))}
        </div>
      </div>
      {invalid && <p className="field-error" id={`${id}-error`}>시작일이 종료일보다 늦습니다.</p>}
    </fieldset>
  );
}

export function Pagination({ page, pages, onPage, label, disabled }: {
  page: number; pages: number; onPage: (page: number) => void; label: string; disabled?: boolean;
}) {
  if (pages <= 1) return null;
  const go = (n: number) => onPage(Math.min(pages, Math.max(1, n)));
  return (
    <nav className="pagination" aria-label={label}>
      <button type="button" className="icon-button" onClick={() => go(1)} disabled={disabled || page <= 1} aria-label="첫 페이지"><ChevronsLeft size={18} aria-hidden="true" /></button>
      <button type="button" className="icon-button" onClick={() => go(page - 1)} disabled={disabled || page <= 1} aria-label="이전 페이지"><ChevronLeft size={18} aria-hidden="true" /></button>
      <span className="nums" aria-live="polite">{page} / {pages} 페이지</span>
      <button type="button" className="icon-button" onClick={() => go(page + 1)} disabled={disabled || page >= pages} aria-label="다음 페이지"><ChevronRight size={18} aria-hidden="true" /></button>
      <button type="button" className="icon-button" onClick={() => go(pages)} disabled={disabled || page >= pages} aria-label="마지막 페이지"><ChevronsRight size={18} aria-hidden="true" /></button>
    </nav>
  );
}
