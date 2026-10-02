/**
 * The structure panel: what a village building says when you stand next to it.
 *
 * ## What this is
 *
 * Thirteen `infoPanel?.type === '…'` blocks lifted out of `VillageScreen.tsx` and
 * put behind one dispatcher, so that adding a structure is a data change rather
 * than a thirteenth copy of the panel frame. The copy in each body is the
 * pre-Phase-12 copy; the frame around it is new.
 *
 * ## The frame is the point
 *
 * Pre-Phase-12 every one of those blocks rendered the same fixed
 * bottom-centred box, at every viewport. `VillagePanel` now seats the same box as
 * a Cozy **side panel** on a wide pointer-and-keyboard viewport and a Cozy
 * **bottom sheet** on touch or narrow, with the semantics each implies - a
 * labelled `region` that never steals focus on the side, a `role="dialog"` that
 * takes and contains focus and closes on `Escape` on the sheet. The plan's
 * requirement is "Cozy side panels on wide screens and bottom sheets on touch
 * devices", and the reason it needed saying is that the previous answer was
 * "neither, on either".
 *
 * Every body also gains a labelled ≥44-pixel dismiss control. The old way to
 * close a structure panel was to walk away from the structure, which is a
 * *movement* instruction used as a *dismissal* mechanism: unavailable to a
 * keyboard user standing still, and unavailable to anyone whose renderer is not
 * currently reporting proximity.
 *
 * ## What stays exactly as it was
 *
 * The copy, the controls, the class names, the `select` that rewrites a dungeon's
 * biome on change, the tutorial launcher, the full game guide toggle, the fishing
 * entry. This is a split, not a redesign, and every one of those is a behaviour
 * another lane's tests or a phase's manual check depends on.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { FLOOR_BIOME_IDS } from '@/core/biomes';
import { GAME_GUIDE_MARKDOWN } from '@/data/gameGuide';
import type { StudyFlowVillageInfoPanel } from '@/application/studyFlow';
import {
  loadSubjectSnapshot,
  saveSubjectSnapshot,
} from '@/services/persistence/subjectPersistence';
import { Markdown } from '@/ui/utils/markdown';

import { VillagePanel } from './VillagePanel';
import {
  VILLAGE_TOUCH_TARGET_STYLE,
  type VillageCollectionTotals,
  type VillageStudyTotals,
  type VillageSubjectSummary,
  type VillageSurfaceMode,
} from './villageTypes';

import './villagePanels.css';

/* ── Signposts ──────────────────────────────────────────────────────────── */

/**
 * The direction text a signpost shows.
 *
 * Content, not behaviour, so it lives with the panel that renders it. `signpost-welcome`
 * is deliberately absent: it is the *default* case below, which turns an unknown or
 * unmarked signpost into the village welcome card rather than an empty panel.
 */
const SIGNPOST_INFO: Readonly<Record<string, { icon: string; title: string; lines: readonly string[] }>> =
  Object.freeze({
    'sign-entrance': {
      icon: '🚪',
      title: 'Village Entrance',
      lines: [
        '↑ Straight ahead - Fountain & Market Square',
        '→ East - Guild Hall & Portals',
        '↖ Northwest - Training Grounds',
      ],
    },
    'sign-center': {
      icon: '📍',
      title: 'Central Crossroads',
      lines: [
        '↑ North - Keeper\'s Tower & Library',
        '→ East - Guild Hall & East Portals',
        '↓ South - Fountain, Trophy Hall & South Portals',
        '← West - Training Grounds & West Portals',
      ],
    },
    'sign-library': {
      icon: '📍',
      title: 'North Path Split',
      lines: ['↑ North - Library of Knowledge', '→ East - Keeper\'s Tower'],
    },
    'sign-south': {
      icon: '📍',
      title: 'South Path Split',
      lines: [
        '← West - South Portals',
        '→ East - Trophy Hall',
        '↓ South - Village Gate (Exit)',
      ],
    },
    'sign-east': {
      icon: '📍',
      title: 'East Path Split',
      lines: ['→ East - Guild Hall', '← West - Central Square & North Portals'],
    },
  });

/** Human-readable biome name, from the biome id. */
function biomeLabel(biome: string): string {
  return biome.replace(/([A-Z])/g, ' $1').replace(/^./, (character) => character.toUpperCase());
}

export interface SignpostPanelProps {
  readonly structureId: string;
  readonly colorTheme: string;
  readonly mode: VillageSurfaceMode;
  readonly onClose: () => void;
}

/**
 * A signpost's directions, or the village welcome card for an unmarked one.
 *
 * Extracted from `VillageScreen.tsx` unchanged in behaviour, including the fact
 * that `signpost-welcome` and an unknown id both fall through to the welcome card.
 */
export function SignpostPanel({
  structureId,
  colorTheme,
  mode,
  onClose,
}: SignpostPanelProps): ReactNode {
  const info = SIGNPOST_INFO[structureId];

  if (info === undefined || structureId === 'signpost-welcome') {
    return (
      <VillagePanel
        mode={mode}
        title="Welcome to Dungeon Village"
        subtitle="Your knowledge adventure begins here"
        icon="📋"
        onClose={onClose}
        colorTheme={colorTheme}
      >
        <p className="village-info-desc">
          This village is your home base. Explore the buildings to create subjects, enter
          dungeons, and track your progress.
        </p>
        <div className="village-info-actions" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          <span>🏛 Keeper's Tower - Meet your guide</span>
          <span>⚒ Guild Hall - Create new subjects</span>
          <span>🌀 Portals - Enter your dungeons</span>
          <span>🎓 Training Grounds - Learn the basics</span>
          <span>🏆 Trophy Hall - View collections</span>
        </div>
      </VillagePanel>
    );
  }

  return (
    <VillagePanel
      mode={mode}
      title={info.title}
      subtitle="Approach to read directions"
      icon={info.icon}
      onClose={onClose}
      colorTheme={colorTheme}
    >
      <ul className="village-subject-list" style={{ gap: 4, listStyle: 'none', margin: 0, padding: 0 }}>
        {info.lines.map((line) => (
          <li
            key={line}
            className="village-subject-item"
            style={{ fontSize: 12, color: 'var(--text-secondary)' }}
          >
            {line}
          </li>
        ))}
      </ul>
    </VillagePanel>
  );
}

/* ── The dispatcher ─────────────────────────────────────────────────────── */

export interface StructurePanelProps {
  /** Which structure is open, and what kind it is. */
  readonly infoPanel: StudyFlowVillageInfoPanel;
  /** Closes the panel. */
  readonly onClose: () => void;
  /** The Cozy shape to take. */
  readonly mode: VillageSurfaceMode;
  /** The `data-theme` value the screen is themed with. */
  readonly colorTheme: string;
  /** The subjects the village lists. */
  readonly subjects: readonly VillageSubjectSummary[];
  /** Aggregate collection counts, for the trophy hall. */
  readonly totals: VillageCollectionTotals;
  /** The study-time summary, for the fountain. */
  readonly studyTotals: VillageStudyTotals;
  /** The chosen archetype id, or `null`. Gates "Enter Dungeon". */
  readonly selectedClass: string | null;
  /** Enters the panel's subject's dungeon. */
  readonly onEnterDungeon: (subjectId: string) => void;
  /** Opens the create-subject dialog. */
  readonly onCreateSubject: () => void;
  /** Starts the tutorial. */
  readonly onStartTutorial: () => void;
  /** Opens the sprite editor. */
  readonly onOpenSpriteEditor: () => void;
  /** Opens the fish collection. */
  readonly onOpenFishCollection: () => void;
  /** Casts a line at the panel's pond. */
  readonly onCastLine: (structureId: string) => void;
  /** Whether the one-shot fishing nudge should be shown. From `useVillageFishingHint`. */
  readonly showFishingHint: boolean;
}

/**
 * The dungeon's biome, read once when a dungeon panel opens.
 *
 * Held here rather than in the screen because it is a property of *this* panel: it
 * is read when a dungeon is inspected and it is discarded when the panel closes,
 * and a screen-level version of the same state is a state that outlives the thing
 * it describes. Returns the value *and* its setter, because the `select` that
 * rewrites the biome is in the body below and a controlled `select` with no setter
 * is a read-only control wearing a control's clothes.
 */
function useDungeonBiome(
  infoPanel: StudyFlowVillageInfoPanel,
): [string | null, (next: string) => void] {
  const subjectId = infoPanel.type === 'dungeon' ? infoPanel.subject?.id : undefined;
  const [biome, setBiome] = useState<string | null>(null);
  useEffect(() => {
    if (subjectId === undefined) {
      setBiome(null);
      return;
    }
    let cancelled = false;
    void loadSubjectSnapshot(subjectId).then((snapshot) => {
      if (cancelled) return;
      setBiome(snapshot?.dungeon.biome ?? FLOOR_BIOME_IDS[0]);
    });
    return () => {
      cancelled = true;
    };
  }, [subjectId]);
  return [biome, setBiome];
}

export function StructurePanel(props: StructurePanelProps): ReactNode {
  const {
    infoPanel,
    onClose,
    mode,
    colorTheme,
    subjects,
    totals,
    studyTotals,
    selectedClass,
    onEnterDungeon,
    onCreateSubject,
    onStartTutorial,
    onOpenSpriteEditor,
    onOpenFishCollection,
    onCastLine,
    showFishingHint,
  } = props;
  const [biome, setBiome] = useDungeonBiome(infoPanel);
  const subject = infoPanel.subject;

  switch (infoPanel.type) {
    case 'dungeon':
      return subject === undefined ? null : (
        <VillagePanel
          mode={mode}
          title={subject.subjectName}
          subtitle={`${subject.clearedRoomCount}/${subject.roomCount} rooms cleared`}
          icon="🌀"
          onClose={onClose}
          colorTheme={colorTheme}
        >
          {biome !== null ? (
            <div style={{ padding: '0 4px' }}>
              <label style={{ fontSize: 12, color: 'var(--text-muted)' }} htmlFor="village-dungeon-biome">
                Biome
              </label>
              <select
                id="village-dungeon-biome"
                value={biome}
                onChange={(event) => {
                  const next = event.target.value;
                  setBiome(next);
                  void loadSubjectSnapshot(subject.id).then((snapshot) => {
                    if (snapshot === null) return;
                    snapshot.dungeon.biome = next;
                    return saveSubjectSnapshot(snapshot.dungeon.dungeonId, snapshot);
                  });
                }}
                style={{ width: '100%', padding: '6px 10px', borderRadius: 6, fontSize: 12 }}
              >
                {FLOOR_BIOME_IDS.map((option) => (
                  <option key={option} value={option}>
                    {biomeLabel(option)}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="village-info-actions">
            <button
              type="button"
              className="village-enter-btn"
              disabled={!selectedClass}
              onClick={() => onEnterDungeon(subject.id)}
            >
              Enter Dungeon
            </button>
            {selectedClass === null ? (
              <p className="village-info-hint">Select an archetype first, in the village panel.</p>
            ) : null}
          </div>
        </VillagePanel>
      );

    case 'keeper':
      return (
        <VillagePanel
          mode={mode}
          title="Keeper's Tower"
          subtitle="Home of the guide NPC"
          icon="🏛"
          onClose={onClose}
          colorTheme={colorTheme}
        >
          <p className="village-info-desc">
            The Keeper of Knowledge resides here. Approach them to receive guidance on
            creating and clearing your first dungeon.
          </p>
          <div className="village-info-actions">
            <button
              type="button"
              className="village-action-btn"
              onClick={onCreateSubject}
              style={VILLAGE_TOUCH_TARGET_STYLE}
            >
              Create New Subject
            </button>
          </div>
        </VillagePanel>
      );

    case 'guild':
      return (
        <VillagePanel
          mode={mode}
          title="Guild Hall"
          subtitle="Create and manage subjects"
          icon="⚒"
          onClose={onClose}
          colorTheme={colorTheme}
        >
          <p className="village-info-desc">
            Here you can create new subjects to study. Each subject becomes a new dungeon
            to explore and conquer.
          </p>
          <div className="village-info-actions" style={{ flexDirection: 'column', gap: 8 }}>
            {subjects.length > 0 ? (
              <div className="village-subject-list">
                <strong>Your dungeons:</strong>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {subjects.map((entry) => (
                    <li key={entry.id} className="village-subject-item">
                      <span>{entry.subjectName}</span>
                      <span className="village-info-meta">
                        {entry.clearedRoomCount}/{entry.roomCount} cleared
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="village-info-meta">No dungeons yet. Create your first!</p>
            )}
            <button
              type="button"
              className="village-action-btn"
              onClick={onCreateSubject}
              style={VILLAGE_TOUCH_TARGET_STYLE}
            >
              + Create New Subject
            </button>
          </div>
        </VillagePanel>
      );

    case 'training':
      return (
        <VillagePanel
          mode={mode}
          title="Training Grounds"
          subtitle="Learn the basics"
          icon="🎓"
          onClose={onClose}
          colorTheme={colorTheme}
        >
          <p className="village-info-desc">
            New to Knowledge Dungeon? The training grounds offer a guided 3-room tutorial
            covering notes, attachments, navigation, and more.
          </p>
          <div className="village-info-actions">
            <button
              type="button"
              className="village-action-btn village-action-btn--tutorial"
              onClick={onStartTutorial}
            >
              Start Tutorial
            </button>
          </div>
        </VillagePanel>
      );

    case 'trophy':
      return (
        <VillagePanel
          mode={mode}
          title="Trophy Hall"
          subtitle="Your collection across all dungeons"
          icon="🏆"
          onClose={onClose}
          colorTheme={colorTheme}
        >
          <div className="village-subject-list" style={{ gap: 6 }}>
            <div className="village-subject-item">
              <span>🏅 Badges</span>
              <strong>{totals.badges}</strong>
            </div>
            <div className="village-subject-item">
              <span>🎒 Artifacts</span>
              <strong>{totals.artifacts}</strong>
            </div>
            <div className="village-subject-item">
              <span>📚 Journal entries</span>
              <strong>{totals.notes}</strong>
            </div>
            <div className="village-subject-item">
              <span>🌀 Dungeons</span>
              <strong>{totals.dungeons}</strong>
            </div>
          </div>
        </VillagePanel>
      );

    case 'library':
      return <LibraryPanel mode={mode} onClose={onClose} colorTheme={colorTheme} />;

    case 'workshop':
      return (
        <VillagePanel
          mode={mode}
          title="Artisan Workshop"
          subtitle="Customize game sprites"
          icon="🎨"
          onClose={onClose}
          colorTheme={colorTheme}
        >
          <p className="village-info-desc">
            Personalize the look and feel of your dungeon adventure. Edit character sprites,
            icons, decorations, and more.
          </p>
          <div className="village-info-actions">
            <button type="button" className="village-enter-btn" onClick={onOpenSpriteEditor}>
              Open Editor
            </button>
          </div>
        </VillagePanel>
      );

    case 'fountain':
      return (
        <VillagePanel
          mode={mode}
          title="Central Fountain"
          subtitle="Your study statistics"
          icon="⛲"
          onClose={onClose}
          colorTheme={colorTheme}
        >
          <div className="village-subject-list" style={{ gap: 6 }}>
            <div className="village-subject-item">
              <span>📊 Total sessions</span>
              <strong>{studyTotals.totalSessions}</strong>
            </div>
            <div className="village-subject-item">
              <span>⏱ Study time</span>
              <strong>
                {studyTotals.totalMinutesStudied < 60
                  ? `${studyTotals.totalMinutesStudied}m`
                  : `${Math.floor(studyTotals.totalMinutesStudied / 60)}h ${
                      studyTotals.totalMinutesStudied % 60
                    }m`}
              </strong>
            </div>
            <div className="village-subject-item">
              <span>📝 Notes submitted</span>
              <strong>{studyTotals.totalNotesSubmitted}</strong>
            </div>
            <div className="village-subject-item">
              <span>🔄 Reviews completed</span>
              <strong>{studyTotals.totalReviewsCompleted}</strong>
            </div>
            <div className="village-subject-item">
              <span>⭐ Rank</span>
              <strong>{studyTotals.rank}</strong>
            </div>
            <div className="village-subject-item">
              <span>✨ Total XP</span>
              <strong>{studyTotals.xpTotal}</strong>
            </div>
            {studyTotals.recentStreak > 1 ? (
              <div className="village-subject-item">
                <span>🔥 Daily streak</span>
                <strong>{studyTotals.recentStreak} days</strong>
              </div>
            ) : null}
          </div>
          <p className="village-info-desc">
            Press <kbd>E</kbd> to view detailed statistics.
          </p>
        </VillagePanel>
      );

    case 'fishing-pond':
      return (
        <VillagePanel
          mode={mode}
          title="Fishing Pond"
          subtitle="Cast a line and reel in some knowledge"
          icon="🎣"
          onClose={onClose}
          colorTheme={colorTheme}
        >
          <p className="village-info-desc">
            Take a break from studying and try your luck at the fishing pond. Catch fish,
            test your recall, and build your collection.
          </p>
          {showFishingHint ? (
            <div className="fishing-tutorial-hint">
              💡 Cast a line, catch fish, and test your recall! Press E to start fishing.
            </div>
          ) : null}
          <div className="village-info-actions">
            <button
              type="button"
              className="village-enter-btn"
              onClick={() => onCastLine(infoPanel.structureId)}
            >
              Cast Line
            </button>
          </div>
        </VillagePanel>
      );

    case 'fish-stand':
      return (
        <VillagePanel
          mode={mode}
          title="Fish Stand"
          subtitle="View your fish collection"
          icon="🐟"
          onClose={onClose}
          colorTheme={colorTheme}
        >
          <p className="village-info-desc">
            All the fish you have caught across every subject are displayed here. Visit a
            fishing pond to start your collection!
          </p>
          <div className="village-info-actions">
            <button type="button" className="village-enter-btn" onClick={onOpenFishCollection}>
              View Collection
            </button>
          </div>
        </VillagePanel>
      );

    case 'signpost':
    case 'waysign':
      return (
        <SignpostPanel
          structureId={infoPanel.structureId}
          colorTheme={colorTheme}
          mode={mode}
          onClose={onClose}
        />
      );

    // The quest board is its own module: it needs the contract's quest overview and
    // the screen's shared action handler, which this dispatcher's props do not carry.
    case 'quest-board':
      return null;

    default:
      return null;
  }
}

const FISHING_HINT_KEY = 'knowledge-dungeon:ui:fishing-hint:v1';

/**
 * The one-shot "you have not cast a line yet" nudge, and the localStorage write
 * that retires it.
 *
 * The pre-Phase-12 screen held this as two pieces of screen state: an
 * initialiser that read the key, and an effect that watched the info panel's type
 * and set the key when a `fishing-pond` panel *closed*. The effect has to stay
 * with the panel's lifecycle, which the panel itself does not own - the screen
 * opens and closes it - so this is a hook the screen calls with the current panel
 * type, and the panel body receives the answer as a prop. Moving the flag alone
 * would have made the nudge repeat forever, which is the bug the key prevents.
 */
export function useVillageFishingHint(infoPanelType: string | null): boolean {
  const [visible, setVisible] = useState(() => {
    try {
      return window.localStorage.getItem(FISHING_HINT_KEY) !== '1';
    } catch {
      return false;
    }
  });
  const previousType = useRef<string | null>(null);
  useEffect(() => {
    if (infoPanelType === null && previousType.current === 'fishing-pond' && visible) {
      try {
        window.localStorage.setItem(FISHING_HINT_KEY, '1');
      } catch {
        /* ignore */
      }
      setVisible(false);
    }
    previousType.current = infoPanelType;
  }, [infoPanelType, visible]);
  return visible;
}

/**
 * The library: a controls reference, or the full guide.
 *
 * Split out because it is the only panel body with internal state of its own, and
 * folding a `useState` into the dispatcher would have meant thirteen branches
 * sharing one hook's state.
 */
function LibraryPanel({
  mode,
  onClose,
  colorTheme,
}: {
  mode: VillageSurfaceMode;
  onClose: () => void;
  colorTheme: string;
}): ReactNode {
  const [showFullGuide, setShowFullGuide] = useState(false);
  return (
    <VillagePanel
      mode={mode}
      title="Library of Knowledge"
      subtitle="Game guide & help"
      icon="📖"
      onClose={onClose}
      colorTheme={colorTheme}
    >
      <div className="village-info-actions" style={{ marginBottom: 8 }}>
        <button
          type="button"
          className="village-action-btn"
          onClick={() => setShowFullGuide((open) => !open)}
          aria-expanded={showFullGuide}
          style={VILLAGE_TOUCH_TARGET_STYLE}
        >
          {showFullGuide ? 'Quick Reference' : 'Full Guide'}
        </button>
      </div>
      {showFullGuide ? (
        <div
          className="markdown-body"
          style={{ maxHeight: '60vh', overflowY: 'auto', padding: '0 4px', fontSize: 13 }}
        >
          <Markdown source={GAME_GUIDE_MARKDOWN} />
        </div>
      ) : (
        <div className="village-subject-list" style={{ gap: 6 }}>
          <div
            className="village-subject-item"
            style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}
          >
            <strong>🎮 Controls</strong>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              <kbd>W</kbd>
              <kbd>A</kbd>
              <kbd>S</kbd>
              <kbd>D</kbd> / Arrow keys - Move
              <br />
              <kbd>E</kbd> - Interact with buildings &amp; NPCs
              <br />
              <kbd>M</kbd> - Open dungeon map
              <br />
              <kbd>I</kbd> - Toggle room info panel
              <br />
              <kbd>H</kbd> - Return to village
              <br />
              <kbd>?</kbd> - Help overlay
            </span>
          </div>
          <div
            className="village-subject-item"
            style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}
          >
            <strong>📋 Gameplay Loop</strong>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              <strong>Creator</strong> - Build your topic map by adding rooms
              <br />
              <strong>Scribe</strong> - Clear rooms by writing structured notes
              <br />
              <strong>Archaeologist</strong> - Review cleared rooms for badges &amp; XP
            </span>
          </div>
          <div
            className="village-subject-item"
            style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}
          >
            <strong>🏅 Archetypes</strong>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              Each class has a unique perk. Scholar gets quality bonus, Cartographer gets
              cross-link suggestions, Archivist gets higher self-check cap.
            </span>
          </div>
        </div>
      )}
    </VillagePanel>
  );
}

/**
 * The word that says which structure the open panel belongs to.
 *
 * A one-line noun phrase per structure, in words, for the polite live region. The
 * panel's own heading already names the surface; this says it *changed*, which is
 * the information a live region is for.
 *
 * ## Why the screen needs this at all
 *
 * A structure panel opens because the *player walked*, not because a control was
 * activated, and a side panel deliberately never takes focus (see `VillagePanel`).
 * So on a wide viewport there is nothing a screen reader would announce. This
 * sentence is the announcement, and it is here rather than in the screen because it
 * is a fact about the thirteen structures rather than about the screen.
 */
export function structureAnnouncement(infoPanel: StudyFlowVillageInfoPanel): string {
  switch (infoPanel.type) {
    case 'dungeon':
      return `Now at the dungeon portal for ${infoPanel.subject?.subjectName ?? 'a subject'}.`;
    case 'keeper':
      return 'Now at the Keeper\'s Tower. The Keeper of Knowledge gives guidance here.';
    case 'guild':
      return 'Now at the Guild Hall. Create and manage subjects here.';
    case 'training':
      return 'Now at the Training Grounds. A guided tutorial starts here.';
    case 'trophy':
      return 'Now at the Trophy Hall. Your collected badges, artifacts, and notes are here.';
    case 'signpost':
    case 'waysign':
      return 'Now at a signpost. Its directions are in the panel.';
    case 'quest-board':
      return 'Now at the quest board. Every quest and its progress is in the panel.';
    case 'library':
      return 'Now at the Library of Knowledge. Controls and the game guide are here.';
    case 'workshop':
      return 'Now at the Artisan Workshop. Sprite editing is here.';
    case 'fountain':
      return 'Now at the Central Fountain. Your study statistics are here.';
    case 'fishing-pond':
      return 'Now at a fishing pond. You can cast a line from the panel.';
    case 'fish-stand':
      return 'Now at the Fish Stand. Your collected fish are here.';
    default:
      return 'A village panel is open.';
  }
}
