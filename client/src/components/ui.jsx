import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { IconX, IconCheck, IconAlert, IconInfo } from './icons.jsx';
import { STATUS_META } from '../format.js';
import { useI18n } from '../i18n.jsx';

/* ---------------- Spinner / loading ---------------- */
export function Spinner({ label }) {
  return (
    <div className="loading-block" role="status" aria-live="polite">
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        <div className="spinner" />
        {label && <div className="muted small">{label}</div>}
      </div>
    </div>
  );
}

/* ---------------- Empty state ---------------- */
export function EmptyState({ icon = '🗂', title, children, action }) {
  return (
    <div className="empty-state">
      <div className="big">{icon}</div>
      <b>{title}</b>
      {children && <div className="empty-desc">{children}</div>}
      {action}
    </div>
  );
}

/* ---------------- Status badge ---------------- */
export function StatusBadge({ status }) {
  const m = STATUS_META[status] || { label: status, bg: '#f1f5f9', fg: '#475569', border: '#dbe2ea', color: '#94a3b8' };
  const { t } = useI18n();
  const key = `status.${status}`;
  const translated = t(key);
  const label = translated === key ? m.label : translated;
  return (
    <span className="badge" style={{ background: m.bg, color: m.fg, borderColor: m.border }}>
      <span className="bdot" style={{ background: m.color }} />
      {label}
    </span>
  );
}

/* ---------------- Modal ---------------- */
export function Modal({ title, onClose, children, footer, wide }) {
  const boxRef = useRef(null);
  // callers pass fresh closures every render; keep the latest without re-running the focus effect
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') closeRef.current?.(); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    // Focus management: remember the opener, focus the dialog, restore on close.
    // Mount-only: re-running on every render would steal focus from the field being typed in.
    const opener = document.activeElement;
    const first = boxRef.current?.querySelector('input:not([type=hidden]), select, textarea, button');
    first?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      if (opener && typeof opener.focus === 'function') opener.focus();
    };
  }, []);
  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div ref={boxRef} className={`modal${wide ? ' modal-lg' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close dialog"><IconX /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ---------------- Toasts ---------------- */
const ToastCtx = createContext(null);
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);
  const push = useCallback((type, message) => {
    const id = ++idRef.current;
    setToasts((t) => [...t, { id, type, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), type === 'error' ? 6500 : 4200);
  }, []);
  const api = {
    success: useCallback((m) => push('success', m), [push]),
    error: useCallback((m) => push('error', m), [push]),
    info: useCallback((m) => push('info', m), [push]),
  };
  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`}>
            <span className="tico">
              {t.type === 'success' ? <IconCheck size={16}/> : t.type === 'error' ? <IconAlert size={16}/> : <IconInfo size={16}/>}
            </span>
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/* ---------------- Confirm dialog ---------------- */
const ConfirmCtx = createContext(null);
export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null);
  const [promptValue, setPromptValue] = useState('');
  const confirm = useCallback((opts) => {
    return new Promise((resolve) => {
      setPromptValue(opts && opts.prompt && opts.prompt.default ? opts.prompt.default : '');
      setState({ ...opts, resolve });
    });
  }, []);
  const close = (val) => { state?.resolve(val); setState(null); };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {state && (
        <Modal
          title={state.title || 'Please confirm'}
          onClose={() => close(false)}
          footer={
            <>
              <button className="btn btn-outline" onClick={() => close(false)}>Cancel</button>
              <button
                className={`btn ${state.danger ? 'btn-danger' : 'btn-primary'}`}
                disabled={!!state.prompt && state.prompt.required && !promptValue.trim()}
                onClick={() => close(state.prompt ? promptValue.trim() : true)}
              >
                {state.confirmLabel || 'Confirm'}
              </button>
            </>
          }
        >
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: 'var(--ink-2)' }}>{state.message}</p>
          {state.prompt && (
            <label className="field" style={{ display: 'block', marginTop: 12 }}>
              <span className="field-label">{state.prompt.label}</span>
              <textarea
                className="input" rows={2} value={promptValue}
                placeholder={state.prompt.placeholder || ''}
                onChange={(e) => setPromptValue(e.target.value)}
              />
            </label>
          )}
        </Modal>
      )}
    </ConfirmCtx.Provider>
  );
}
export const useConfirm = () => useContext(ConfirmCtx);

/* ---------------- Form field ---------------- */
export function Field({ label, hint, children, error }) {
  return (
    <label className="field">
      {label && <span className="field-label">{label}</span>}
      {children}
      {error ? <span className="small" style={{ color: 'var(--danger)' }}>{error}</span>
        : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

/* ---------------- Pagination ---------------- */
export function Pagination({ page, pages, total, onPage }) {
  if (pages <= 1) return null;
  return (
    <div className="pagination">
      <span>Page {page} of {pages} · {total} items</span>
      <button className="btn btn-outline btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Prev</button>
      <button className="btn btn-outline btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
    </div>
  );
}
