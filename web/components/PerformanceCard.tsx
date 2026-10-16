import { useState } from 'react';
import { ArrowUpRight, Box, CalendarDays, MapPin, Ticket, Theater } from 'lucide-react';
import type { Performance } from '../../shared/types';
import { useDesk } from '../desk';
import { cityName, formatPeriod, priceSummary, safeUrl, showStatus, STATUS_LABEL } from '../lib/format';
import { Badge, SourceCell } from './Cells';
import { canViewVenue3D, Venue3D } from './Venue3D';

export function PerformanceCard({ item, compact = false, active = false, onLocate }: {
  item: Performance; compact?: boolean; active?: boolean; onLocate?: () => void;
}) {
  const { boot, openDetail } = useDesk();
  const [imageFailed, setImageFailed] = useState(false);
  const [show3D, setShow3D] = useState(false);
  const poster = safeUrl(item.poster);
  const status = showStatus(item, boot.today);
  const price = priceSummary(item);
  return (
    <><article className={`performance-card${compact ? ' is-compact-card' : ''}${active ? ' is-map-selected' : ''}`}>
      <button className="card-art" type="button" onClick={() => openDetail(item.id)} aria-label={`${item.title} 상세 보기`}>
        {poster && !imageFailed
          ? <img src={poster} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setImageFailed(true)} />
          : <span className="card-art-empty"><Theater size={36} strokeWidth={1.3} aria-hidden="true" /><span>{item.genre}</span><small>포스터 정보 없음</small></span>}
        {!compact && <span className="card-city"><MapPin size={13} aria-hidden="true" />{cityName(boot, item.cityId)}</span>}
      </button>
      <div className="card-body">
        <div className="card-topline"><span className="card-genre">{item.genre}</span><span className="card-dot" aria-hidden="true">·</span><span className="card-region-name">{cityName(boot, item.cityId)}</span></div>
        <h3><button type="button" onClick={() => openDetail(item.id)}>{item.title || '제목 미상'}</button></h3>
        <div className="card-facts">
          <p className="card-date"><CalendarDays size={15} aria-hidden="true" /><span>{formatPeriod(item.startDate, item.endDate)}</span></p>
          <p><MapPin size={15} aria-hidden="true" /><span title={item.venue}>{item.venue || '공연장 정보 없음'}</span></p>
          <p><Ticket size={15} aria-hidden="true" /><span title={price.text}>{price.text}</span></p>
        </div>
        <div className="card-bottom">
          {status && <Badge tone={status === 'upcoming' ? 'ok' : status === 'ongoing' ? 'accent' : 'neutral'}>{STATUS_LABEL[status]}</Badge>}
          <SourceCell item={item} />
          {onLocate
            ? <button type="button" className="card-locate" onClick={onLocate} aria-label={`${item.title} 지도에서 보기`} title="지도에서 보기"><MapPin size={16} aria-hidden="true" /><span>지도 위치</span></button>
            : <button type="button" className="card-locate" onClick={() => openDetail(item.id)} aria-label={`${item.title} 상세 보기`}><span>상세 보기</span><ArrowUpRight size={17} aria-hidden="true" /></button>}
        </div>
        {canViewVenue3D(item) && <button type="button" className="card-3d-action" onClick={() => setShow3D(true)} aria-label={`${item.venue || '공연장'} 3D로 보기`}><Box size={16} aria-hidden="true" />공연장 3D 보기<ArrowUpRight size={14} aria-hidden="true" /></button>}
      </div>
    </article>{show3D && <Venue3D item={item} onClose={() => setShow3D(false)} />}</>
  );
}
