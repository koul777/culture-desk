import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Box, ExternalLink, ImageOff, ListChecks, LoaderCircle, RefreshCw } from 'lucide-react';
import type { Performance } from '../../shared/types';
import { api, errorText } from '../api';
import { useDesk } from '../desk';
import {
  PRICE_LABEL, STATUS_LABEL, cityName, detailValue, formatDateTime, formatPeriod, genreText, safeUrl, showStatus, sourceLabel,
} from '../lib/format';
import { useInterval } from '../lib/hooks';
import { Badge, Callout, DetailStateBadge } from './Cells';
import { Modal } from './Modal';
import { useNotify } from './Notices';
import { canViewVenue3D, Venue3D } from './Venue3D';

const POLL_MS = 3000;
const MAX_POLLS = 100; // about five minutes, then the user can resume watching

function Poster({ item }: { item: Performance }) {
  const [failed, setFailed] = useState(false);
  const src = safeUrl(item.poster);
  if (!src || failed) {
    return (
      <div className="poster poster-empty">
        <ImageOff size={28} aria-hidden="true" />
        <span>{src ? '포스터를 불러올 수 없습니다' : item.detailState === 'pending' ? '상세 미수집 · 포스터 없음' : '포스터 정보 없음'}</span>
      </div>
    );
  }
  return <img className="poster" src={src} alt={`${item.title} 포스터`} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="detail-row"><dt>{label}</dt><dd>{children}</dd></div>;
}

function Value({ item, value, multiline }: { item: Performance; value: string; multiline?: boolean }) {
  const v = detailValue(item, value);
  return <span className={v.missing ? 'missing' : multiline ? 'pre-line' : undefined}>{v.text}</span>;
}

export function DetailDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const { boot, publish, run, isBusy, patch, refresh } = useDesk();
  const notify = useNotify();
  const [item, setItem] = useState<Performance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);
  const [polls, setPolls] = useState(0);
  const [show3D, setShow3D] = useState(false);
  const latest = useRef(id);
  latest.current = id;

  const load = async () => {
    try {
      const fresh = await api.performance(id);
      if (latest.current !== id) return null;
      setItem(fresh); setError(null);
      return fresh;
    } catch (e) { setError(errorText(e)); return null; }
  };
  useEffect(() => { setItem(null); setWatching(false); setShow3D(false); void load(); }, [id]);
  useEffect(() => { if (patch && patch.item.id === id) setItem(patch.item); }, [patch, id]);

  useInterval(async () => {
    if (polls >= MAX_POLLS) { setWatching(false); return; }
    setPolls(n => n + 1);
    const fresh = await load();
    if (fresh && fresh.detailState !== 'pending') {
      setWatching(false);
      publish(fresh);
      void refresh();
      notify(fresh.detailState === 'complete' ? 'ok' : 'error',
        fresh.detailState === 'complete' ? '상세 정보를 반영했습니다.' : '상세 정보를 가져오지 못했습니다. 데이터 연결에서 오류를 확인한 뒤 다시 요청하세요.');
    }
  }, watching ? POLL_MS : null);

  const source = item ? boot.sources.find(s => s.source === item.source) : undefined;
  const canRequest = !!source?.configured;
  const requestKey = `detail:${id}`;
  const requesting = isBusy(requestKey);
  const requestDetail = () => run(requestKey, async () => {
    try {
      await api.requestDetail(id);
      setPolls(0); setWatching(true);
      notify('info', '상세 보충을 요청했습니다. 3초마다 확인합니다.');
      void refresh();
    } catch (e) { notify('error', errorText(e)); }
  });

  const status = item ? showStatus(item, boot.today) : null;
  const genre = item ? genreText(item) : null;
  const link = item ? safeUrl(item.sourceUrl) : null;

  return (
    <><Modal
      open
      onClose={onClose}
      title={item ? item.title || '제목 미상' : error ? '공연 상세' : '공연 상세 불러오는 중'}
      subtitle={item && (
        <span className="detail-badges">
          <span className={`source source-${item.source}`}>{sourceLabel(boot, item.source)}</span>
          <span>{cityName(boot, item.cityId)}</span>
          {status && <Badge tone={status === 'ongoing' ? 'accent' : status === 'upcoming' ? 'ok' : 'neutral'}>{STATUS_LABEL[status]}</Badge>}
          <DetailStateBadge item={item} />
        </span>
      )}
      footer={item && (
        <>
          {canViewVenue3D(item) && <button type="button" className="button button-primary" onClick={() => setShow3D(true)}><Box size={17} aria-hidden="true" />공연장 3D로 보기</button>}
          {link
            ? <a className="button" href={link} target="_blank" rel="noopener noreferrer">원문 보기 <ExternalLink size={16} aria-hidden="true" /><span className="visually-hidden">(새 창)</span></a>
            : <span className="muted">원문 링크 없음</span>}
        </>
      )}
    >
      {error && !item && (
        <Callout tone="danger" title="상세를 불러오지 못했습니다"
          action={<button type="button" className="button button-small" onClick={() => void load()}><RefreshCw size={14} aria-hidden="true" />다시 시도</button>}>
          {error}
        </Callout>
      )}
      {!item && !error && <p className="loading-inline" role="status"><LoaderCircle size={16} className="spin" aria-hidden="true" />불러오는 중</p>}
      {item && (
        <div className="detail">
          {item.detailState !== 'complete' && (
            <Callout
              tone={item.detailState === 'failed' ? 'danger' : 'warn'}
              title={watching ? '상세 보충 진행 중' : item.detailState === 'failed' ? '상세 수집에 실패했습니다' : '상세 미수집'}
              action={!watching && canRequest ? (
                <button type="button" className="button button-small" onClick={() => void requestDetail()} disabled={requesting} aria-busy={requesting}>
                  <ListChecks size={14} aria-hidden="true" />{item.detailState === 'failed' ? '다시 요청' : '상세 정보 가져오기'}
                </button>
              ) : watching ? <span className="loading-inline"><LoaderCircle size={16} className="spin" aria-hidden="true" />3초마다 확인</span> : undefined}
            >
              {watching
                ? '수집 작업이 처리되면 이 화면에 바로 반영됩니다. 창을 닫아도 작업은 계속됩니다.'
                : !canRequest
                  ? `${source?.label ?? '해당 출처'} API 키가 설정되지 않아 상세를 요청할 수 없습니다. 아래 ‘상세 미수집’ 항목은 원문에 값이 없다는 뜻이 아닙니다.`
                  : polls >= MAX_POLLS
                    ? '아직 처리되지 않았습니다. 데이터 연결에서 수집 상태(한도 대기·중단 등)를 확인하세요.'
                    : '관람료·연령·출연진 등은 상세 수집 후 표시됩니다. ‘상세 미수집’은 원문에 값이 없다는 뜻이 아닙니다.'}
            </Callout>
          )}
          <div className="detail-grid">
            <Poster item={item} />
            <dl className="detail-list">
              <Row label="기간"><span className="nums">{formatPeriod(item.startDate, item.endDate)}</span></Row>
              <Row label="일시 원문"><Value item={item} value={item.schedule} multiline /></Row>
              <Row label="공연장">{item.venue || <span className="missing">공연장 미상</span>}{canViewVenue3D(item) && <button type="button" className="button button-small detail-venue-3d" onClick={() => setShow3D(true)}><Box size={14} aria-hidden="true" />3D로 보기</button>}</Row>
              <Row label="주소"><Value item={item} value={item.address} /></Row>
              <Row label="장르">
                <span className={genre?.main === '장르 미상' ? 'missing' : undefined}>{genre?.main}</span>
                {genre?.sub && <small className="muted"> · {genre.sub}</small>}
              </Row>
              <Row label="관람료">
                <Value item={item} value={item.price} multiline />
                {item.priceType !== 'unknown' && <small className="muted"> · {PRICE_LABEL[item.priceType]}</small>}
              </Row>
              <Row label="관람 연령"><Value item={item} value={item.age} /></Row>
              <Row label="공연 시간"><Value item={item} value={item.runtime} /></Row>
              <Row label="출연진"><Value item={item} value={item.cast} multiline /></Row>
              <Row label="제작"><Value item={item} value={item.producer} multiline /></Row>
              <Row label="주최"><Value item={item} value={item.organizer} multiline /></Row>
              <Row label="문의"><Value item={item} value={item.contact} /></Row>
              {item.status.trim() && <Row label="원문 상태">{item.status}</Row>}
              <Row label="자료 갱신"><span className="nums">{formatDateTime(item.updatedAt)}</span></Row>
            </dl>
          </div>
          {item.description.trim() && (
            <section className="detail-section" aria-labelledby={`desc-${item.id}`}>
              <h3 id={`desc-${item.id}`}>소개</h3>
              {/* Provider text is rendered as plain text, never as HTML. */}
              <p className="pre-line description">{item.description}</p>
            </section>
          )}
        </div>
      )}
    </Modal>{show3D && item && <Venue3D item={item} onClose={() => setShow3D(false)} />}</>
  );
}
