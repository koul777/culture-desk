import type { Provider, Source } from '../../shared/types.js';
import { createCultureProvider } from './culture.js';
import { createKopisProvider } from './kopis.js';
import type { HttpOptions } from './fetch.js';

export { DEFAULT_CITIES } from './cities.js';

export function createProviders(
  keys: { kopis: string; culture: string },
  options: HttpOptions = {},
): Partial<Record<Source, Provider>> {
  const providers: Partial<Record<Source, Provider>> = {};
  const kopis = keys.kopis?.trim();
  const culture = keys.culture?.trim();
  if (kopis) providers.kopis = createKopisProvider(kopis, options);
  if (culture) providers.culture = createCultureProvider(culture, options);
  return providers;
}
