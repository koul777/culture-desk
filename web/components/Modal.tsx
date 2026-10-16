import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useNoticeHost } from './Notices';

interface ModalProps {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode;
  footer?: ReactNode; size?: 'large' | 'small'; subtitle?: ReactNode;
}

/** Native modal dialog: the browser makes the page inert, traps Tab and closes on Esc. */
export function Modal({ open, onClose, title, subtitle, children, footer, size = 'large' }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const restore = useRef<HTMLElement | null>(null);
  const noticeHost = useRef<HTMLDivElement>(null);
  const registerHost = useNoticeHost();
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    } else if (!open && dialog.open) dialog.close();
  }, [open]);
  useEffect(() => (open && noticeHost.current ? registerHost(noticeHost.current) : undefined), [open, registerHost]);
  useEffect(() => () => { restore.current?.focus(); }, []);
  const handleClose = () => {
    onClose();
    const target = restore.current;
    if (target?.isConnected) window.setTimeout(() => target.focus(), 0);
  };
  return (
    <dialog
      ref={ref}
      className={`modal modal-${size}`}
      aria-labelledby={titleId}
      onClose={handleClose}
      onClick={e => { if (e.target === e.currentTarget) e.currentTarget.close(); }}
    >
      <div className="modal-frame">
        <header className="modal-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <div className="modal-subtitle">{subtitle}</div>}
          </div>
          <button type="button" className="icon-button" onClick={() => ref.current?.close()} aria-label="닫기">
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        <div ref={noticeHost} className="notice-host" />
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </dialog>
  );
}

interface ConfirmOptions { title: string; body: ReactNode; confirmLabel: string; danger?: boolean }
type Confirm = (options: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<Confirm>(async () => false);
export const useConfirm = () => useContext(ConfirmContext);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);
  const confirm = useCallback<Confirm>(next => new Promise(resolve => {
    resolver.current?.(false);
    resolver.current = resolve;
    setOptions(next);
  }), []);
  const finish = (value: boolean) => {
    const resolve = resolver.current;
    resolver.current = null;
    setOptions(null);
    resolve?.(value);
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={!!options}
        onClose={() => finish(false)}
        size="small"
        title={options?.title ?? ''}
        footer={options && (
          <>
            <button type="button" className="button" onClick={() => finish(false)}>취소</button>
            <button type="button" className={`button ${options.danger ? 'button-danger' : 'button-primary'}`} onClick={() => finish(true)}>
              {options.confirmLabel}
            </button>
          </>
        )}
      >
        <div className="confirm-body">{options?.body}</div>
      </Modal>
    </ConfirmContext.Provider>
  );
}
