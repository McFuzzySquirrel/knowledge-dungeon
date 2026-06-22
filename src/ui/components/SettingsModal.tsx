import { useState, type JSX } from 'react';
import type { ColorTheme } from '@/store/preferencesStore';
import { useShortcutStore, type ShortcutBinding } from '@/store/shortcutStore';
import { SUPPORTED_LOCALES, LOCALE_LABELS, type SupportedLocale } from '@/i18n';
import i18n from '@/i18n';
import { useTranslation } from 'react-i18next';
import { MakeItYoursTab } from '@/ui/components/MakeItYoursTab';

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

/** Tab definition for the settings modal. */
type SettingsTab = 'theme' | 'language' | 'shortcuts' | 'make-it-yours';

interface TabDef {
  id: SettingsTab;
  label: string;
}

const SETTINGS_TABS: TabDef[] = [
  { id: 'theme', label: 'Theme' },
  { id: 'language', label: 'Language' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'make-it-yours', label: 'Make It Yours' },
];

export function SettingsModal({ currentTheme, onThemeChange, onClose }: SettingsModalProps): JSX.Element {
  const { t } = useTranslation();
  const shortcuts = useShortcutStore((s) => s.shortcuts);
  const setShortcutKey = useShortcutStore((s) => s.setShortcutKey);
  const resetShortcuts = useShortcutStore((s) => s.resetShortcuts);
  const [activeTab, setActiveTab] = useState<SettingsTab>('theme');
  const [editingShortcutIndex, setEditingShortcutIndex] = useState<number | null>(null);
  const currentLang = (i18n.language?.split('-')[0] ?? 'en') as SupportedLocale;

  function handleLanguageChange(lang: SupportedLocale): void {
    void i18n.changeLanguage(lang);
  }

  function handleShortcutKeyDown(e: React.KeyboardEvent<HTMLInputElement>, index: number): void {
    e.preventDefault();
    e.stopPropagation();
    // Capture the key and set it
    if (e.key.length === 1 || e.key === 'Escape' || e.key === 'Backspace') {
      if (e.key === 'Escape') {
        setEditingShortcutIndex(null);
        return;
      }
      if (e.key === 'Backspace') {
        setEditingShortcutIndex(null);
        return;
      }
      setShortcutKey(index, e.key);
      setEditingShortcutIndex(null);
    }
  }

  function renderShortcutRow(shortcut: ShortcutBinding, index: number): JSX.Element {
    const isEditing = editingShortcutIndex === index;
    return (
      <div key={index} className="shortcut-row" role="group" aria-label={shortcut.label}>
        <span className="shortcut-label">
          {t(shortcut.labelKey, shortcut.label)}
        </span>
        <div className="shortcut-key-group">
          {shortcut.ctrlKey && <kbd>Ctrl</kbd>}
          {shortcut.shiftKey && <kbd>Shift</kbd>}
          {isEditing ? (
            <input
              className="shortcut-key-input"
              autoFocus
              onKeyDown={(e) => handleShortcutKeyDown(e, index)}
              onBlur={() => setEditingShortcutIndex(null)}
              placeholder="Press a key"
              aria-label={`Press a new key for ${shortcut.label}`}
            />
          ) : (
            <button
              type="button"
              className="shortcut-key-btn"
              onClick={() => setEditingShortcutIndex(index)}
              aria-label={`Change keyboard shortcut for ${shortcut.label}, currently ${shortcut.key}`}
            >
              <kbd>{shortcut.key.toUpperCase()}</kbd>
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.title', 'Settings')}
        onClick={(event) => event.stopPropagation()}
      >
        <h2>{t('settings.title', 'Settings')}</h2>

        {/* Phase 5: Tab navigation in settings */}
        <div className="settings-tabs" role="tablist" aria-label="Settings categories">
          {SETTINGS_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={activeTab === tab.id ? 'settings-tab active' : 'settings-tab'}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Theme Tab */}
        {activeTab === 'theme' && (
          <div role="tabpanel" aria-label="Theme settings">
            <p className="room-help-text">
              {t('settings.themeDescription', 'Choose the visual theme for menus and other UI panels.')}
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
          </div>
        )}

        {/* Language Tab — Phase 5: i18n */}
        {activeTab === 'language' && (
          <div role="tabpanel" aria-label="Language settings">
            <p className="room-help-text">
              {t('settings.languageDescription', 'Choose your preferred language.')}
            </p>
            <div className="settings-language-grid" role="radiogroup" aria-label="Language choices">
              {SUPPORTED_LOCALES.map((locale) => (
                <button
                  key={locale}
                  type="button"
                  role="radio"
                  aria-checked={currentLang === locale}
                  aria-pressed={currentLang === locale}
                  onClick={() => handleLanguageChange(locale)}
                >
                  <strong>{LOCALE_LABELS[locale]}</strong>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Shortcuts Tab — Phase 5: Keyboard shortcut customization */}
        {activeTab === 'shortcuts' && (
          <div role="tabpanel" aria-label="Keyboard shortcut settings">
            <p className="room-help-text">
              {t('settings.shortcutsDescription', 'Customize keyboard shortcuts for common actions.')}
            </p>
            <div className="shortcut-list" role="list" aria-label="Keyboard shortcuts">
              {shortcuts.map((shortcut, index) => renderShortcutRow(shortcut, index))}
            </div>
        {/* Make It Yours Tab — sprite customization */}
        {activeTab === 'make-it-yours' && <MakeItYoursTab />}

        <div className="onboarding-actions">
              <button
                type="button"
                className="ghost"
                onClick={resetShortcuts}
                aria-label={t('settings.resetDefaults', 'Reset all shortcuts to default values')}
              >
                {t('settings.resetDefaults', 'Reset Defaults')}
              </button>
            </div>
          </div>
        )}

        <div className="onboarding-actions">
          <button type="button" className="ghost" onClick={onClose}>
            {t('common.close', 'Close')}
          </button>
        </div>
      </div>
    </div>
  );
}
