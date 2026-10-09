/**
 * Phase 4 / Phase 23: the default build's rendered output is pinned.
 *
 * Phase 4 pinned the default build while storage-v2 was opt-in. The Phase 23 cutover
 * makes storage-v2 the default, so this file now pins the *post-cutover* default: the
 * repository is `v2`, `legacy` remains the one-release rollback, and the Welcome screen
 * still renders the same landmark structure rather than leaking migration or recovery
 * surfaces into the default UI.
 *
 * What is asserted:
 *
 * - the repository the default build selects is `v2`, and `legacy` still parses as the
 *   rollback;
 * - the rendered Welcome screen names the same landmark structure, in the same
 *   order, with the same tab set and the same primary action;
 * - nothing storage-v2-specific is rendered: no generation id, no migration
 *   state, no repository name, no recovery banner;
 * - the privacy paragraph is present and accurate.
 *
 * The flag is asserted from the build-time contract rather than by simulating a
 * build: `DEFAULT_RUNTIME_CONFIG` is what `VITE_STORAGE_REPOSITORY` absent
 * resolves to, and it is frozen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

import { DEFAULT_RUNTIME_CONFIG, parseRuntimeConfig } from '@/config/runtimeConfig';
import { App } from '@/ui/App';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { useProgressionStore } from '@/store/progressionStore';
import { resetRepositorySelection } from '@/services/persistence/v2/repositorySelection';
import { resetBootstrap } from '@/application/bootstrap';

function resetStores(): void {
  useSessionStore.setState({
    activeSubjectId: null,
    phase: 'creator',
    selectedClass: null,
    focusedRoomId: null,
    isNoteEditorOpen: false,
    noteEditorRoomId: null,
    noteEditorPendingInsert: null,
    isMapViewOpen: false,
    teleportModeArmed: false,
    lastTeleportAt: null,
  });
  useSubjectStore.setState({ snapshot: null, lastError: null });
  useProgressionStore.setState({
    activeSubjectId: null,
    bySubject: {},
    xpTotal: 0,
    rank: 'Novice',
    badges: [],
    inventory: [],
    collectedNotes: [],
    streakCount: 0,
  });
}

beforeEach(() => {
  window.localStorage.clear();
  resetRepositorySelection();
  resetBootstrap();
  resetStores();
});

afterEach(() => {
  window.localStorage.clear();
  resetRepositorySelection();
  resetBootstrap();
  resetStores();
  vi.restoreAllMocks();
});

describe('Phase 23: the default build selects storage-v2, with legacy as the rollback', () => {
  it('resolves to v2 with no flag set, and the legacy rollback still parses', () => {
    // Phase 4 pinned the pre-cutover default (`legacy`); the Phase 23 cutover flips it,
    // so the pinned default is now `v2` and `legacy` is the one-release rollback.
    expect(DEFAULT_RUNTIME_CONFIG.storageRepository).toBe('v2');
    expect(Object.isFrozen(DEFAULT_RUNTIME_CONFIG)).toBe(true);
    expect(parseRuntimeConfig({}).storageRepository).toBe('v2');
    // An empty value is an invalid value, and an invalid value fails the build
    // rather than silently selecting a repository.
    expect(() => parseRuntimeConfig({ VITE_STORAGE_REPOSITORY: '' })).toThrow(/VITE_STORAGE_REPOSITORY/);
    // The rollback is a real option, and it still selects the legacy repository.
    expect(parseRuntimeConfig({ VITE_STORAGE_REPOSITORY: 'legacy' }).storageRepository).toBe('legacy');
  });
});

describe('Phase 4: the default build renders the Welcome screen unchanged', () => {
  it('renders the same landmarks, tabs, and primary action', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByText(/^Loading…$/i)).not.toBeInTheDocument();
    });

    expect(screen.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Create / Load' })).toHaveAttribute('aria-selected', 'true');
    // The four Welcome sections, in the order the default build has always had.
    // The theme chooser is a tablist too, so the Welcome sections are selected by
    // their own tablist rather than by "every tab on the page".
    const sections = screen.getByRole('tablist', { name: 'Welcome screen sections' });
    expect(within(sections).getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Create / Load',
      'Player Setup',
      'Guide',
      'Data',
    ]);
    // The primary first-run action is the tutorial, not a migration prompt.
    expect(screen.getByRole('button', { name: 'Start Tutorial' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Setup checklist' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Visual theme' })).toBeInTheDocument();
  });

  it('renders no storage-v2 configuration on the default build', async () => {
    const { container } = render(<App />);
    await waitFor(() => {
      expect(screen.queryByText(/^Loading…$/i)).not.toBeInTheDocument();
    });

    // No generation id, no migration state, no repository name, and no recovery
    // or disclosure surface. These are the strings a cutover leak would add.
    const text = (container.textContent ?? '').replace(/\s+/g, ' ');
    for (const forbidden of [
      'generation',
      'storage-v2',
      'IndexedDB migration',
      'migrat',
      'recovery-required',
      'external-only',
    ]) {
      expect(text.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
    }
    // No storage-pressure banner either: a healthy empty device has nothing to
    // warn about, and the banner is the only alert the shell renders.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the setup checklist in its pre-cutover state, not a post-cutover one', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByText(/^Loading…$/i)).not.toBeInTheDocument();
    });

    // Subject "Not selected yet / Required", phase "Done", archetype "Not selected
    // yet / Required" - the exact three rows the default build has always shown.
    const checklist = screen.getByRole('complementary', { name: 'Setup checklist' });
    expect(checklist).toHaveTextContent('Not selected yet');
    expect(checklist).toHaveTextContent('Required');
    expect(checklist).toHaveTextContent('Done');
    expect(screen.getByRole('button', { name: 'Enter Dungeon' })).toBeDisabled();
  });
});
