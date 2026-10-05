import { Suspense, lazy, useState, type JSX } from 'react';
import type { ColorTheme } from '@/store/preferencesStore';
import { useShortcutStore, type ShortcutBinding } from '@/store/shortcutStore';
import { SUPPORTED_LOCALES, LOCALE_LABELS, type SupportedLocale } from '@/i18n';
import i18n from '@/i18n';
import { useTranslation } from 'react-i18next';
import { AudioSettingsTab } from '@/ui/components/AudioSettingsTab';
import { runtimeConfig } from '@/config/featureFlags';
import { ASSISTANCE_TAB_ID, visibleSettingsTabs } from '@/ui/assistance/settingsTabGate';

/**
 * Phase 19: the assistance tab, **lazily** imported.
 *
 * `AssistanceSettings` reads `useAssistanceStore`, so a static import from this eagerly reachable
 * module would put the assistance lane in the entry document's static closure - ten kilobytes of
 * Welcome budget for a feature whose flag is `false` by default. `lazy` keeps the edge dynamic, so
 * the lane is fetched when the tab is opened and never otherwise.
 *
 * Two earlier rationales for this line are now stale and were removed rather than left to rot. It
 * used to name `vite.config.ts`'s `feature-assistance` `manualChunks` group, which
 * `infrastructure-engineer` replaced with a module-membership plus reachability census; and it used
 * to imply that `lazy` alone was enough. Neither is true now: the build **fails** if an assistance
 * lane module ends up in the static closure, so this line is load-bearing in a way a comment cannot
 * enforce - and the correct response to that failure is to keep the import dynamic, never to relax
 * the config. See the module header of `src/ui/assistance/AssistanceSlot.tsx` for the same
 * constraint from the other side.
 *
 * A `Suspense` boundary with `fallback={null}`, for the reason `AssistanceSlot` uses one: a fallback
 * is an element, and an element that exists only to be replaced is still an element. The tab panel
 * around it is already an empty region while the chunk is in flight, so nothing appears to jump.
 */
const AssistanceSettingsTab = lazy(
  async () => ({ default: (await import('@/ui/assistance/AssistanceSettings')).AssistanceSettings }),
);
import { MakeItYoursModal } from '@/ui/components/MakeItYoursModal';

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
type SettingsTab = 'theme' | 'language' | 'shortcuts' | 'audio' | 'assistance';

interface TabDef {
  id: SettingsTab;
  /**
   * The English label, kept as the i18next fallback.
   *
   * Every tab carries a key so the strip is translatable like the rest of the
   * settings strings. The fallbacks are the literal labels this file has always
   * rendered, so English is unchanged by the addition.
   */
  label: string;
  labelKey: string;
}

/**
 * Every tab this modal knows how to render, in order.
 *
 * The list is the **full** one; what a build shows is {@link visibleTabs} below. Keeping the two
 * apart is what lets `tests/unit/audioSettingsTab.test.tsx` keep asserting the default build's
 * whole-list equality - the production list is this array with one entry removed, not a shorter
 * array that a later edit could silently shorten.
 */
const SETTINGS_TABS: TabDef[] = [
  { id: 'theme', label: 'Theme', labelKey: 'settings.tabs.theme' },
  { id: 'language', label: 'Language', labelKey: 'settings.tabs.language' },
  { id: 'shortcuts', label: 'Shortcuts', labelKey: 'settings.tabs.shortcuts' },
  { id: 'audio', label: 'Audio', labelKey: 'settings.tabs.audio' },
  // Phase 19. Gated on `runtimeConfig.adaptiveAssistance` - see the module header of
  // `src/ui/assistance/settingsTabGate.ts` for why the decision is a pure function of the flag
  // rather than a constant read here.
  //
  // `productionDefault: false` is a **cutover** flag, so on the default build this build cannot
  // produce a single suggestion. A visible, labelled, interactive tab for a feature that can never
  // speak is worse than no tab at all: a learner sets Gentle, sees nothing anywhere, and concludes
  // the product is broken. Silence is the honest default, and the flag is how a build opts in.
  { id: ASSISTANCE_TAB_ID as SettingsTab, label: 'Assistance', labelKey: 'settings.tabs.assistance' },
];

export function SettingsModal({ currentTheme, onThemeChange, onClose }: SettingsModalProps): JSX.Element {
  const { t } = useTranslation();
  const shortcuts = useShortcutStore((s) => s.shortcuts);
  // Identity-based, so a rebind cannot depend on where a binding sits in the list.
  const setShortcutForAction = useShortcutStore((s) => s.setShortcutForAction);
  const resetShortcuts = useShortcutStore((s) => s.resetShortcuts);
  const [activeTab, setActiveTab] = useState<SettingsTab>('theme');
  // Phase 19: what this build shows. The flag is read here and handed to a pure function, so the
  // decision is reachable from a test in both directions without mocking `@/config/featureFlags`.
  const visibleTabs = visibleSettingsTabs(SETTINGS_TABS, runtimeConfig.adaptiveAssistance);
  const [editingShortcutIndex, setEditingShortcutIndex] = useState<number | null>(null);
  const [makeItYoursOpen, setMakeItYoursOpen] = useState(false);
  const currentLang = (i18n.language?.split('-')[0] ?? 'en') as SupportedLocale;

  function handleLanguageChange(lang: SupportedLocale): void {
    void i18n.changeLanguage(lang);
  }

  function handleShortcutKeyDown(e: React.KeyboardEvent<HTMLInputElement>, labelKey: string): void {
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
      setShortcutForAction(labelKey, e.key);
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
              onKeyDown={(e) => handleShortcutKeyDown(e, shortcut.labelKey)}
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
    <>
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
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={activeTab === tab.id ? 'settings-tab active' : 'settings-tab'}
              onClick={() => setActiveTab(tab.id as SettingsTab)}
            >
              {t(tab.labelKey, tab.label)}
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

        {/* Language Tab - Phase 5: i18n */}
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

        {/* Shortcuts Tab - Phase 5: Keyboard shortcut customization */}
        {activeTab === 'shortcuts' && (
          <div role="tabpanel" aria-label="Keyboard shortcut settings">
            <p className="room-help-text">
              {t('settings.shortcutsDescription', 'Customize keyboard shortcuts for common actions.')}
            </p>
            <div className="shortcut-list" role="list" aria-label="Keyboard shortcuts">
              {shortcuts.map((shortcut, index) => renderShortcutRow(shortcut, index))}
            </div>
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

        {/* Audio Tab - Phase 10: music, sound effects, and mute */}
        {activeTab === 'audio' && <AudioSettingsTab />}

        {/* Assistance Tab - Phase 19: mode, and the dismissal record */}
        {activeTab === ASSISTANCE_TAB_ID && (
          <div role="tabpanel" aria-label="Assistance settings">
            <Suspense fallback={null}>
              {/* The modal's own narrowing, reused: it is the same `currentLang` the language
                  tab writes with, so the assistance copy cannot disagree with it. */}
              <AssistanceSettingsTab locale={currentLang} />
            </Suspense>
          </div>
        )}

        <div className="onboarding-actions">
          <button type="button" className="ghost" onClick={() => setMakeItYoursOpen(true)}>
            {t('settings.makeItYours', 'Make It Yours')}
          </button>
          <button type="button" className="ghost" onClick={onClose}>
            {t('common.close', 'Close')}
          </button>
        </div>
      </div>
      </div>
      {makeItYoursOpen && (
        <MakeItYoursModal onClose={() => setMakeItYoursOpen(false)} />
      )}
    </>
  );
}
