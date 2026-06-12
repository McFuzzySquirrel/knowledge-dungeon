import type { JSX, ReactNode } from 'react';
import { useSessionStore } from '@/store/sessionStore';

interface HudDrawerProps {
  children: ReactNode;
}

export function HudDrawer({ children }: HudDrawerProps): JSX.Element {
  const open = useSessionStore((s) => s.mobileHudOpen);
  const setOpen = useSessionStore((s) => s.setMobileHudOpen);

  return (
    <>
      <button
        type="button"
        className="hud-drawer-tab"
        aria-label={open ? 'Close HUD panel' : 'Open HUD panel'}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true" className="hud-drawer-tab-icon">{open ? '✕' : '☰'}</span>
        <span className="hud-drawer-tab-label">Menu</span>
      </button>

      <div className={`hud-drawer-panel${open ? ' hud-drawer-panel--open' : ''}`}>
        {children}
      </div>
    </>
  );
}
