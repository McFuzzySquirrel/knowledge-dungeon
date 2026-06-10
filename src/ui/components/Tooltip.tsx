import { useEffect, useState, type JSX } from 'react';
import { hasSeenTooltip, markTooltipSeen } from '@/ui/utils/tooltips';

interface TooltipProps {
  id: string;
  children: React.ReactNode;
  onDismiss?: () => void;
}

export function Tooltip({ id, children, onDismiss }: TooltipProps): JSX.Element | null {
  const [dismissed, setDismissed] = useState(() => hasSeenTooltip(id));
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (dismissed) return;
    const timer = setTimeout(() => setVisible(true), 800);
    return () => clearTimeout(timer);
  }, [dismissed]);

  if (dismissed || !visible) return null;

  function handleDismiss() {
    markTooltipSeen(id);
    setDismissed(true);
    onDismiss?.();
  }

  return (
    <div
      className="feature-tooltip"
      role="status"
      aria-live="polite"
      style={{
        position: 'absolute',
        left: '100%',
        top: '50%',
        transform: 'translateY(-50%)',
        marginLeft: 8,
        zIndex: 1000,
        background: '#1a2744',
        border: '1px solid rgba(99, 179, 237, 0.4)',
        borderRadius: 8,
        padding: '10px 14px',
        minWidth: 220,
        maxWidth: 280,
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        fontSize: 13,
        lineHeight: 1.4,
        pointerEvents: 'auto',
      }}
    >
      <div style={{ marginBottom: 8 }}>{children}</div>
      <button
        type="button"
        className="ghost"
        style={{
          fontSize: 12,
          padding: '4px 12px',
          background: 'rgba(99, 179, 237, 0.2)',
          border: '1px solid rgba(99, 179, 237, 0.3)',
          borderRadius: 4,
          cursor: 'pointer',
        }}
        onClick={handleDismiss}
      >
        Got it
      </button>
    </div>
  );
}
