import { useEffect, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { hasSeenTooltip, markTooltipSeen } from '@/ui/utils/tooltips';

interface TooltipProps {
  id: string;
  children: React.ReactNode;
  onDismiss?: () => void;
}

export function Tooltip({ id, children, onDismiss }: TooltipProps): JSX.Element | null {
  const [dismissed, setDismissed] = useState(() => hasSeenTooltip(id));
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState<{ x: number; y: number } | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (dismissed) return;
    const timer = setTimeout(() => setVisible(true), 800);
    return () => clearTimeout(timer);
  }, [dismissed]);

  useEffect(() => {
    if (!visible || !wrapperRef.current) return;
    const parent = wrapperRef.current.parentElement;
    if (!parent) return;
    // Find the trigger button — it's the previous sibling or the first button child of the parent
    const trigger = parent.querySelector('button') ?? parent.previousElementSibling;
    const rect = trigger?.getBoundingClientRect() ?? parent.getBoundingClientRect();
    setCoords({ x: rect.right + 8, y: rect.top + rect.height / 2 });
  }, [visible]);

  if (dismissed || !visible) return null;

  function handleDismiss() {
    markTooltipSeen(id);
    setDismissed(true);
    onDismiss?.();
  }

  const tooltip = (
    <div
      className="feature-tooltip"
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        left: coords?.x ?? 9999,
        top: coords?.y ?? 9999,
        transform: 'translateY(-50%)',
        zIndex: 9999,
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

  return (
    <>
      <div ref={wrapperRef} style={{ display: 'none' }} />
      {createPortal(tooltip, document.body)}
    </>
  );
}
