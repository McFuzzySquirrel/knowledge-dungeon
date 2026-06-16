import { useEffect, useState, type JSX } from 'react';

const HINT_SEEN_KEY = 'knowledge-dungeon:ui:touch-hint:v1';

function hasSeenHint(): boolean {
  try { return !!localStorage.getItem(HINT_SEEN_KEY); }
  catch { return false; }
}

function markHintSeen(): void {
  try { localStorage.setItem(HINT_SEEN_KEY, '1'); }
  catch { /* ignore */ }
}

export function MobileTouchHint(): JSX.Element | null {
  const [visible, setVisible] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const isMobile = window.matchMedia('(max-width: 768px), (pointer: coarse)').matches;
    if (!isMobile || hasSeenHint()) return;
    const timer = setTimeout(() => setVisible(true), 1500);
    return () => clearTimeout(timer);
  }, []);

  if (!visible || dismissed) return null;

  function handleDismiss() {
    markHintSeen();
    setDismissed(true);
  }

  return (
    <div
      className="mobile-touch-hint"
      role="status"
      aria-live="polite"
      style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 96,
        background: 'rgba(11, 13, 20, 0.92)',
        border: '1px solid rgba(99, 179, 237, 0.4)',
        borderRadius: 12,
        padding: '20px 24px',
        maxWidth: 300,
        textAlign: 'center',
        backdropFilter: 'blur(6px)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        pointerEvents: 'auto',
      }}
    >
      <div style={{ fontSize: 28, marginBottom: 12 }}>👆</div>
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, fontWeight: 600 }}>
        Drag to move &middot; Tap to interact
      </p>
      <p style={{ margin: '8px 0 0', fontSize: 12, opacity: 0.7, lineHeight: 1.4 }}>
        Drag anywhere on the screen to move your character. Tap to interact with rooms and NPCs.
      </p>
      <button
        type="button"
        onClick={handleDismiss}
        style={{
          marginTop: 14,
          padding: '8px 24px',
          background: 'rgba(99, 179, 237, 0.2)',
          border: '1px solid rgba(99, 179, 237, 0.3)',
          borderRadius: 8,
          color: '#7fb2ff',
          cursor: 'pointer',
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        Got it
      </button>
    </div>
  );
}
