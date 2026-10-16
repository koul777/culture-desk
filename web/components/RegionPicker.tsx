import { useMemo, useState } from 'react';
import { ChevronDown, MapPin, Search, X } from 'lucide-react';
import type { City } from '../../shared/types';
import { number } from '../lib/format';
import { Modal } from './Modal';

const PROVINCE_ORDER = ['서울', '부산', '대구', '인천', '광주', '전남광주', '대전', '울산', '세종', '경기', '강원', '충청북', '충북', '충청남', '충남', '전라북', '전북', '전라남', '전남', '경상북', '경북', '경상남', '경남', '제주'];
const provinceRank = (name: string) => { const rank = PROVINCE_ORDER.findIndex(prefix => name.startsWith(prefix)); return rank < 0 ? 99 : rank; };
const shortProvince = (name: string) => name.replace(/특별자치도|특별자치시|통합특별시|특별시|광역시|도$/g, '');

export function RegionPicker({ cities, selected, onChange, label = '지역', emptyMeansAll = false }: {
  cities: City[]; selected: string[]; onChange: (ids: string[]) => void; label?: string; emptyMeansAll?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [province, setProvince] = useState('');
  const groups = useMemo(() => {
    const byProvince = new Map<string, City[]>();
    for (const city of cities) byProvince.set(city.sido, [...(byProvince.get(city.sido) ?? []), city]);
    return [...byProvince.entries()].map(([name, regions]) => ({ name, regions: regions.sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true })) }))
      .sort((a, b) => provinceRank(a.name) - provinceRank(b.name) || a.name.localeCompare(b.name, 'ko'));
  }, [cities]);
  const term = query.replace(/\s/g, '').toLocaleLowerCase();
  const matching = (city: City) => !term || [city.sido, city.name, city.sigungu, `${shortProvince(city.sido)}${city.name}`, ...city.aliases].some(s => s.replace(/\s/g, '').toLocaleLowerCase().includes(term));
  const visibleGroups = groups.map(g => ({ ...g, matches: g.regions.filter(matching) })).filter(g => g.matches.length);
  const active = visibleGroups.find(g => g.name === province) ?? visibleGroups[0];
  const chosen = cities.filter(c => selected.includes(c.id));
  const nationwide = chosen.length === cities.length || (emptyMeansAll && !chosen.length);
  const nationwideDraft = emptyMeansAll && (!draft.size || draft.size === cities.length);
  const start = () => { setDraft(new Set(selected)); setQuery(''); setProvince(''); setOpen(true); };
  const setGroup = (ids: string[], checked: boolean) => setDraft(previous => {
    const next = new Set(previous);
    for (const id of ids) { if (checked) next.add(id); else next.delete(id); }
    return next;
  });
  const groupCount = (regions: City[]) => regions.filter(c => draft.has(c.id)).length;
  return <>
    <div className="region-selection">
      <button type="button" className="button region-trigger" onClick={start} aria-haspopup="dialog">
        <MapPin size={18} aria-hidden="true" />{label} 선택<span className="region-trigger-count">{nationwide ? '전국' : number(chosen.length)}</span><ChevronDown size={14} aria-hidden="true" />
      </button>
      <div className="selected-regions" aria-label={`${label} 선택 요약`}>
        {nationwide && cities.length > 0
          ? <span className="region-all">전국 모든 지역</span>
          : chosen.slice(0, 4).map(city => <button type="button" className="selected-region" key={city.id} title={`${city.sido} ${city.sigungu}`} aria-label={`${city.sido} ${city.name} 선택 해제`} onClick={() => onChange(selected.filter(id => id !== city.id))}>{cities.some(c => c.id !== city.id && c.name === city.name) ? `${shortProvince(city.sido)} ${city.name}` : city.name}<X size={12} aria-hidden="true" /></button>)}
        {chosen.length > 4 && chosen.length !== cities.length && <button type="button" className="region-more" onClick={start}>외 {number(chosen.length - 4)}곳</button>}
        {!chosen.length && !emptyMeansAll && <span className="region-empty">수집할 지역을 체크하세요</span>}
      </div>
    </div>
    {open && <Modal open onClose={() => setOpen(false)} title="전국 지역 선택" subtitle={<p className="region-modal-sub">{emptyMeansAll ? '일부 지역을 체크하면 해당 지역만, 선택하지 않거나 모두 체크하면 전국을 조회합니다.' : '공연 정보를 수집할 시·도와 시·군·구를 체크하세요.'}</p>}
      footer={<><span className="region-selection-count" aria-live="polite">{nationwideDraft ? <><strong>전국 조회</strong>{draft.size > 0 && <small> · 전체 체크됨</small>}</> : <><strong>{number(draft.size)}</strong> / {number(cities.length)}곳 선택</>}</span><button type="button" className="button" onClick={() => setOpen(false)}>취소</button><button type="button" className="button button-primary" onClick={() => { onChange(cities.filter(c => draft.has(c.id)).map(c => c.id)); setOpen(false); }}>{nationwideDraft ? '전국 공연 보기' : `${number(draft.size)}곳 적용`}</button></>}>
      <div className="region-picker">
        <div className="region-picker-toolbar">
          <label className="region-search"><Search size={17} aria-hidden="true" /><span className="visually-hidden">시도·시군구 검색</span><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="시·도 또는 시·군·구 검색" autoFocus /></label>
          <div className="region-global-actions"><button type="button" className="text-button" onClick={() => setDraft(new Set(cities.map(c => c.id)))}>전국 전체 선택</button><button type="button" className="text-button" onClick={() => setDraft(new Set())}>모두 해제</button></div>
        </div>
        {active ? <div className="region-picker-columns">
          <nav className="province-list" aria-label="시도 선택">
            {visibleGroups.map(group => <button type="button" key={group.name} aria-pressed={active.name === group.name} onClick={() => setProvince(group.name)}><span>{group.name}</span><small>{groupCount(group.regions)}/{group.regions.length}</small></button>)}
          </nav>
          <div className="district-panel">
            <div className="district-head"><label className="region-check region-check-all"><input type="checkbox" checked={groupCount(active.regions) === active.regions.length} ref={el => { if (el) el.indeterminate = groupCount(active.regions) > 0 && groupCount(active.regions) < active.regions.length; }} onChange={e => setGroup(active.regions.map(c => c.id), e.target.checked)} /><span>{active.name} 전체</span></label><span>{active.regions.length}곳</span></div>
            <div className="district-list" role="group" aria-label={`${active.name} 시군구`}>
              {active.matches.map(city => <label className={`region-check${draft.has(city.id) ? ' is-selected' : ''}`} key={city.id}><input type="checkbox" checked={draft.has(city.id)} onChange={e => setGroup([city.id], e.target.checked)} /><span>{city.name}<small>{city.sigungu !== city.name ? city.sigungu : ''}</small></span></label>)}
            </div>
          </div>
        </div> : <div className="region-no-results"><Search size={26} aria-hidden="true" /><strong>일치하는 지역이 없습니다</strong><p>시·도 또는 시·군·구 이름으로 다시 찾아보세요.</p></div>}
      </div>
    </Modal>}
  </>;
}
