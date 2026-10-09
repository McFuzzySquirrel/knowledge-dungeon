import type { JSX } from 'react';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: number;
  level: 'info' | 'error';
  message: string;
  action?: ToastAction;
}

interface ToastStackProps {
  toasts: readonly ToastItem[];
  className?: string;
  onDismiss?: (id: number) => void;
}

export function ToastStack({ toasts, className, onDismiss }: ToastStackProps): JSX.Element | null {
  if (toasts.length === 0) return null;

  const stackClass = className ? `toast-stack ${className}` : 'toast-stack';

  /*
   * The stack and each toast card are `pointer-events: none`; only the toast's
   * own buttons opt back in. A status message may be visible over the world, but
   * it must never swallow a click on a world control beneath it - the same
   * contract `Minimap` uses. See `src/styles/responsive-chrome.css`.
   */
  return (
    <div className={stackClass} aria-live="polite" aria-label="Status messages">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast--${toast.level}`}
          role={toast.level === 'error' ? 'alert' : 'status'}
        >
          <span className="toast-message">{toast.message}</span>
          {toast.action ? (
            <button
              type="button"
              className="toast-action"
              onClick={toast.action.onClick}
              style={{
                marginLeft: 10,
                minHeight: 44,
                minWidth: 44,
                padding: '2px 8px',
                pointerEvents: 'auto',
                background: 'rgba(99, 179, 237, 0.2)',
                border: '1px solid rgba(99, 179, 237, 0.3)',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 12,
                whiteSpace: 'nowrap',
              }}
            >
              {toast.action.label}
            </button>
          ) : null}
          {onDismiss ? (
            <button
              type="button"
              className="toast-dismiss"
              onClick={() => onDismiss(toast.id)}
              aria-label="Dismiss"
              style={{
                marginLeft: 8,
                minHeight: 44,
                minWidth: 44,
                pointerEvents: 'auto',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                opacity: 0.5,
                fontSize: 14,
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
