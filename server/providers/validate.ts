import type { PerformanceInput } from '../../shared/types.js';
import { assertNoSecrets, ProviderError } from './errors.js';
import { toIsoDate } from './dates.js';

export function checkedPerformance(item: PerformanceInput, key: string): PerformanceInput {
  if (!item.sourceId || !item.title || !toIsoDate(item.startDate) || !toIsoDate(item.endDate) || item.endDate < item.startDate) {
    throw new ProviderError('schema', 'performance identity or dates missing');
  }
  assertNoSecrets(item, key);
  return item;
}
