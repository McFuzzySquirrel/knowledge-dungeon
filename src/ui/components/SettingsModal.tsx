import type { JSX } from 'react';
import type { ColorTheme } from '@/store/preferencesStore';

interface SettingsModalProps {
  currentTheme: ColorTheme;
  onThemeChange: (theme: ColorTheme) => void;
  onClose: () => void;
}

const THEME_OPTIONS: { id: ColorTheme; title: string; description: string }[] = [
  {
    id: 'dark',
    title: 'Night',
    description: 'Deep navy UI chrome with balanced contrast for long sessions.',
  },
  {
    id: 'colorful',
    title: 'Arcade',
    description: 'A brighter, more saturated UI palette with energetic cyan accents.',
  },
  {
    id: 'aurora',
    title: 'Aurora',
    description: 'A neon-teal and violet variant with stronger contrast on buttons and headers.',
  },
];

export function SettingsModal({ currentTheme, onThemeChange, onClose }: SettingsModalProps): JSX.Element {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(event) => event.stopPropagation()}
      >
        <h2>Settings</h2>
        <p className="room-help-text">
          Choose the visual theme for menus and other UI panels. The gameplay canvas stays unchanged.
        </p>
        <div className="settings-theme-grid" role="radiogroup" aria-label="UI theme choices">
          {THEME_OPTIONS.map((theme) => (
            <button
              key={theme.id}
              type="button"
              role="radio"
              aria-checked={currentTheme === theme.id}
              aria-pressed={currentTheme === theme.id}
              onClick={() => onThemeChange(theme.id)}
            >
              <strong>{theme.title}</strong>
              <div className="room-help-text">{theme.description}</div>
            </button>
          ))}
        </div>
        <div className="onboarding-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}