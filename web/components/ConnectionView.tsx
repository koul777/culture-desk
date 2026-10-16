import { useId, useMemo, useState, type FormEvent } from 'react';
import {
  Archive, ExternalLink, KeyRound, ListChecks, MapPin, Pause, Play, Plus, Power, RefreshCw, RotateCcw,
} from 'lucide-react';
import type { City, Source, SyncRun, SyncState } from '../../shared/types';
import { api, errorText, type CityInput } from '../api';
import { useDesk } from '../desk';
import type { FilterState } from '../lib/filters';
import {
  RUN_LABEL, RUN_TONE, canPause, canResume, chunkCount, cityName, formatDateTime, formatPeriod, isIsoDate, number, sourceLabel,
} from '../lib/format';
import { remainingTasks, sourceState } from '../lib/runs';
import { Badge, Callout } from './Cells';
import { CityChips, PeriodFields, Pagination } from './Fields';
import { useNotify } from './Notices';
import { AutomaticRefreshPanel } from './AutomaticRefresh';

const MAX_SPAN_MS = 366 * 5 * 86_400_000; // server limit per request
const RUNS_PER_PAGE = 20;
const STATE_ORDER: SyncState[] = ['running', 'queued', 'quota_wait', 'partial', 'paused', 'complete'];

function SourcesSection() {
  const { boot, reloadConfig, isBusy, run, refresh } = useDesk();
  const notify = useNotify();
  const cloud = boot.deployment === 'cloud';
  const reloading = isBusy('config:reload');
  const requestingAll = isBusy('details:all');
  const requestAll = () => run('details:all', async () => {
    try {
      const r = await api.requestDetails({});
      notify(r.queued ? 'ok' : 'info', r.queued ? `상세 보충 ${number(r.queued)}건을 작업에 추가했습니다.` : '새로 추가할 상세 보충 작업이 없습니다. 이미 대기 중이거나 API 키가 없는 출처입니다.');
      await refresh();
    } catch (e) { notify('error', errorText(e)); }
  });
  return (
    <section className="panel" aria-labelledby="sources-title">
      <div className="panel-head">
        <h2 id="sources-title">API 연결</h2>
        {!cloud && <button type="button" className="button" onClick={() => void reloadConfig()} disabled={reloading} aria-busy={reloading}>
          <RefreshCw size={16} aria-hidden="true" className={reloading ? 'spin' : undefined} />설정 다시 읽기
        </button>}
      </div>
      <div className="table-wrap">
        <table className="data-table compact">
          <caption className="visually-hidden">출처별 연결 상태</caption>
          <thead>
            <tr><th scope="col">출처</th><th scope="col">인증키</th><th scope="col">수집 상태</th><th scope="col">등록 자료</th><th scope="col">마지막 완료 수집</th><th scope="col">신청</th></tr>
          </thead>
          <tbody>
            {boot.sources.map(s => {
              const state = sourceState(boot, s.source);
              return (
                <tr key={s.source}>
                  <th scope="row">{s.label}</th>
                  <td data-label="인증키">{s.configured ? <Badge tone="ok">설정됨</Badge> : <Badge>미연결 · 키 없음</Badge>}</td>
                  <td data-label="수집 상태">
                    <Badge tone={boot.fallback ? 'warn' : state.tone}>{boot.fallback ? '저장소 제한 · 수집 중단' : state.label}</Badge>
                    {state.error && <small className="error-text">{state.error}</small>}
                  </td>
                  <td data-label="등록 자료" className="nums">{number(s.count)}건</td>
                  <td data-label="마지막 완료 수집" className="nums">{formatDateTime(s.lastSync)}</td>
                  <td data-label="신청">
                    <a href={s.applicationUrl} target="_blank" rel="noopener noreferrer" className="ext-link">
                      인증키 신청 <ExternalLink size={14} aria-hidden="true" /><span className="visually-hidden">(새 창)</span>
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="key-guide">
        <KeyRound size={18} aria-hidden="true" />
        <div>
          <p>
            {cloud ? '연결된 출처에서 선택한 지역과 기간의 공연 정보를 가져옵니다.' : <>키는 프로그램 폴더의 <code>.env</code> 파일에 <code>KOPIS_API_KEY</code>, <code>CULTURE_API_KEY</code>로 입력하고 ‘설정 다시 읽기’를 누릅니다. 키 값은 이 화면·응답·엑셀에 표시되지 않습니다.</>}
          </p>
          <p className="muted">‘설정됨’은 키가 입력되었다는 뜻입니다. 실제 연결은 해당 출처의 수집이 완료되어야 확인됩니다.</p>
        </div>
      </div>
      <p className="inline-note">
        상세 미수집 {number(boot.pendingDetails)}건 · 전시 등 제외 {number(boot.excludedCount)}건 · 분류 검토 대기 {number(boot.reviewCount)}건
        <span className="muted"> (제외·검토 대기는 기본 검색 결과에 넣지 않습니다)</span>
        {boot.pendingDetails > 0 && (
          <button type="button" className="text-button" onClick={() => void requestAll()} disabled={requestingAll || !!boot.fallback} aria-busy={requestingAll}>
            <ListChecks size={14} aria-hidden="true" />전체 상세 보충 요청
          </button>
        )}
      </p>
    </section>
  );
}

function SyncSection({ filters }: { filters: FilterState }) {
  const { boot, run, isBusy, refresh } = useDesk();
  const notify = useNotify();
  const configured = boot.sources.filter(s => s.configured).map(s => s.source);
  const [cities, setCities] = useState<string[]>(() => filters.cities.length ? filters.cities : boot.cities.map(c => c.id));
  // Track opt-outs so a source configured later (after 설정 다시 읽기) is selected by default.
  const [off, setOff] = useState<Source[]>([]);
  const [range, setRange] = useState({ from: filters.from, to: filters.to });
  const chosen = configured.filter(s => !off.includes(s));
  const chunks = chunkCount(range.from, range.to);
  const listRequests = cities.length * chosen.length * chunks;
  const problem = !configured.length ? '인증키가 설정된 출처가 없습니다. 위의 안내대로 키를 입력하고 설정을 다시 읽으세요.'
    : !chosen.length ? '수집할 출처를 선택하세요.'
      : !cities.length ? '수집할 도시를 1개 이상 선택하세요.'
        : !isIsoDate(range.from) || !isIsoDate(range.to) ? '수집 기간을 입력하세요.'
          : range.from > range.to ? '시작일이 종료일보다 늦습니다.'
            : Date.parse(range.to) - Date.parse(range.from) > MAX_SPAN_MS ? '한 번에 최대 5년 범위까지 수집할 수 있습니다. 기간을 나누어 주세요.'
              : null;
  const starting = isBusy('sync:start');
  const toggleSource = (s: Source) => setOff(list => (list.includes(s) ? list.filter(x => x !== s) : [...list, s]));
  const start = (e: FormEvent) => {
    e.preventDefault();
    if (problem) return;
    void run('sync:start', async () => {
      try {
        const r = await api.startSync({ cities, sources: chosen, from: range.from, to: range.to });
        const skipped = r.skipped.map(s => sourceLabel(boot, s)).join('·');
        notify('ok', `수집 작업 ${number(r.runs.length)}개를 등록했습니다. 같은 범위의 미완료 작업은 이어서 진행합니다.${skipped ? ` 키가 없어 건너뜀: ${skipped}` : ''}`);
        await refresh();
      } catch (err) { notify('error', errorText(err)); }
    });
  };
  return (
    <section className="panel" aria-labelledby="sync-title">
      <div className="panel-head">
        <h2 id="sync-title">지역·기간 직접 수집</h2>
        <button type="button" className="text-button" onClick={() => { setCities(filters.cities.length ? filters.cities : boot.cities.map(c => c.id)); setRange({ from: filters.from, to: filters.to }); }}>
          검색 조건의 도시·기간 가져오기
        </button>
      </div>
      {boot.fallback ? <p className="manual-sync-note">저장소 연결이 복구되면 추가 수집을 다시 이용할 수 있습니다. 현재는 저장된 자료를 조회하는 상태입니다.</p> : boot.deployment === 'cloud' && <p className="manual-sync-note">아래에서 직접 시작한 수집은 이 화면을 열어두어야 진행됩니다. 완료한 구간은 저장되며 다음 접속에서 이어집니다.{boot.automaticRefresh?.enabled && ' 전국 자동갱신은 이 화면과 관계없이 별도로 실행됩니다.'}</p>}
      <form className="sync-form" onSubmit={start} noValidate>
        <CityChips legend="수집 도시" cities={boot.cities} selected={cities} onChange={setCities} />
        <PeriodFields legend="수집 기간" from={range.from} to={range.to} today={boot.today} onChange={setRange} />
        <fieldset className="field-group">
          <legend>출처</legend>
          <div className="checks">
            {boot.sources.map(s => (
              <label key={s.source} className={`check${s.configured ? '' : ' is-disabled'}`}>
                <input type="checkbox" checked={chosen.includes(s.source)} disabled={!s.configured} onChange={() => toggleSource(s.source)} />
                <span>{s.label}</span>
                {!s.configured && <small className="muted">키 없음</small>}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="estimate" aria-live="polite">
          <h3>예상 작업량</h3>
          <p className="nums">
            목록 요청 최소 <strong>{number(listRequests)}</strong>건
            <span className="muted"> = 도시 {cities.length}곳 × 출처 {chosen.length}개 × 31일 구간 {number(chunks)}개</span>
          </p>
          <p className="muted">
            한 구간이 여러 페이지면 요청이 늘고, 수집된 공연마다 상세 요청이 추가됩니다. 소요 시간은 실제 수집 기록이 쌓인 뒤 판단하세요.
            제공기관 호출 한도에 닿으면 ‘한도 대기’로 멈추고 재개할 수 있습니다.
          </p>
        </div>
        {problem && <p className="field-error" role="alert">{problem}</p>}
        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={!!problem || starting || !!boot.fallback} aria-busy={starting}>
            <Play size={16} aria-hidden="true" />{starting ? '등록 중…' : '수집 시작'}
          </button>
        </div>
      </form>
    </section>
  );
}

function RunsSection() {
  const { boot, run, isBusy, refresh } = useDesk();
  const notify = useNotify();
  const [page, setPage] = useState(1);
  const [stateFilter, setStateFilter] = useState<SyncState | ''>('');
  const counts = useMemo(() => {
    const c = Object.fromEntries(STATE_ORDER.map(s => [s, 0])) as Record<SyncState, number>;
    for (const r of boot.runs) c[r.state] += 1;
    return c;
  }, [boot.runs]);
  const runs = stateFilter ? boot.runs.filter(r => r.state === stateFilter) : boot.runs;
  const pages = Math.max(1, Math.ceil(runs.length / RUNS_PER_PAGE));
  const current = Math.min(page, pages);
  const shown = runs.slice((current - 1) * RUNS_PER_PAGE, current * RUNS_PER_PAGE);
  const pausable = boot.runs.filter(canPause);
  const resumable = boot.runs.filter(canResume);

  const act = (r: SyncRun, action: 'pause' | 'resume') => run(`run:${r.id}`, async () => {
    try {
      await (action === 'pause' ? api.pauseRun(r.id) : api.resumeRun(r.id));
      notify('ok', `${sourceLabel(boot, r.source)} ${cityName(boot, r.cityId)} 수집을 ${action === 'pause' ? '중단' : '재개'}했습니다.`);
      await refresh();
    } catch (e) { notify('error', errorText(e)); }
  });
  const bulk = (action: 'pause' | 'resume') => run('runs:bulk', async () => {
    const targets = action === 'pause' ? pausable : resumable;
    let done = 0; let failed = '';
    for (const r of targets) {
      try { await (action === 'pause' ? api.pauseRun(r.id) : api.resumeRun(r.id)); done += 1; }
      catch (e) { failed = errorText(e); break; }
    }
    await refresh();
    if (failed) notify('error', `${number(done)}개 처리 후 중단되었습니다: ${failed}`);
    else notify('ok', `수집 작업 ${number(done)}개를 ${action === 'pause' ? '중단' : '재개'}했습니다.`);
  });
  const bulkBusy = isBusy('runs:bulk');

  return (
    <section className="panel" aria-labelledby="runs-title">
      <div className="panel-head">
        <h2 id="runs-title">수집 상태</h2>
        <div className="head-actions">
          <button type="button" className="button" onClick={() => void bulk('pause')} disabled={!pausable.length || bulkBusy || !!boot.fallback} aria-busy={bulkBusy}>
            <Pause size={16} aria-hidden="true" />진행 중 모두 중단 ({number(pausable.length)})
          </button>
          <button type="button" className="button" onClick={() => void bulk('resume')} disabled={!resumable.length || bulkBusy || !!boot.fallback} aria-busy={bulkBusy}>
            <RotateCcw size={16} aria-hidden="true" />중단·실패·한도 대기 모두 재개 ({number(resumable.length)})
          </button>
        </div>
      </div>
      {!boot.runs.length ? (
        <p className="empty-line">아직 수집 기록이 없습니다. 위에서 도시·기간·출처를 정하고 수집을 시작하세요.</p>
      ) : (
        <>
          <div className="state-filter" role="group" aria-label="수집 상태로 거르기">
            <button type="button" className="preset" aria-pressed={!stateFilter} onClick={() => { setStateFilter(''); setPage(1); }}>전체 {number(boot.runs.length)}</button>
            {STATE_ORDER.filter(s => counts[s]).map(s => (
              <button key={s} type="button" className="preset" aria-pressed={stateFilter === s} onClick={() => { setStateFilter(s); setPage(1); }}>
                {RUN_LABEL[s]} {number(counts[s])}
              </button>
            ))}
          </div>
          <p className="muted small">최근 {number(boot.runs.length)}개 실행을 표시합니다. 도시·기간 수집과 상세 보충을 구분해 기록합니다. {boot.fallback ? '저장소 연결은 약 1분마다 다시 확인합니다.' : '진행 중이면 3초마다 갱신합니다.'}</p>
          <div className="table-wrap">
            <table className="data-table compact runs-table">
              <caption className="visually-hidden">수집 실행 목록</caption>
              <thead>
                <tr>
                  <th scope="col">출처</th><th scope="col">도시</th><th scope="col">기간</th><th scope="col">상태</th>
                  <th scope="col">작업 진행</th><th scope="col">공연 · 제외 · 검토</th><th scope="col">갱신</th><th scope="col">동작</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(r => {
                  const busy = isBusy(`run:${r.id}`) || bulkBusy;
                  return (
                    <tr key={r.id}>
                      <th scope="row">{sourceLabel(boot, r.source)}<small className="muted nums"> #{r.id}</small><small className="muted">{r.detailOnly ? '상세 보충' : '도시·기간 수집'}</small></th>
                      <td data-label="도시">{cityName(boot, r.cityId)}</td>
                      <td data-label="기간" className="nums">{formatPeriod(r.from, r.to)}</td>
                      <td data-label="상태">
                        <Badge tone={RUN_TONE[r.state]}>{RUN_LABEL[r.state]}</Badge>
                        {r.error && <small className="error-text">{r.error}</small>}
                      </td>
                      <td data-label="작업 진행">
                        <div className="progress-cell">
                          <progress max={Math.max(1, r.tasksTotal)} value={r.tasksDone} aria-label={`${cityName(boot, r.cityId)} 작업 진행률`} />
                          <span className="nums">{number(r.tasksDone)}/{number(r.tasksTotal)}{r.tasksFailed ? ` · 실패 ${number(r.tasksFailed)}` : ''}{remainingTasks(r) && r.state !== 'complete' ? ` · 남음 ${number(remainingTasks(r))}` : ''}</span>
                        </div>
                      </td>
                      <td data-label="공연 · 제외 · 검토" className="nums">{number(r.items)} · {number(r.excluded)} · {number(r.review)}</td>
                      <td data-label="갱신" className="nums">{formatDateTime(r.updatedAt)}</td>
                      <td data-label="동작">
                        {canPause(r) && (
                          <button type="button" className="button button-small" onClick={() => void act(r, 'pause')} disabled={busy || !!boot.fallback} aria-busy={busy}>
                            <Pause size={14} aria-hidden="true" />중단
                          </button>
                        )}
                        {canResume(r) && (
                          <button type="button" className="button button-small" onClick={() => void act(r, 'resume')} disabled={busy || !!boot.fallback} aria-busy={busy}>
                            <Play size={14} aria-hidden="true" />{r.state === 'partial' ? '실패 구간 재시도' : '재개'}
                          </button>
                        )}
                        {r.state === 'complete' && <span className="muted">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <footer className="results-foot">
            <Pagination label="수집 실행 페이지" page={current} pages={pages} onPage={setPage} />
          </footer>
        </>
      )}
    </section>
  );
}

const EMPTY_CITY: CityInput = { name: '', sido: '', sigungu: '', kopisSido: '', kopisSigungu: '' };
function cityProblems(c: CityInput, cities: City[]): Partial<Record<keyof CityInput, string>> {
  const p: Partial<Record<keyof CityInput, string>> = {};
  if (!c.name.trim()) p.name = '도시명을 입력하세요.';
  if (!c.sido.trim()) p.sido = '시도를 입력하세요.';
  if (!c.sigungu.trim()) p.sigungu = '시군구를 입력하세요.';
  else if (cities.some(x => x.sido === c.sido.trim() && x.sigungu === c.sigungu.trim())) p.sigungu = '이미 등록된 도시입니다.';
  if (!/^\d{2}$/.test(c.kopisSido)) p.kopisSido = '숫자 2자리로 입력하세요.';
  if (!/^\d{4}$/.test(c.kopisSigungu)) p.kopisSigungu = '숫자 4자리로 입력하세요.';
  else if (/^\d{2}$/.test(c.kopisSido) && !c.kopisSigungu.startsWith(c.kopisSido)) p.kopisSigungu = '구군 코드 앞 2자리는 시도 코드와 같아야 합니다.';
  return p;
}

function CitySection({ onAdded }: { onAdded: (city: City) => void }) {
  const { boot, run, isBusy, refresh } = useDesk();
  const notify = useNotify();
  const id = useId();
  const [showCatalog,setShowCatalog] = useState(false);
  const [form, setForm] = useState<CityInput>(EMPTY_CITY);
  const [touched, setTouched] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const problems = cityProblems(form, boot.cities);
  const invalid = Object.keys(problems).length > 0;
  const adding = isBusy('city:add');
  const field = (key: keyof CityInput, label: string, extra: { placeholder?: string; inputMode?: 'numeric'; maxLength?: number } = {}) => (
    <label className="field" htmlFor={`${id}-${key}`}>
      <span className="field-label">{label}</span>
      <input id={`${id}-${key}`} value={form[key]} required aria-invalid={touched && !!problems[key]}
        aria-describedby={touched && problems[key] ? `${id}-${key}-error` : undefined}
        onChange={e => { setForm(f => ({ ...f, [key]: e.target.value })); setServerError(null); }} {...extra} />
      {touched && problems[key] && <span className="field-error" id={`${id}-${key}-error`}>{problems[key]}</span>}
    </label>
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (invalid) return;
    void run('city:add', async () => {
      try {
        const city = await api.addCity({ name: form.name.trim(), sido: form.sido.trim(), sigungu: form.sigungu.trim(), kopisSido: form.kopisSido, kopisSigungu: form.kopisSigungu });
        setForm(EMPTY_CITY); setTouched(false);
        notify('ok', `${city.name}을(를) 추가했습니다. 검색 도시에 포함했으며, 수집을 시작하면 자료가 쌓입니다.`);
        await refresh();
        onAdded(city);
      } catch (err) { setServerError(errorText(err)); }
    });
  };
  return (
    <section className="panel" aria-labelledby="cities-title">
      <div className="panel-head"><h2 id="cities-title">등록 지역 {number(boot.cities.length)}곳</h2><button type="button" className="button" aria-expanded={showCatalog} onClick={()=>setShowCatalog(value=>!value)}>{showCatalog?'목록 접기':'등록 지역 목록 보기'}</button></div>
      {showCatalog && <div className="table-wrap">
        <table className="data-table compact">
          <caption className="visually-hidden">등록된 도시와 KOPIS 지역 코드</caption>
          <thead><tr><th scope="col">도시</th><th scope="col">시도 · 시군구</th><th scope="col">KOPIS 시도</th><th scope="col">KOPIS 구군</th></tr></thead>
          <tbody>
            {boot.cities.map(c => (
              <tr key={c.id}>
                <th scope="row"><MapPin size={14} aria-hidden="true" /> {c.name}</th>
                <td data-label="시도 · 시군구">{c.sido} {c.sigungu}</td>
                <td data-label="KOPIS 시도" className="nums">{c.kopisSido}</td>
                <td data-label="KOPIS 구군" className="nums">{c.kopisSigungu}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>}
      <details className="manual-city-details"><summary>목록에 없는 지역 직접 추가</summary>
      <form className="city-form" onSubmit={submit} noValidate aria-labelledby={`${id}-title`}>
        <h3 id={`${id}-title`}>도시 추가</h3>
        <p className="muted">
          KOPIS 코드는 공연예술통합전산망 OPEN API 개발가이드의 지역 공통코드(시도 2자리·구군 4자리)를 확인해 입력합니다. 문화포털은 시도·시군구 이름으로 조회합니다.
        </p>
        <div className="city-grid">
          {field('name', '도시명', { placeholder: '예: 통영', maxLength: 50 })}
          {field('sido', '시도', { placeholder: '예: 경상남도', maxLength: 50 })}
          {field('sigungu', '시군구', { placeholder: '예: 통영시', maxLength: 50 })}
          {field('kopisSido', 'KOPIS 시도 코드', { placeholder: '2자리', inputMode: 'numeric', maxLength: 2 })}
          {field('kopisSigungu', 'KOPIS 구군 코드', { placeholder: '4자리', inputMode: 'numeric', maxLength: 4 })}
        </div>
        {serverError && <p className="field-error" role="alert">{serverError}</p>}
        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={adding || (touched && invalid)} aria-busy={adding}>
            <Plus size={16} aria-hidden="true" />{adding ? '추가 중…' : '도시 추가'}
          </button>
        </div>
      </form></details>
    </section>
  );
}

function MaintenanceSection() {
  const { backup, shutdown, isBusy } = useDesk();
  return (
    <section className="panel" aria-labelledby="maintenance-title">
      <div className="panel-head"><h2 id="maintenance-title">백업과 종료</h2></div>
      <div className="maintenance">
        <div>
          <h3>백업</h3>
          <p className="muted">현재 공연 자료를 데이터 폴더의 <code>backups</code>에 복사합니다.</p>
          <button type="button" className="button" onClick={() => void backup()} disabled={isBusy('backup')} aria-busy={isBusy('backup')}>
            <Archive size={16} aria-hidden="true" />{isBusy('backup') ? '백업 중…' : '백업 만들기'}
          </button>
        </div>
        <div>
          <h3>프로그램 종료</h3>
          <p className="muted">로컬 서버를 정상 종료합니다. 진행 중인 수집은 저장되어 다음 실행 때 이어서 진행합니다.</p>
          <button type="button" className="button button-danger" onClick={() => void shutdown()} disabled={isBusy('shutdown')} aria-busy={isBusy('shutdown')}>
            <Power size={16} aria-hidden="true" />종료
          </button>
        </div>
      </div>
    </section>
  );
}

export function ConnectionView({ filters, onCityAdded }: { filters: FilterState; onCityAdded: (city: City) => void }) {
  const { boot } = useDesk();
  const noKeys = boot.sources.every(s => !s.configured);
  return (
    <section className="view" aria-labelledby="connection-title">
      <header className="view-head">
        <div>
          <h1 id="connection-title">데이터 연결</h1>
          <p className="view-sub">전국 자동갱신 상태와 API 연결을 확인하고, 필요한 지역·기간을 직접 수집합니다.</p>
        </div>
      </header>
      {noKeys && !boot.fallback && (
        <Callout tone="info" title="연결된 API가 없습니다">
          두 API 모두 인증키가 설정되지 않았습니다. 신청 후 키를 입력하면 수집할 수 있습니다. 키가 없는 동안 실제 자료는 표시되지 않습니다.
        </Callout>
      )}
      <AutomaticRefreshPanel />
      <SourcesSection />
      <SyncSection filters={filters} />
      <RunsSection />
      {boot.deployment !== 'cloud' && <><CitySection onAdded={onCityAdded} /><MaintenanceSection /></>}
    </section>
  );
}
