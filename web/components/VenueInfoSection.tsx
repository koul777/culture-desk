import type { ReactNode } from 'react';
import { ExternalLink, Navigation, Ticket } from 'lucide-react';
import type { Performance } from '../../shared/types';
import { directionLinks } from '../lib/directions';
import { safeUrl } from '../lib/format';
import { Badge } from './Cells';
import '../venue-info.css';

const seats = (n?: number) => n ? `${n.toLocaleString('ko-KR')}석` : '—';

function OutLink({ href, children, primary }: { href: string; children: ReactNode; primary?: boolean }) {
  return <a className={`button button-small${primary ? ' button-primary' : ''}`} href={href} target="_blank" rel="noopener noreferrer">
    {children}<span className="visually-hidden">(새 창)</span>
  </a>;
}

export function VenueInfoSection({ item }: { item: Performance }) {
  const route = directionLinks(item);
  const info = item.venueInfo;
  if (!route && !info) return null;
  const homepage = info?.homepage ? safeUrl(info.homepage) : null;
  const booking = (info?.booking ?? []).flatMap(b => { const url = safeUrl(b.url); return url ? [{ name: b.name, url }] : []; });
  const headingId = `venue-${item.id}`;
  return (
    <section className="detail-section venue-info" aria-labelledby={headingId}>
      <h3 id={headingId}>공연장 정보 · 오시는 길</h3>
      {route && <div className="venue-actions">
        <OutLink href={route.kakao} primary><Navigation size={14} aria-hidden="true" />{route.precise ? '카카오맵 길찾기' : '카카오맵에서 찾기'}</OutLink>
        <OutLink href={route.naver}>네이버지도에서 보기 <ExternalLink size={14} aria-hidden="true" /></OutLink>
      </div>}
      {route && <p className="muted venue-note">출발지는 지도 앱이 현재 위치로 설정합니다. 이 사이트는 위치 정보를 받지 않습니다.</p>}
      {info && info.halls.length > 0 && (
        <table className="venue-halls">
          <caption className="visually-hidden">{info.facility || item.venue} 공연장별 객석 규모</caption>
          <thead><tr><th scope="col">공연장</th><th scope="col">객석</th><th scope="col">장애인석</th></tr></thead>
          <tbody>{info.halls.map((hall, index) => (
            <tr key={`${index}-${hall.name}`} className={hall.current ? 'is-current' : undefined}>
              <th scope="row">{hall.name}{hall.current && info.halls.length > 1 && <> <Badge tone="accent">이 공연</Badge></>}</th>
              <td className="nums">{seats(hall.seats)}</td>
              <td className="nums">{seats(hall.disabledSeats)}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {info && !info.halls.length && info.seats && <p>객석 규모 <span className="nums">{seats(info.seats)}</span></p>}
      {info && info.amenities.length > 0 && <p className="venue-amenities"><span className="muted">편의시설</span> {info.amenities.join(' · ')}</p>}
      {(homepage || booking.length > 0) && <div className="venue-actions">
        {booking.map(b => <OutLink key={b.url} href={b.url}><Ticket size={14} aria-hidden="true" />{b.name} 예매·좌석</OutLink>)}
        {homepage && <OutLink href={homepage}>공연장 홈페이지 <ExternalLink size={14} aria-hidden="true" /></OutLink>}
      </div>}
      {info && <small className="muted">KOPIS 공연시설 자료 기준입니다. 좌석배치도는 공개 API로 제공되지 않아 예매처나 공연장 홈페이지에서 확인하세요. 실제 객석 수는 공연별 무대 구성에 따라 다를 수 있습니다.</small>}
    </section>
  );
}
