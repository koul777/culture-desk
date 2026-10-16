import type { Bootstrap, Source, SyncRun } from '../../shared/types';
import { RUN_LABEL, RUN_TONE, isActive, type Tone } from './format';

export function remainingTasks(run: SyncRun): number {
  return Math.max(0, run.tasksTotal - run.tasksDone - run.tasksFailed);
}

export function activeSummary(runs: SyncRun[]) {
  const active = runs.filter(isActive);
  return {
    active: active.length,
    running: active.some(r => r.state === 'running'),
    remaining: active.reduce((n, r) => n + remainingTasks(r), 0),
  };
}

/** One state per source, using the plan's labels: 미연결 / 미수집 / 수집 중 / 일부 실패 / 한도 대기 / 중단 / 완료. */
export function sourceState(boot: Bootstrap, source: Source): { label: string; tone: Tone; error: string } {
  const status = boot.sources.find(s => s.source === source);
  if (!status?.configured) return { label: '미연결', tone: 'neutral', error: '' };
  const runs = boot.runs.filter(r => r.source === source);
  if (runs.some(isActive)) return { label: '수집 중', tone: 'accent', error: '' };
  const collections = runs.filter(r => !r.detailOnly);
  if (!collections.length) return { label: status.lastSync ? '완료' : '미수집', tone: status.lastSync ? 'ok' : 'neutral', error: '' };
  const latest = collections.reduce((a, b) => (b.id > a.id ? b : a));
  return { label: RUN_LABEL[latest.state], tone: RUN_TONE[latest.state], error: latest.error };
}
