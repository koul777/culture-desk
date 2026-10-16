import type { ReactNode } from 'react';
import { CircleAlert, Info, TriangleAlert } from 'lucide-react';
import type { Performance } from '../../shared/types';
import { useDesk } from '../desk';
import {
  STATUS_LABEL, cityName, formatPeriod, genreText, priceSummary, showStatus, sourceLabel, type Tone,
} from '../lib/format';

export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return <span className={`badge badge-${tone}`} title={title}>{children}</span>;
}

const CALLOUT_ICON = { info: Info, warn: TriangleAlert, danger: CircleAlert };
export function Callout({ tone = 'info', title, children, action }: {
  tone?: 'info' | 'warn' | 'danger'; title?: ReactNode; children?: ReactNode; action?: ReactNode;
}) {
  const Icon = CALLOUT_ICON[tone];
  return (
    <div className={`callout callout-${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      <Icon size={18} aria-hidden="true" className="callout-icon" />
      <div className="callout-text">
        {title && <strong>{title}</strong>}
        {children && <div>{children}</div>}
      </div>
      {action && <div className="callout-action">{action}</div>}
    </div>
  );
}

export function DetailStateBadge({ item }: { item: Performance }) {
  if (item.detailState === 'complete') return null;
  return item.detailState === 'failed'
    ? <Badge tone="danger">상세 수집 실패</Badge>
    : <Badge tone="warn">상세 미수집</Badge>;
}

export function TitleCell({ item, extra }: { item: Performance; extra?: ReactNode }) {
  const { openDetail } = useDesk();
  return (
    <div className="title-cell">
      <button type="button" className="title-button" onClick={() => openDetail(item.id)}>
        {item.title || '제목 미상'}
      </button>
      <div className="cell-meta">
        <DetailStateBadge item={item} />
        {extra}
      </div>
    </div>
  );
}

export function PeriodCell({ item }: { item: Performance }) {
  const { boot } = useDesk();
  const status = showStatus(item, boot.today);
  return (
    <div className="period-cell">
      <span className="nums">{formatPeriod(item.startDate, item.endDate)}</span>
      {status && <Badge tone={status === 'ongoing' ? 'accent' : status === 'upcoming' ? 'ok' : 'neutral'}>{STATUS_LABEL[status]}</Badge>}
    </div>
  );
}

export function GenreCell({ item }: { item: Performance }) {
  const g = genreText(item);
  return (
    <div className="stack">
      <span className={g.main === '장르 미상' ? 'missing' : undefined}>{g.main}</span>
      {g.sub && <small className="muted">{g.sub}</small>}
    </div>
  );
}

export function PriceCell({ item }: { item: Performance }) {
  const p = priceSummary(item);
  return (
    <div className="stack price-cell">
      <span className={p.missing ? 'missing' : 'clamp-2'} title={p.missing ? undefined : p.text}>{p.text}</span>
      {p.tag && <small className="muted">{p.tag}</small>}
    </div>
  );
}

export function VenueCell({ item }: { item: Performance }) {
  return item.venue.trim()
    ? <span className="clamp-2" title={item.venue}>{item.venue}</span>
    : <span className="missing">공연장 미상</span>;
}

export function CityCell({ item }: { item: Performance }) {
  const { boot } = useDesk();
  return <span className="nowrap">{cityName(boot, item.cityId)}</span>;
}

export function SourceCell({ item }: { item: Performance }) {
  const { boot } = useDesk();
  return <span className={`source source-${item.source}`}>{sourceLabel(boot, item.source)}</span>;
}

