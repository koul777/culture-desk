import type { PublicRefreshStatus } from '../../shared/types';
import type { Tone } from './format';

export type AutomaticRefresh = PublicRefreshStatus & { enabled: boolean };
const LABELS: Record<PublicRefreshStatus['status'], { label: string; tone: Tone; description: string }> = {
  idle: { label: '예약 대기', tone: 'neutral', description: '다음 예약 시간에 전국 공연 정보를 확인합니다.' },
  running: { label: '전국 갱신 중', tone: 'accent', description: '전국 목록과 공연 상세 정보를 순서대로 갱신하고 있습니다.' },
  retry_wait: { label: '재시도 대기', tone: 'warn', description: '아직 끝나지 않은 구간을 다음 복구 시간에 이어서 확인합니다.' },
  failed: { label: '갱신 확인 필요', tone: 'danger', description: '이번 갱신을 마치지 못했습니다. 저장된 자료는 유지되며 다음 예약 실행에서 다시 시도합니다.' },
  complete: { label: '전국 갱신 완료', tone: 'ok', description: '이번 수집 범위의 전국 목록과 상세 정보 확인을 마쳤습니다.' },
  unavailable: { label: '상태 확인 불가', tone: 'warn', description: '자동갱신 상태를 불러오지 못했습니다. 저장된 공연은 계속 검색할 수 있습니다.' },
};

export function refreshPresentation(refresh: AutomaticRefresh, now = Date.now()) {
  const lastSuccess = refresh.lastSuccessAt ? Date.parse(refresh.lastSuccessAt) : NaN;
  const delayed = refresh.enabled && Number.isFinite(lastSuccess) && now - lastSuccess > 36 * 60 * 60 * 1000;
  if (!refresh.enabled) return { label: '자동갱신 미설정', tone: 'neutral' as Tone, delayed: false, description: '자동갱신이 설정되지 않았습니다. 아래에서 원하는 지역과 기간을 직접 수집할 수 있습니다.' };
  return { ...LABELS[refresh.status], delayed };
}

/** Scheduled times, not a promise of an exact job start. All schedule values use Korea time. */
export function nextRefreshAt(refresh: AutomaticRefresh, now = Date.now()): string | null {
  if (!refresh.enabled || refresh.status === 'unavailable') return null;
  const day = new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const times = refresh.status === 'complete' || refresh.status === 'idle'
    ? [refresh.schedule.primary] : [refresh.schedule.primary, ...refresh.schedule.retries];
  const candidates = times.map(time => Date.parse(`${day}T${time}:00+09:00`)).filter(Number.isFinite).sort((a, b) => a - b);
  const next = candidates.find(at => at > now) ?? (candidates[0] !== undefined ? candidates[0] + 86_400_000 : null);
  return next === null ? null : new Date(next).toISOString();
}
