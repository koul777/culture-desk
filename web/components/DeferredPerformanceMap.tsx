import { useEffect, useState } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import type { PerformanceMap, PerformanceMapProps } from './PerformanceMap';

type MapModule = typeof import('./PerformanceMap');
let loaded: MapModule | undefined;
let pending: Promise<MapModule> | undefined;

/** Start the map chunk alongside its API request, before list results permit the map to mount. */
export function preloadPerformanceMap(): Promise<MapModule> {
  if (loaded) return Promise.resolve(loaded);
  if (!pending) pending = import('./PerformanceMap').then(module => {
    loaded = module;
    return module;
  });
  // A failed CSS preload may remain cached by the module loader. Retain the rejection
  // until navigation reloads the document instead of mounting an unstyled map.
  return pending;
}

export function DeferredPerformanceMap(props: PerformanceMapProps) {
  const [Map, setMap] = useState<typeof PerformanceMap | undefined>(() => loaded?.PerformanceMap);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setFailed(false);
    void preloadPerformanceMap().then(module => {
      if (active) setMap(() => module.PerformanceMap);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, []);
  if (Map) return <Map {...props} />;
  return <div className="map-panel map-module-state" aria-busy={!failed}>
    {failed ? <div role="alert">
      <strong>지도를 불러오지 못했습니다</strong>
      <p>공연 목록은 계속 이용할 수 있습니다. 연결 상태를 확인한 뒤 페이지를 새로고침해 주세요.</p>
      <button type="button" className="button" onClick={() => window.location.reload()}><RefreshCw size={16} aria-hidden="true" />페이지 새로고침</button>
    </div> : <p className="loading-inline" role="status"><LoaderCircle size={18} className="spin" aria-hidden="true" />지도를 준비하고 있습니다.</p>}
  </div>;
}
