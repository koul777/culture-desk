import { ArrowUpRight, CalendarClock, CheckCheck, Clock3, RefreshCw } from 'lucide-react';
import { useDesk } from '../desk';
import { nextRefreshAt, refreshPresentation } from '../lib/automatic-refresh';
import { formatDateTime, formatPeriod, number } from '../lib/format';
import { Badge, Callout } from './Cells';
import '../automatic-refresh.css';

export function AutomaticRefreshLink() {
  const { boot } = useDesk();
  if (boot.fallback) return <a className="refresh-status-link is-delayed" href="#connection"><Clock3 size={13} aria-hidden="true" /><span>저장 자료 조회 · 갱신 중단</span><ArrowUpRight size={13} aria-hidden="true" /></a>;
  const refresh = boot.automaticRefresh;
  if (!refresh?.enabled) return null;
  const presentation = refreshPresentation(refresh);
  return <a className={`refresh-status-link${presentation.delayed ? ' is-delayed' : ''}`} href="#connection">
    <RefreshCw size={13} aria-hidden="true" />
    <span>{presentation.delayed ? '전국 갱신 지연' : presentation.label}</span>
    <span className="refresh-link-time">{refresh.lastSuccessAt ? `마지막 완료 ${formatDateTime(refresh.lastSuccessAt)}` : '첫 전국 완료 대기'}</span>
    <ArrowUpRight size={13} aria-hidden="true" />
  </a>;
}

export function AutomaticRefreshPanel() {
  const { boot } = useDesk();
  if (boot.fallback) return <section className="panel automatic-refresh-panel" aria-labelledby="automatic-refresh-title">
    <div className="panel-head"><h2 id="automatic-refresh-title"><CalendarClock size={20} aria-hidden="true" />전국 자동갱신</h2><Badge tone="warn">일시 중단</Badge></div>
    <div className="refresh-intro"><p>저장소 연결 제한으로 자동 갱신·추가 수집이 일시 중단되었습니다. {formatDateTime(boot.fallback.snapshotAt)} 기준 저장된 공연 정보를 조회할 수 있습니다.</p>
    <p className="muted">약 1분마다 저장소 연결을 다시 확인합니다. 복구되면 이 안내가 사라집니다.</p></div>
  </section>;
  const refresh = boot.automaticRefresh;
  if (!refresh) return null;
  const presentation = refreshPresentation(refresh);
  const next = nextRefreshAt(refresh);
  const counts = refresh.counts;
  return <section className="panel automatic-refresh-panel" aria-labelledby="automatic-refresh-title">
    <div className="panel-head">
      <h2 id="automatic-refresh-title"><CalendarClock size={20} aria-hidden="true" />전국 자동갱신</h2>
      <Badge tone={presentation.tone}>{presentation.label}</Badge>
    </div>
    <div className="refresh-intro">
      <p>{presentation.description}</p>
      {refresh.enabled && <p className="muted">브라우저를 닫아도 자동갱신은 계속됩니다. 완료하지 못한 구간은 예약된 복구 실행에서 이어집니다.</p>}
    </div>
    {presentation.delayed && <Callout tone="warn" title="전국 갱신이 지연되고 있습니다">마지막 전국 완료 후 36시간이 지났습니다. 아래 진행 상태를 확인하고, 최신 일정은 공연 원문도 함께 확인하세요.</Callout>}
    <dl className="refresh-facts">
      <div><dt><CheckCheck size={16} aria-hidden="true" />마지막 전국 완료</dt><dd>{refresh.lastSuccessAt ? formatDateTime(refresh.lastSuccessAt) : '아직 완료 기록 없음'}</dd></div>
      <div><dt><CalendarClock size={16} aria-hidden="true" />갱신 대상 기간</dt><dd>{refresh.from && refresh.to ? formatPeriod(refresh.from, refresh.to) : '실행 시 확인'}</dd></div>
      <div><dt><Clock3 size={16} aria-hidden="true" />{refresh.status === 'retry_wait' || refresh.status === 'failed' ? '다음 복구 예약' : '다음 실행 예약'}</dt><dd>{next ? formatDateTime(next) : refresh.enabled ? '상태 확인 후 안내' : '설정 없음'}</dd></div>
    </dl>
    {counts && <div className="refresh-progress">
      <div className="refresh-progress-head"><strong>수집 진행</strong><span className="nums">완료 구간 {number(counts.completeRuns)} / {number(counts.expectedRuns)}</span></div>
      <progress value={Math.min(counts.doneTasks, Math.max(1, counts.totalTasks))} max={Math.max(1, counts.totalTasks)} aria-label="전국 자동갱신 작업 진행" />
      <p className="refresh-progress-meta"><span>요청 {number(counts.doneTasks)} / {number(counts.totalTasks)}건</span><span>남은 요청 {number(counts.remaining)}건</span><span>수집 공연 {number(counts.performances)}건</span></p>
      {refresh.status === 'running' && <p className="muted small">새 목록을 확인하면서 전체 요청 수가 늘어날 수 있습니다.</p>}
    </div>}
    {refresh.error && refresh.status !== 'complete' && <p className="refresh-error" role="status">일부 요청을 완료하지 못했습니다. 원본 API 응답이나 연결 상태를 다음 실행에서 다시 확인합니다.</p>}
    <footer className="refresh-schedule">
      {refresh.enabled && <p>매일 {refresh.schedule.primary} · 미완료 시 {refresh.schedule.retries.join(' / ')} 복구 <span>(한국 시간 · 예약 실행은 지연될 수 있음)</span></p>}
      <p>상태 확인 {formatDateTime(refresh.updatedAt)}</p>
    </footer>
  </section>;
}
