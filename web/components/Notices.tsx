import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';

type Kind = 'ok' | 'info' | 'error';
interface Notice { id: number; kind: Kind; text: string }
interface NoticeApi {
  notify: (kind: Kind, text: string) => void;
  /** An open modal dialog makes the rest of the page inert, so notices move into the top-most dialog. */
  registerHost: (element: HTMLElement) => () => void;
}

const NoticeContext = createContext<NoticeApi>({ notify: () => undefined, registerHost: () => () => undefined });
export const useNotify = () => useContext(NoticeContext).notify;
export const useNoticeHost = () => useContext(NoticeContext).registerHost;

const ICON = { ok: CircleCheck, info: Info, error: CircleAlert };

export function NoticeProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Notice[]>([]);
  const [hosts, setHosts] = useState<HTMLElement[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setItems(list => list.filter(n => n.id !== id)), []);
  const notify = useCallback((kind: Kind, text: string) => {
    const id = next.current++;
    setItems(list => [...list.filter(n => n.text !== text), { id, kind, text }].slice(-4));
    // Errors stay until dismissed so they can be read; confirmations fade.
    if (kind !== 'error') window.setTimeout(() => dismiss(id), 6000);
  }, [dismiss]);
  const registerHost = useCallback((element: HTMLElement) => {
    setHosts(list => [...list, element]);
    return () => setHosts(list => list.filter(h => h !== element));
  }, []);
  const value = useMemo(() => ({ notify, registerHost }), [notify, registerHost]);
  const render = (n: Notice) => {
    const Icon = ICON[n.kind];
    return (
      <div key={n.id} className={`notice notice-${n.kind}`}>
        <Icon size={18} aria-hidden="true" />
        <p>{n.text}</p>
        <button type="button" className="icon-button" onClick={() => dismiss(n.id)} aria-label="알림 닫기"><X size={16} aria-hidden="true" /></button>
      </div>
    );
  };
  const region = (
    <div className="notices">
      <div role="status" aria-live="polite">{items.filter(n => n.kind !== 'error').map(render)}</div>
      <div role="alert" aria-live="assertive">{items.filter(n => n.kind === 'error').map(render)}</div>
    </div>
  );
  const host = hosts[hosts.length - 1];
  return (
    <NoticeContext.Provider value={value}>
      {children}
      {host ? createPortal(region, host) : region}
    </NoticeContext.Provider>
  );
}
