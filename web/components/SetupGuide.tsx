import { ExternalLink, KeyRound, LoaderCircle, Play, RefreshCw } from 'lucide-react';
import { useDesk } from '../desk';
import { number } from '../lib/format';
import { activeSummary } from '../lib/runs';
import { Badge } from './Cells';

/** First screen when nothing has been collected yet. Shows real connection state only. */
export function SetupGuide() {
  const { boot, reloadConfig, isBusy, go } = useDesk();
  const configured = boot.sources.filter(s => s.configured);
  const progress = activeSummary(boot.runs);
  const reloading = isBusy('config:reload');
  if (boot.deployment === 'cloud') return <section className="setup" aria-labelledby="setup-title">
    <h2 id="setup-title">공연 정보 가져오기</h2>
    <p className="setup-lead">아직 수집된 공연 자료가 없습니다. 데이터 연결에서 지역과 기간을 선택하면 공연 목록을 가져올 수 있습니다.</p>
    {progress.active > 0 && <p className="setup-progress" role="status"><LoaderCircle size={16} aria-hidden="true" className="spin" />수집 중 · 남은 요청 {number(progress.remaining)}건</p>}
    <button type="button" className="button button-primary" onClick={() => go('connection')}><Play size={16} aria-hidden="true" />지역 선택하고 공연 가져오기</button>
  </section>;
  return (
    <section className="setup" aria-labelledby="setup-title">
      <h2 id="setup-title">처음 사용하기</h2>
      <p className="setup-lead">
        아직 수집된 공연 자료가 없습니다. 공연 정보는 두 공공 API에서 받아오며, 인증키를 서버 설정에 넣은 뒤 수집을 시작하면 이 화면에 공연 목록이 나타납니다.
      </p>
      {progress.active > 0 && (
        <p className="setup-progress" role="status">
          <LoaderCircle size={16} aria-hidden="true" className="spin" />
          수집 작업 {number(progress.active)}개 진행 중 · 남은 요청 {number(progress.remaining)}건. 첫 자료가 저장되면 공연 목록이 표시됩니다.
        </p>
      )}
      <ol className="steps">
        <li>
          <h3>1. API 인증키 신청</h3>
          <table className="plain-table">
            <caption className="visually-hidden">API 연결 상태</caption>
            <tbody>
              {boot.sources.map(s => (
                <tr key={s.source}>
                  <th scope="row">{s.label}</th>
                  <td>{s.configured ? <Badge tone="ok">키 설정됨</Badge> : <Badge>미연결</Badge>}</td>
                  <td>
                    <a href={s.applicationUrl} target="_blank" rel="noopener noreferrer" className="ext-link">
                      신청 페이지 <ExternalLink size={14} aria-hidden="true" /><span className="visually-hidden">(새 창)</span>
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">한쪽 키만 있어도 해당 출처의 공연을 수집할 수 있습니다.</p>
        </li>
        <li>
          <h3>2. 프로그램 폴더의 <code>.env</code> 파일에 키 입력</h3>
          <pre className="env-sample" aria-label=".env 입력 형식"><code>{'KOPIS_API_KEY=발급받은 KOPIS 키\nCULTURE_API_KEY=문화포털 일반 인증키(Decoding)'}</code></pre>
          <p className="muted"><KeyRound size={14} aria-hidden="true" /> 키는 서버에서만 읽습니다. 이 화면이나 채팅에 붙여 넣지 마세요.</p>
        </li>
        <li>
          <h3>3. 설정 다시 읽기</h3>
          <p>파일을 저장한 뒤 눌러 주세요. 프로그램을 다시 시작하지 않아도 됩니다.</p>
          <button type="button" className="button" onClick={() => void reloadConfig()} disabled={reloading} aria-busy={reloading}>
            <RefreshCw size={16} aria-hidden="true" className={reloading ? 'spin' : undefined} />설정 다시 읽기
          </button>
        </li>
        <li>
          <h3>4. 도시·기간을 정해 수집 시작</h3>
          <p>
            {configured.length
              ? `${configured.map(s => s.label).join('·')} 키가 설정되어 있습니다. 데이터 연결 화면에서 대상 도시·기간과 예상 작업량을 확인한 뒤 시작하세요.`
              : '키를 설정하면 데이터 연결 화면에서 수집을 시작할 수 있습니다.'}
          </p>
          <button type="button" className="button button-primary" onClick={() => go('connection')}>
            <Play size={16} aria-hidden="true" />데이터 연결로 이동
          </button>
        </li>
      </ol>
    </section>
  );
}
