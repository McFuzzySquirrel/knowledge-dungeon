import { useEffect, useRef } from 'react';
import { isElectronAvailable } from '@/services/electronBridge';
import type { ToastAction } from '@/ui/components/ToastStack';

const REMINDER_INTERVAL_MS = 30 * 60 * 1000;
const LAST_NUDGE_KEY = 'knowledge-dungeon:ui:export-reminder:lastNudge';

function canNudge(): boolean {
  try {
    const raw = localStorage.getItem(LAST_NUDGE_KEY);
    if (!raw) return true;
    const last = Number(raw);
    if (Number.isNaN(last)) return true;
    return Date.now() - last >= REMINDER_INTERVAL_MS;
  } catch {
    return false;
  }
}

function markNudged(): void {
  try {
    localStorage.setItem(LAST_NUDGE_KEY, String(Date.now()));
  } catch {
    // ignore
  }
}

export function useExportReminder(
  pushToast: (level: 'info' | 'error', message: string, action?: ToastAction) => void,
): void {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (isElectronAvailable()) return;

    function showReminder() {
      if (!canNudge()) return;
      markNudged();
      pushToast('info', 'Your data is stored locally — export a backup to stay safe.', {
        label: 'Export',
        onClick: () => {
          const dataTab = document.querySelector('[aria-controls="welcome-panel-data"]');
          if (dataTab instanceof HTMLElement) {
            dataTab.click();
          }
        },
      });
    }

    showReminder();
    intervalRef.current = setInterval(showReminder, REMINDER_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [pushToast]);
}
