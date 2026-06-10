import { useCallback, useState } from 'react';
import type { ToastAction, ToastItem } from '@/ui/components/ToastStack';

export function useToasts(timeoutMs = 2800): {
  toasts: readonly ToastItem[];
  pushToast: (level: ToastItem['level'], message: string, action?: ToastAction) => void;
  dismissToast: (id: number) => void;
} {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const pushToast = useCallback(
    (level: ToastItem['level'], message: string, action?: ToastAction) => {
      const id = Date.now() + Math.floor(Math.random() * 10_000);
      const toast: ToastItem = { id, level, message, action };
      setToasts((current) => [...current, toast]);
      if (!action) {
        window.setTimeout(() => {
          setToasts((current) => current.filter((item) => item.id !== id));
        }, timeoutMs);
      }
    },
    [timeoutMs],
  );

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  return { toasts, pushToast, dismissToast };
}
