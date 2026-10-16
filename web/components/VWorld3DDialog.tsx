import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Check, LoaderCircle, RefreshCw } from 'lucide-react';
import { readVWorldMessage, vworldFrameUrl } from '../lib/vworld-client';
import { Modal } from './Modal';
import type { Venue3DLocation } from './Venue3D';
import '../vworld-3d.css';

export default function VWorld3DDialog({ item, onClose, onFallback }: {
  item: Venue3DLocation; onClose: () => void; onFallback: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const releaseFrameKeys = useRef<(() => void) | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const channel = useMemo(() => crypto.randomUUID().replaceAll('-', ''), [item.id, attempt]);
  const src = vworldFrameUrl(item.latitude!, item.longitude!, item.venue || '공연장', channel);
  const connectFrameKeys = () => {
    releaseFrameKeys.current?.();
    try {
      const target = frame.current?.contentWindow;
      if (!target) return;
      const escape = (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return;
        event.preventDefault(); event.stopPropagation(); close.current();
      };
      target.addEventListener('keydown', escape, true);
      releaseFrameKeys.current = () => target.removeEventListener('keydown', escape, true);
    } catch { /* The frame must remain same-origin; an unexpected navigation will time out. */ }
  };
  useEffect(() => {
    let active = true;
    setStatus('loading'); setMessage('');
    const timer = window.setTimeout(() => {
      if (!active) return;
      active = false;
      setStatus('error'); setMessage('브이월드 연결이 30초를 넘었습니다. 다시 시도하거나 기존 외곽 모형을 확인하세요.');
    }, 30_000);
    const receive = (event: MessageEvent) => {
      if (!active) return;
      const received = readVWorldMessage(event, frame.current?.contentWindow ?? null, window.location.origin, channel);
      if (!received) return;
      window.clearTimeout(timer);
      if (received.status === 'error') {
        active = false;
        setMessage(received.message || '브이월드 지도를 불러오지 못했습니다. 다시 시도하거나 기존 외곽 모형을 확인하세요.');
      }
      setStatus(received.status);
    };
    window.addEventListener('message', receive);
    return () => {
      active = false; window.clearTimeout(timer); window.removeEventListener('message', receive);
      releaseFrameKeys.current?.(); releaseFrameKeys.current = null;
    };
  }, [channel]);
  useEffect(() => {
    if (status === 'error') { releaseFrameKeys.current?.(); releaseFrameKeys.current = null; }
  }, [status]);

  return <Modal open onClose={onClose} title={`${item.venue || '공연장'} · 브이월드 3D`}
    subtitle={<p className="vworld-subtitle">지역에 따라 건물 제공 범위가 다릅니다.</p>}>
    <section className="vworld-viewer" data-status={status} aria-label="브이월드 3D 지도">
      <div className="vworld-toolbar"><span className="vworld-badge"><Box size={16} aria-hidden="true" />브이월드 3D</span>
        <span className="vworld-connection" role="status">{status === 'ready' ? <><Check size={15} aria-hidden="true" />지도 연결됨</> : status === 'loading' ? '지도 연결 중' : '연결 확인 필요'}</span>
      </div>
      <div className="vworld-stage" aria-busy={status === 'loading'}>
        {status !== 'error' && <iframe key={channel} ref={frame} src={src} title={`${item.venue || '공연장'} 브이월드 3D 지도`}
          className={status === 'loading' ? 'is-loading' : ''} allow="fullscreen" referrerPolicy="strict-origin-when-cross-origin"
          tabIndex={status === 'ready' ? 0 : -1} onLoad={connectFrameKeys} onError={() => { setStatus('error'); setMessage('브이월드 화면을 열지 못했습니다. 다시 시도해주세요.'); }} />}
        {status === 'loading' && <div className="vworld-state" role="status"><LoaderCircle size={28} className="spin" aria-hidden="true" /><strong>브이월드 지도를 준비하고 있습니다</strong><p>선택한 공연장 위치로 이동합니다.<br />건물과 배경 자료를 불러오는 데 시간이 걸릴 수 있습니다.</p></div>}
        {status === 'error' && <div className="vworld-state vworld-error" role="alert"><Box size={28} aria-hidden="true" /><strong>브이월드 연결을 확인해주세요</strong><p>{message}</p><button type="button" className="button button-primary" onClick={() => { setStatus('loading'); setAttempt(value => value + 1); }}><RefreshCw size={16} aria-hidden="true" />다시 시도</button></div>}
      </div>
      <div className="vworld-footer"><p>건물이 표시되지 않으면 기존 외곽 모형을 확인할 수 있습니다.</p><button type="button" className="button" onClick={onFallback}><Box size={16} aria-hidden="true" />기존 외곽 모형 보기</button></div>
      <p className="vworld-help">지도 안의 버튼으로 이동·확대·회전할 수 있습니다. 제공되지 않는 건물은 표시되지 않을 수 있습니다.</p>
    </section>
  </Modal>;
}
