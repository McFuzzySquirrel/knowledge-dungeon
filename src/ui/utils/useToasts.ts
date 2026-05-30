import { useCallback, useState } from 'react';
import type { ToastItem } from '@/ui/components/ToastStack';

export function useToasts(timeoutMs = 2800): {
  toasts: readonly ToastItem[];
  pushToast: (level: ToastItem['level'], message: string) => void;
} {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const pushToast = useCallback(
    (level: ToastItem['level'], message: string) => {
      const id = Date.now() + Math.floor(Math.random() * 10_000);
      const toast: ToastItem = { id, level, message };
      setToasts((current) => [...current, toast]);
      window.setTimeout(() => {
        setToasts((current) => current.filter((item) => item.id !== id));
      }, timeoutMs);
    },
    [timeoutMs],
  );

  return { toasts, pushToast };
}
