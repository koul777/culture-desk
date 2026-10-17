import { Archive, Database, LoaderCircle, Map, MapPin, Power, Search, Theater } from 'lucide-react';
import { useDesk } from '../desk';
import { number } from '../lib/format';
import type { View } from '../lib/hooks';
import { activeSummary } from '../lib/runs';

export function Sidebar({ view }: { view: View }) {
  const { boot, backup, shutdown, isBusy } = useDesk();
  const progress = activeSummary(boot.runs);
  const keys = boot.sources.filter(s => s.configured).length;
  const cloud = boot.deployment === 'cloud';
  const items: { id: View; label: string; Icon: typeof Search; meta: string; metaLabel: string }[] = [
    { id: 'search', label: '공연 찾기', Icon: Search, meta: '', metaLabel: '' },
    { id: 'map', label: '지도 보기', Icon: Map, meta: '', metaLabel: '' },
    {
      id: 'connection', label: '데이터 연결', Icon: Database,
      meta: boot.published ? '매일 갱신' : progress.active ? '수집 중' : `키 ${keys}/${boot.sources.length}`,
      metaLabel: boot.published ? '매일 자동갱신' : progress.active ? '수집 진행 중' : `인증키 ${keys}개 설정됨`,
    },
  ];
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true"><Theater size={25} strokeWidth={1.6} /></span>
        <div className="brand-text">
          <strong>Culture Desk</strong>
          <span>전국 주요 공연 검색</span>
        </div>
      </div>
      <p className="nav-section-label">공연 정보</p>
      <nav className="nav" aria-label="주요 화면">
        <ul>
          {items.map(({ id, label, Icon, meta, metaLabel }) => (
            <li key={id}>
              <a href={`#${id}`} aria-current={view === id || (id === 'search' && view === 'table') ? 'page' : undefined}>
                <Icon size={18} aria-hidden="true" />
                <span className="nav-label">{label}</span>
                {meta && <span className={`nav-meta${id === 'connection' && progress.active ? ' is-active' : ''}`} aria-label={metaLabel}>{meta}</span>}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <p className="sidebar-region-note">전국 {number(boot.cities.length)}개 지역<br /><span>지역 체크로 목록을, 지도로 위치를.</span></p>
      <p className="sidebar-status">
        {progress.active
          ? <><LoaderCircle size={14} aria-hidden="true" className="spin" />수집 {number(progress.active)}개 진행 · 남은 요청 {number(progress.remaining)}건</>
          : <><span className="sidebar-status-dot" />공연 검색 준비 완료</>}
      </p>
      <div className="sidebar-foot">
        {!cloud && <><button type="button" className="button button-quiet" onClick={() => void backup()} disabled={isBusy('backup')} aria-busy={isBusy('backup')}>
          <Archive size={16} aria-hidden="true" />자료 백업
        </button>
        <button type="button" className="button button-quiet" onClick={() => void shutdown()} disabled={isBusy('shutdown')} aria-busy={isBusy('shutdown')}>
          <Power size={16} aria-hidden="true" />프로그램 종료
        </button></>}
        <span className="sidebar-foot-note"><MapPin size={12} aria-hidden="true" />전국 주요 공연 검색</span>
      </div>
    </aside>
  );
}
