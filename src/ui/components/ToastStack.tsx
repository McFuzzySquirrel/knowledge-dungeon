import type { JSX } from 'react';

export interface ToastItem {
  id: number;
  level: 'info' | 'error';
  message: string;
}

interface ToastStackProps {
  toasts: readonly ToastItem[];
  className?: string;
}

export function ToastStack({ toasts, className }: ToastStackProps): JSX.Element | null {
  if (toasts.length === 0) return null;

  const stackClass = className ? `toast-stack ${className}` : 'toast-stack';

  return (
    <div className={stackClass} aria-live="polite" aria-label="Status messages">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast--${toast.level}`}
          role={toast.level === 'error' ? 'alert' : 'status'}
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
}
