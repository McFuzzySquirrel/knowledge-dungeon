/**
 * Audio Manager service for Knowledge Dungeon.
 *
 * Provides a lightweight audio infrastructure for background music
 * and sound effects. Audio files are loaded on-demand and can be
 * toggled, muted, and volume-controlled independently.
 *
 * In the current phase (3b), this sets up the infrastructure with
 * placeholder hooks. Actual audio file creation is deferred.
 */

export type AudioTrack = 'bgm-dungeon' | 'bgm-village' | 'bgm-boss';
export type SfxKind =
  | 'ui-click'
  | 'ui-hover'
  | 'encounter-start'
  | 'encounter-success'
  | 'xp-earn'
  | 'artifact-collect'
  | 'npc-greet'
  | 'door-open'
  | 'boss-encounter'
  | 'achievement-unlock'
  | 'loot-drop'
  | 'portal-enter'
  | 'fish-cast'
  | 'fish-splash'
  | 'fish-bite'
  | 'fish-reel'
  | 'fish-catch'
  | 'fish-miss';

interface AudioManagerState {
  musicEnabled: boolean;
  sfxEnabled: boolean;
  musicVolume: number; // 0–1
  sfxVolume: number; // 0–1
  currentBgm: AudioTrack | null;
  bgmPlaying: boolean;
}

export type AudioStateChangeListener = (state: Readonly<AudioManagerState>) => void;

class AudioManagerImpl {
  private state: AudioManagerState = {
    musicEnabled: true,
    sfxEnabled: true,
    musicVolume: 0.4,
    sfxVolume: 0.6,
    currentBgm: null,
    bgmPlaying: false,
  };

  // Audio cache placeholders — reserved for future audio file integration.
  // private bgmCache = new Map<AudioTrack, unknown>();
  // private sfxCache = new Map<SfxKind, unknown>();
  private listeners = new Set<AudioStateChangeListener>();

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(listener: AudioStateChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  getState(): Readonly<AudioManagerState> {
    return { ...this.state };
  }

  /** Toggle background music on/off */
  toggleMusic(): boolean {
    this.state.musicEnabled = !this.state.musicEnabled;
    if (!this.state.musicEnabled && this.state.currentBgm) {
      this.stopBgmInternal();
    } else if (this.state.musicEnabled && this.state.currentBgm) {
      this.playBgmInternal(this.state.currentBgm);
    }
    this.notify();
    return this.state.musicEnabled;
  }

  /** Toggle sound effects on/off */
  toggleSfx(): boolean {
    this.state.sfxEnabled = !this.state.sfxEnabled;
    this.notify();
    return this.state.sfxEnabled;
  }

  /** Set music volume (0–1) */
  setMusicVolume(volume: number): void {
    this.state.musicVolume = Math.max(0, Math.min(1, volume));
    this.notify();
  }

  /** Set SFX volume (0–1) */
  setSfxVolume(volume: number): void {
    this.state.sfxVolume = Math.max(0, Math.min(1, volume));
    this.notify();
  }

  /** Request background music for a track. If music is enabled, starts playing. */
  playBgm(track: AudioTrack): void {
    if (this.state.currentBgm === track && this.state.bgmPlaying) return;
    this.stopBgmInternal();
    this.state.currentBgm = track;
    if (this.state.musicEnabled) {
      this.playBgmInternal(track);
    }
    this.notify();
  }

  /** Stop background music */
  stopBgm(): void {
    this.state.currentBgm = null;
    this.stopBgmInternal();
    this.notify();
  }

  /** Play a sound effect. No-op if SFX is disabled. */
  playSfx(kind: SfxKind): void {
    if (!this.state.sfxEnabled) return;
    this.playSfxInternal(kind);
  }

  // ── Internal (placeholder) methods ──────────────────────────────

  private playBgmInternal(track: AudioTrack): void {
    this.state.bgmPlaying = true;
    // Placeholder: in production, load and play this.bgmCache.get(track)
    if (track) { /* audio playback not yet implemented */ }
  }

  private stopBgmInternal(): void {
    this.state.bgmPlaying = false;
    // Placeholder: stop current BGM here
  }

  private playSfxInternal(kind: SfxKind): void {
    // Placeholder: play one-shot SFX here
    if (kind) { /* audio playback not yet implemented */ }
  }
}

/** Singleton audio manager instance */
export const audioManager = new AudioManagerImpl();

/** React hook-friendly getter for the current audio state */
export function getAudioState(): Readonly<AudioManagerState> {
  return audioManager.getState();
}
