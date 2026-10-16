import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { MapPerformance } from '../../shared/types';
import { Modal } from './Modal';
import { vworldAvailable } from '../lib/vworld-client';

const ViewerDialog = lazy(() => import('./Venue3DDialog'));
const VWorldDialog = lazy(() => import('./VWorld3DDialog'));
export type Venue3DLocation = Pick<MapPerformance, 'id' | 'venue' | 'latitude' | 'longitude' | 'locationPrecision'>;

class ViewerLoadBoundary extends Component<{ onClose: () => void; onFallback?: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <Modal open onClose={this.props.onClose} title="3D 지도를 불러오지 못했습니다">
      <p>연결 상태를 확인하고 페이지를 새로고침한 뒤 다시 열어주세요. 공연 검색은 계속 이용할 수 있습니다.</p>
      {this.props.onFallback && <button type="button" className="button button-primary" onClick={this.props.onFallback}>기존 외곽 모형 보기</button>}
      <button type="button" className="button" onClick={this.props.onClose}>돌아가기</button>
    </Modal>;
    return this.props.children;
  }
}

export function canViewVenue3D(item: Venue3DLocation): boolean {
  return item.locationPrecision === 'venue' && Number.isFinite(item.latitude) && Number.isFinite(item.longitude)
    && item.latitude! >= 33 && item.latitude! <= 39 && item.longitude! >= 124 && item.longitude! <= 132;
}

/** Configuration and either viewer are fetched only after an explicit 3D action. */
export function Venue3D({ item, onClose }: { item: Venue3DLocation; onClose: () => void }) {
  const [provider, setProvider] = useState<'checking' | 'vworld' | 'osm'>('checking');
  useEffect(() => {
    const controller = new AbortController();
    setProvider('checking');
    void vworldAvailable(controller.signal).then(available => {
      if (!controller.signal.aborted) setProvider(available ? 'vworld' : 'osm');
    });
    return () => controller.abort();
  }, [item.id]);
  const pending = <Modal open onClose={onClose} title="공연장 3D 불러오는 중"><p className="loading-inline" role="status"><LoaderCircle className="spin" size={18} aria-hidden="true" />3D 지도를 준비하고 있습니다.</p></Modal>;
  if (provider === 'checking') return pending;
  const fallback = () => setProvider('osm');
  return <ViewerLoadBoundary key={provider} onClose={onClose} onFallback={provider === 'vworld' ? fallback : undefined}><Suspense fallback={pending}>
    {provider === 'vworld' ? <VWorldDialog item={item} onClose={onClose} onFallback={fallback} /> : <ViewerDialog item={item} onClose={onClose} />}
  </Suspense></ViewerLoadBoundary>;
}
