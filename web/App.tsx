import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import type { Bootstrap, City, Performance } from '../shared/types';
import { api, ApiError, errorText } from './api';
import { DeskContext, type Desk, type ItemPatch } from './desk';
import { loadFilters, saveFilters, type FilterState } from './lib/filters';
import { createBootstrapRefresh, preserveCityReference } from './lib/bootstrap-refresh';
import { formatDateTime, isActive, number, sourceLabel } from './lib/format';
import { snapshotAvailability } from './lib/snapshot-availability';
import { useBusy, useHashView, useInterval } from './lib/hooks';
import { Callout } from './components/Cells';
import { ConnectionView } from './components/ConnectionView';
import { DetailDialog } from './components/DetailDialog';
import { ConfirmProvider, useConfirm } from './components/Modal';
import { NoticeProvider, useNotify } from './components/Notices';
import { SearchView } from './components/SearchView';
import { Sidebar } from './components/Sidebar';

const ACTIVE_POLL_MS = 3000;
const IDLE_POLL_MS = 60000;
const POLL_COALESCE_MS = 1000;

export function App() {
  return (
    <NoticeProvider>
      <ConfirmProvider>
        <CultureDesk />
      </ConfirmProvider>
    </NoticeProvider>
  );
}

function CultureDesk() {
  const notify = useNotify();
  const confirm = useConfirm();
  const { run, is } = useBusy();
  const [view, go] = useHashView();
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [fallback, setFallback] = useState(snapshotAvailability.get);
  const [filters, setFilterState] = useState<FilterState | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [patch, setPatch] = useState<ItemPatch | null>(null);
  const [ended, setEnded] = useState(false);
  const [syncBlocked,setSyncBlocked] = useState(false);
  const [syncError,setSyncError] = useState<string | null>(null);
  const patchSeq = useRef(0);
  const ticking = useRef(false);

  const bootstrapReads = useMemo(() => createBootstrapRefresh(async () => {
    const next = await api.bootstrap();
    setBoot(previous => preserveCityReference(previous, next));
    setBootError(null);
    return next;
  }), []);
  const readBootstrap = useCallback(async (fresh: boolean) => {
    try {
      return await (fresh ? bootstrapReads.fresh() : bootstrapReads.shared());
    } catch (e) {
      setBootError(errorText(e));
      return undefined;
    }
  }, [bootstrapReads]);
  // User reconnects and reads after mutations must not join a stale, already-started poll.
  const refresh = useCallback(() => readBootstrap(true), [readBootstrap]);
  const pollBootstrap = useCallback(() => readBootstrap(false), [readBootstrap]);

  useEffect(() => snapshotAvailability.subscribe(setFallback), []);
  useEffect(() => { void pollBootstrap(); }, [pollBootstrap]);
  useEffect(() => { if (boot && !filters) setFilterState(loadFilters(boot)); }, [boot, filters]);

  const active = !fallback && (boot?.runs.some(isActive) ?? false);
  const cloud = boot?.deployment === 'cloud';
  // Scheduled nationwide refresh runs independently. The browser only advances manual jobs,
  // which a published (read-only) deployment does not have.
  const browserTickEnabled = cloud && !fallback && !boot?.published && (!boot?.automaticRefresh?.enabled || active);
  const tick = useCallback(async () => {
    if(!browserTickEnabled || snapshotAvailability.get() || ticking.current || document.hidden || syncBlocked) return;
    ticking.current=true;
    try { await api.cloudTick(); await refresh(); }
    catch(e) {
      if(snapshotAvailability.get()) return;
      if(e instanceof ApiError && e.status===507) {setSyncBlocked(true);setSyncError(errorText(e));}
      else setBootError(errorText(e));
    }
    finally { ticking.current=false; }
  },[refresh,syncBlocked,browserTickEnabled]);
  useEffect(()=>{if(browserTickEnabled)void tick();},[browserTickEnabled,tick]);
  useInterval(()=>{void tick();},browserTickEnabled&&!syncBlocked ? active ? 3000 : 60000 : null);
  // Collection progress is polled every 3 s; otherwise a slow check picks up scheduled refreshes.
  const pollInterval = active ? ACTIVE_POLL_MS : IDLE_POLL_MS;
  useInterval(() => {
    // Only skip adjacent reads; response latency must not turn the normal 3 s cadence into 6 s.
    if ((active || !document.hidden) && bootstrapReads.isDue(POLL_COALESCE_MS)) void pollBootstrap();
  }, ended || !boot ? null : pollInterval);
  useEffect(() => {
    const onVisible = () => { if (!document.hidden && !ended) void pollBootstrap(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [pollBootstrap, ended]);

  // Move focus to the new view's content for keyboard and screen-reader users.
  const mainRef = useRef<HTMLElement>(null);
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) { firstView.current = false; return; }
    mainRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [view]);

  const setFilters = useCallback((next: FilterState) => { setFilterState(next); saveFilters(next); }, []);
  const publish = useCallback((item: Performance) => { patchSeq.current += 1; setPatch({ item, seq: patchSeq.current }); }, []);

  const reloadConfig = useCallback(async () => {
    await run('config:reload', async () => {
      try {
        await api.reloadConfig();
        const next = await refresh();
        if (!next) return;
        const on = next.sources.filter(s => s.configured).map(s => sourceLabel(next, s.source));
        notify(on.length ? 'ok' : 'info', on.length ? `설정을 다시 읽었습니다. 키 설정됨: ${on.join(', ')}` : '설정을 다시 읽었습니다. 아직 설정된 인증키가 없습니다.');
      } catch (e) { notify('error', errorText(e)); }
    });
  }, [run, refresh, notify]);

  const backup = useCallback(async () => {
    await run('backup', async () => {
      try {
        if(cloud) return;
        const r = await api.backup();
        notify('ok', `백업을 만들었습니다: backups/${r.filename}`);
      } catch (e) { notify('error', errorText(e)); }
    });
  }, [run, notify, cloud]);

  const shutdown = useCallback(async () => {
    if(cloud) return;
    const working = boot?.runs.filter(isActive).length ?? 0;
    const ok = await confirm({
      title: 'Culture Desk를 종료할까요?',
      body: (
        <p>
          로컬 서버를 종료합니다.{working ? ` 진행 중인 수집 ${number(working)}개는 저장되어 다음 실행 때 이어서 진행합니다.` : ''}
          {' '}다시 사용하려면 시작 바로가기를 실행하세요.
        </p>
      ),
      confirmLabel: '종료', danger: true,
    });
    if (!ok) return;
    await run('shutdown', async () => {
      try { await api.shutdown(); setDetailId(null); setEnded(true); }
      catch (e) { notify('error', errorText(e)); }
    });
  }, [boot, confirm, run, notify, cloud]);

  const signature = useMemo(() => {
    if (!boot) return '';
    const complete = boot.runs.filter(r => r.state === 'complete').length;
    return [
      boot.sources.map(s => `${s.source}:${s.count}:${s.configured ? 1 : 0}`).join(','),
      boot.today, boot.pendingDetails, complete, boot.runs.filter(isActive).length,
      boot.published ? `published:${boot.published.snapshotAt}` : '',
      fallback ? `snapshot:${fallback.snapshotAt}` : 'live',
    ].join('|');
  }, [boot, fallback]);

  const desk = useMemo<Desk | null>(() => boot && {
    boot: { ...boot, fallback: fallback ?? undefined }, refresh, run, isBusy: is, openDetail: setDetailId, publish,
    reloadConfig, backup, shutdown, patch, go, signature,
  }, [boot, fallback, refresh, run, is, publish, reloadConfig, backup, shutdown, patch, go, signature]);

  if (ended) {
    return (
      <main className="standalone" tabIndex={-1}>
        <h1>Culture Desk를 종료했습니다</h1>
        <p>이 탭을 닫아도 됩니다. 다시 사용하려면 시작 바로가기(Start Culture Desk)를 실행하세요.</p>
        <p className="muted">진행 중이던 수집은 저장되어 있으며 다음 실행 때 이어서 진행합니다.</p>
      </main>
    );
  }
  if (!desk || !filters) {
    return (
      <main className="standalone">
        <h1>Culture Desk</h1>
        {bootError ? (
          <Callout tone="danger" title="프로그램 서버에 연결할 수 없습니다"
            action={<button type="button" className="button" onClick={() => void refresh()}><RefreshCw size={16} aria-hidden="true" />다시 연결</button>}>
            {bootError}
          </Callout>
        ) : <p className="loading-inline" role="status"><LoaderCircle size={16} aria-hidden="true" className="spin" />불러오는 중</p>}
      </main>
    );
  }

  const addCity = (city: City) => {
    if (!filters.cities.includes(city.id)) setFilters({ ...filters, cities: [...filters.cities, city.id] });
  };

  return (
    <DeskContext.Provider value={desk}>
      <button type="button" className="skip-link" onClick={() => mainRef.current?.focus()}>본문으로 건너뛰기</button>
      <div className="shell">
        <Sidebar view={view} />
        <main ref={mainRef} className="main" tabIndex={-1} aria-label="본문">
          {fallback && <Callout tone="warn" title="저장된 공연 자료로 조회 중입니다">
            저장소 연결 제한으로 {formatDateTime(fallback.snapshotAt)} 기준 저장 자료를 보여주고 있습니다. 자동 갱신·추가 수집은 일시 중단되었습니다. 검색·지역 선택·지도·3D·엑셀 내보내기는 계속 이용할 수 있습니다.
          </Callout>}
          {syncError && <Callout tone="danger" title="수동 수집을 멈췄습니다"
            action={<button type="button" className="button" onClick={()=>{setSyncError(null);setSyncBlocked(false);}}>한도 조정 후 다시 시도</button>}>{syncError}</Callout>}
          {bootError && (
            <Callout tone="danger" title="서버 연결이 끊겼습니다. 표시 중인 내용은 마지막으로 받은 자료입니다."
              action={<button type="button" className="button button-small" onClick={() => void refresh()}><RefreshCw size={14} aria-hidden="true" />다시 연결</button>}>
              {bootError}
            </Callout>
          )}
          {view !== 'connection' && <SearchView filters={filters} setFilters={setFilters} display={view === 'search' ? 'cards' : view} />}
          {view === 'connection' && <ConnectionView filters={filters} onCityAdded={addCity} />}
        </main>
      </div>
      {detailId !== null && <DetailDialog key={detailId} id={detailId} onClose={() => setDetailId(null)} />}
    </DeskContext.Provider>
  );
}
