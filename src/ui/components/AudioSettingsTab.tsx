/**
 * Phase 10: the accessible audio settings panel.
 *
 * ## What this file is
 *
 * A control panel, and nothing else. Every control writes a persisted preference
 * through `usePreferencesStore` and stops there. The store publishes the resolved
 * value into the running audio service on every action, so this file has no reason
 * to know that an audio manager exists - and it deliberately does not import one:
 *
 * - it never constructs an `AudioContext`,
 * - it never registers a gesture listener,
 * - it never calls `unlock`, `playBgm`, or `playSfx`.
 *
 * That last point is the one that matters. The gesture gate is the audio service's
 * single place, and unlocking from a settings click would make "no sound before a
 * user gesture" true only by accident of call order - the first learner to open
 * Settings and move a slider would allocate an audio device on a route that may
 * never play anything. A control panel that starts a player is also a control panel
 * whose controls can be wrong about what is playing.
 *
 * Because the store is the only thing this panel talks to, persistence is the
 * store's question rather than this file's: `setMuted`, `setMusicVolume`,
 * `setSfxVolume`, `setMusicEnabled`, and `setSfxEnabled` each persist the whole
 * payload synchronously, so mute survives a route change and a reload without
 * anything here remembering it.
 *
 * ## Why native controls
 *
 * Both volumes are `<input type="range">` and all three on/off controls are
 * `<button role="switch">`. No arrow-key handling, no `Home`/`End`, no `Space` is
 * reimplemented: the platform owns keyboard operation, so a keyboard learner gets
 * the behaviour their operating system documents and a screen reader gets the
 * standard slider and switch semantics. A hand-rolled slider built on a `div` is
 * the usual way this requirement fails - a click target with no value announcement,
 * no `Home`/`End`, and a focus ring that exists only in a designer's screenshot.
 *
 * Each switch carries the word "On" or "Off" in its own face, so its state is
 * readable without colour and without ARIA, and the three switches sit inside
 * `fieldset`/`legend` groups a screen reader can navigate by name.
 *
 * ## The distinction this panel has to teach
 *
 * `muted` is not "music off" and not "sound effects off". It is a global silence
 * that leaves the two per-bus choices and both volumes alone, so un-muting restores
 * exactly what the learner had. The audio contract says that; the interface has to
 * say it too, because three switches that look alike are three guesses. So:
 *
 * - the mute row's own help text says it silences everything *now* and keeps the
 *   two volume settings and the two per-bus choices;
 * - each bus row's help text says its own toggle is remembered separately;
 * - a summary line restates the current mode in words.
 *
 * None of that depends on colour, and the panel never disables a volume slider when
 * its bus is off. Disabling would be the tidier-looking answer and the worse one: it
 * removes a control from the tab order exactly when a learner who has music off may
 * want to set the level for next time, and a disabled control is a thing a screen
 * reader user has to go looking for.
 *
 * ## Where the numbers come from
 *
 * The store holds a 0-1 float; the sliders work in whole percent. Display rounds,
 * input divides, and the rounding happens *before* the value reaches the input so
 * `value` is always on the slider's own step - a stored 0.375 renders as 38 rather
 * than as a value the native control would snap to the nearest step on its own.
 * `aria-valuenow`, `aria-valuetext`, and the visible readout all come from that one
 * number, so they cannot disagree with each other or with the stored value.
 *
 * The `aria-valuenow` / `aria-valuemin` / `aria-valuemax` trio is written out even
 * though a native range derives it. Deriving is fine in a browser and untestable in
 * jsdom, and an accessibility value that can only be checked by driving a real
 * browser is one that quietly stops being checked.
 *
 * ## Identifiers
 *
 * Every `id` here is a fixed constant from {@link AUDIO_IDS}. Nothing is derived
 * from anything a learner typed or owns, so no subject name, room id, or note can
 * reach an attribute value through this panel.
 */

import { type JSX } from 'react';
import { useTranslation } from 'react-i18next';

import { usePreferencesStore } from '@/store/preferencesStore';

import './audioSettings.css';

/**
 * Fixed DOM ids for the panel's controls, labels, and help text.
 *
 * Fixed on purpose: an id built from a subject name or a note would put learner
 * data into the document, where anything with the page can read it.
 */
const AUDIO_IDS = {
  mute: 'settings-audio-mute',
  muteLabel: 'settings-audio-mute-label',
  muteHelp: 'settings-audio-mute-help',
  music: 'settings-audio-music',
  musicLabel: 'settings-audio-music-label',
  musicHelp: 'settings-audio-music-help',
  musicVolume: 'settings-audio-music-volume',
  musicVolumeLabel: 'settings-audio-music-volume-label',
  musicVolumeValue: 'settings-audio-music-volume-value',
  sfx: 'settings-audio-sfx',
  sfxLabel: 'settings-audio-sfx-label',
  sfxHelp: 'settings-audio-sfx-help',
  sfxVolume: 'settings-audio-sfx-volume',
  sfxVolumeLabel: 'settings-audio-sfx-volume-label',
  sfxVolumeValue: 'settings-audio-sfx-volume-value',
} as const;

/** The sliders' own bounds, in percent. */
const VOLUME_MIN = 0;
const VOLUME_MAX = 100;
const VOLUME_STEP = 1;

/**
 * A stored 0-1 volume as whole percent.
 *
 * Rounded rather than truncated so a stored 0.07 reads as 7 rather than 6, and
 * rounded here rather than left to the control so the value handed to the input is
 * always on the step grid.
 */
function percentOf(volume: number): number {
  return Math.round(volume * VOLUME_MAX);
}

interface AudioSwitchProps {
  /** Fixed id of the control. */
  id: string;
  /** Fixed id of the element holding the control's name. */
  labelId: string;
  /** Fixed id of the element holding the control's help text. */
  helpId: string;
  /** The visible name. */
  label: string;
  /** The help text that teaches what this switch does, and what it does not. */
  help: string;
  checked: boolean;
  /** Receives the requested state, not the negated current one. */
  onToggle: (next: boolean) => void;
  /** Word for the on state, in the panel's own language. */
  onLabel: string;
  /** Word for the off state. */
  offLabel: string;
}

/**
 * One on/off control.
 *
 * `role="switch"` rather than a checkbox because "on" and "off" is what the audio
 * contract means, and a checkbox announces "checked", which reads as a tick in a form
 * rather than as a running thing. The button underneath means Enter and Space work
 * with no key handler here, and the state word in its face is the non-colour signal,
 * with `aria-checked` carrying the same state to assistive technology.
 */
function AudioSwitch({
  id,
  labelId,
  helpId,
  label,
  help,
  checked,
  onToggle,
  onLabel,
  offLabel,
}: AudioSwitchProps): JSX.Element {
  return (
    <div className="kd-audio-row">
      <div className="kd-audio-row-head">
        <span className="kd-audio-label" id={labelId}>
          {label}
        </span>
        <button
          type="button"
          id={id}
          className="kd-audio-switch"
          role="switch"
          aria-checked={checked}
          aria-labelledby={labelId}
          aria-describedby={helpId}
          onClick={() => onToggle(!checked)}
        >
          {/* The state word is the non-colour signal, and it is `aria-hidden`
              because the control's name is the label beside it and its state is
              `aria-checked`: announcing "Music On" as the name would restate both
              and make the switch's name change as it is toggled. */}
          <span className="kd-audio-switch-state" aria-hidden="true">
            {checked ? onLabel : offLabel}
          </span>
        </button>
      </div>
      <p className="kd-audio-help" id={helpId}>
        {help}
      </p>
    </div>
  );
}

interface AudioVolumeProps {
  /** Fixed id of the slider. */
  id: string;
  /** Fixed id of the element holding the slider's name. */
  labelId: string;
  /** Fixed id of the element holding the slider's help text. */
  helpId: string;
  /** Fixed id of the visible current-value readout. */
  valueId: string;
  label: string;
  help: string;
  /** Whole percent, already rounded onto the slider's step. */
  percent: number;
  /** Receives whole percent. */
  onChange: (percent: number) => void;
  /** The visible readout text, already localised. */
  valueText: string;
}

/**
 * One volume control: a native range, a real label, and a number in plain sight.
 *
 * A bare slider is the common failure this exists to avoid - a learner who cannot
 * see the thumb position, or a screen reader announcing "slider" and nothing else,
 * is left guessing. `aria-valuetext` carries the same percentage the visible readout
 * shows, which is why that readout is `aria-hidden`: the value is announced once,
 * from the control that owns it.
 */
function AudioVolume({
  id,
  labelId,
  helpId,
  valueId,
  label,
  help,
  percent,
  onChange,
  valueText,
}: AudioVolumeProps): JSX.Element {
  return (
    <div className="kd-audio-row">
      <div className="kd-audio-row-head">
        {/* The `htmlFor` is the association; no `aria-labelledby` on the input, so
            the name comes from the platform's own label mechanism. */}
        <label className="kd-audio-label" id={labelId} htmlFor={id}>
          {label}
        </label>
        <span className="kd-audio-value" id={valueId} aria-hidden="true">
          {valueText}
        </span>
      </div>
      <input
        type="range"
        id={id}
        className="kd-audio-range"
        min={VOLUME_MIN}
        max={VOLUME_MAX}
        step={VOLUME_STEP}
        value={percent}
        aria-valuemin={VOLUME_MIN}
        aria-valuemax={VOLUME_MAX}
        aria-valuenow={percent}
        aria-valuetext={valueText}
        aria-describedby={helpId}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <p className="kd-audio-help" id={helpId}>
        {help}
      </p>
    </div>
  );
}

/**
 * The Audio tab panel.
 *
 * It owns its `tabpanel` role, so the tab and the panel it opens travel together and
 * the panel can be rendered - and tested - on its own.
 */
export function AudioSettingsTab(): JSX.Element {
  const { t } = useTranslation();

  // Selector-based reads, so a change to one preference re-renders only what that
  // preference touches.
  const musicVolume = usePreferencesStore((s) => s.musicVolume);
  const sfxVolume = usePreferencesStore((s) => s.sfxVolume);
  const muted = usePreferencesStore((s) => s.muted);
  const musicEnabled = usePreferencesStore((s) => s.musicEnabled);
  const sfxEnabled = usePreferencesStore((s) => s.sfxEnabled);
  const setMusicVolume = usePreferencesStore((s) => s.setMusicVolume);
  const setSfxVolume = usePreferencesStore((s) => s.setSfxVolume);
  const setMuted = usePreferencesStore((s) => s.setMuted);
  const setMusicEnabled = usePreferencesStore((s) => s.setMusicEnabled);
  const setSfxEnabled = usePreferencesStore((s) => s.setSfxEnabled);

  const onLabel = t('settings.audioOn', 'On');
  const offLabel = t('settings.audioOff', 'Off');
  const percentText = (value: number): string => t('settings.audioPercent', '{{value}}%', { value });

  const musicPercent = percentOf(musicVolume);
  const sfxPercent = percentOf(sfxVolume);

  return (
    <div
      className="kd-audio-settings"
      role="tabpanel"
      aria-label={t('settings.audioPanel', 'Audio settings')}
    >
      <p className="kd-audio-intro">
        {t(
          'settings.audioDescription',
          'Choose what plays and how loud it is. Nothing plays until you interact with the page, and every choice here is remembered on this device.',
        )}
      </p>

      <fieldset className="kd-audio-group">
        <legend className="kd-audio-legend">{t('settings.audioMuteLegend', 'Mute')}</legend>
        <AudioSwitch
          id={AUDIO_IDS.mute}
          labelId={AUDIO_IDS.muteLabel}
          helpId={AUDIO_IDS.muteHelp}
          label={t('settings.audioMuteLabel', 'Mute all sound')}
          help={t(
            'settings.audioMuteHelp',
            'Silences music and sound effects right now, including anything already playing. Your two volume settings and your two on/off choices are remembered, so turning Mute off again brings back exactly what you had. Turning a bus off below is a different choice, and is remembered on its own.',
          )}
          checked={muted}
          onToggle={setMuted}
          onLabel={onLabel}
          offLabel={offLabel}
        />
      </fieldset>

      <fieldset className="kd-audio-group">
        <legend className="kd-audio-legend">
          {t('settings.audioMusicLegend', 'Music')}
        </legend>
        <AudioSwitch
          id={AUDIO_IDS.music}
          labelId={AUDIO_IDS.musicLabel}
          helpId={AUDIO_IDS.musicHelp}
          label={t('settings.audioMusicLabel', 'Background music')}
          help={t(
            'settings.audioMusicHelp',
            'Turns background music on or off. This choice is remembered separately from Mute, and the volume below is kept whether music is on or off.',
          )}
          checked={musicEnabled}
          onToggle={setMusicEnabled}
          onLabel={onLabel}
          offLabel={offLabel}
        />
        <AudioVolume
          id={AUDIO_IDS.musicVolume}
          labelId={AUDIO_IDS.musicVolumeLabel}
          helpId={AUDIO_IDS.musicHelp}
          valueId={AUDIO_IDS.musicVolumeValue}
          label={t('settings.audioMusicVolumeLabel', 'Music volume')}
          help={t(
            'settings.audioMusicVolumeHelp',
            'How loud music plays. Move it with the left and right arrow keys, or with Home and End for silent and full.',
          )}
          percent={musicPercent}
          onChange={(percent) => setMusicVolume(percent / VOLUME_MAX)}
          valueText={percentText(musicPercent)}
        />
      </fieldset>

      <fieldset className="kd-audio-group">
        <legend className="kd-audio-legend">
          {t('settings.audioSfxLegend', 'Sound effects')}
        </legend>
        <AudioSwitch
          id={AUDIO_IDS.sfx}
          labelId={AUDIO_IDS.sfxLabel}
          helpId={AUDIO_IDS.sfxHelp}
          label={t('settings.audioSfxLabel', 'Sound effects')}
          help={t(
            'settings.audioSfxHelp',
            'Turns the short sounds - steps, pickups, and feedback - on or off. This choice is remembered separately from Mute, and the volume below is kept whether effects are on or off.',
          )}
          checked={sfxEnabled}
          onToggle={setSfxEnabled}
          onLabel={onLabel}
          offLabel={offLabel}
        />
        <AudioVolume
          id={AUDIO_IDS.sfxVolume}
          labelId={AUDIO_IDS.sfxVolumeLabel}
          helpId={AUDIO_IDS.sfxHelp}
          valueId={AUDIO_IDS.sfxVolumeValue}
          label={t('settings.audioSfxVolumeLabel', 'Sound effects volume')}
          help={t(
            'settings.audioSfxVolumeHelp',
            'How loud the short sounds play. Move it with the left and right arrow keys, or with Home and End for silent and full.',
          )}
          percent={sfxPercent}
          onChange={(percent) => setSfxVolume(percent / VOLUME_MAX)}
          valueText={percentText(sfxPercent)}
        />
      </fieldset>

      {/*
        The current mode, in words.

        A summary rather than a live region on purpose: it restates what the three
        controls already expose, and making it `aria-live` would announce it again on
        every arrow-key press of a volume slider, which is noise rather than news.
      */}
      <p className="kd-audio-summary">
        {muted
          ? t(
              'settings.audioSummaryMuted',
              'Muted now. Nothing plays, and your volumes and on/off choices are kept for when you unmute.',
            )
          : t(
              'settings.audioSummaryOn',
              'Sound is on. Music and sound effects use the levels you set here.',
            )}
      </p>
    </div>
  );
}
