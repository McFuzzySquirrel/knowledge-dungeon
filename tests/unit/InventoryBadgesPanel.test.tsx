import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SCRIBE_CENTURY_120_BADGE_ID } from '@/core/progression';
import { CANONICAL_SHARE_BADGE_IDS, canonicalBadgeLabel } from '@/core/share/shareCardContent';
import { InventoryBadgesPanel } from '@/ui/components/InventoryBadgesPanel';

describe('InventoryBadgesPanel', () => {
  const baseProps = {
    equippedItems: [] as const,
    equipBonuses: { qualityBonus: 0, xpMultiplier: 1, xpBonus: 0, streakBonus: 0 },
    onEquip: () => undefined,
    onUnequip: () => undefined,
  };

  it('renders empty inventory placeholder when no items are present', () => {
    render(
      <InventoryBadgesPanel
        view="inventory"
        inventory={[]}
        badges={[]}
        collectedNotes={[]}
        {...baseProps}
        subjectName="Linear Algebra"
        clearedRoomCount={0}
        totalRoomCount={1}
        xpTotal={0}
        rank="Novice"
        onSwitchView={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText(/No loot yet/i)).toBeInTheDocument();
  });

  /*
   * **What changed here, and why.**
   *
   * This fixture used to be `badges={['First Steps']}` with `expect(screen.getByText('First Steps'))`
   * - a legacy *display name* sitting in the badge-id slot, which the panel resolved by falling back
   * to the string itself. That assertion is the defect: it passed only because the fallback printed
   * the id. The fixture is now a canonical id, and the assertion is that the badge appears **by
   * name**. An unrecognised id is a different case with its own test below, where the property is
   * that it does *not* appear by id.
   */
  it('renders badges when present', () => {
    render(
      <InventoryBadgesPanel
        view="badges"
        inventory={[]}
        badges={['FshMasterAngler']}
        collectedNotes={[]}
        {...baseProps}
        subjectName="Linear Algebra"
        clearedRoomCount={0}
        totalRoomCount={1}
        xpTotal={50}
        rank="Apprentice"
        onSwitchView={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText('Master Angler')).toBeInTheDocument();
    expect(screen.getByText(/^Caught 25 fish at the pond\.$/)).toBeInTheDocument();
    expect(screen.getByText('Apprentice')).toBeInTheDocument();
  });

  it('renders a friendly label for the 120-word badge id', () => {
    render(
      <InventoryBadgesPanel
        view="badges"
        inventory={[]}
        badges={[SCRIBE_CENTURY_120_BADGE_ID]}
        collectedNotes={[]}
        {...baseProps}
        subjectName="Linear Algebra"
        clearedRoomCount={0}
        totalRoomCount={1}
        xpTotal={50}
        rank="Apprentice"
        onSwitchView={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText('Scribe Century (120+ Words)')).toBeInTheDocument();
  });

  it('renders description for archaeologist milestone badges', () => {
    render(
      <InventoryBadgesPanel
        view="badges"
        inventory={[]}
        badges={['ArchaeologistReviewPass7']}
        collectedNotes={[]}
        {...baseProps}
        subjectName="Linear Algebra"
        clearedRoomCount={0}
        totalRoomCount={1}
        xpTotal={50}
        rank="Apprentice"
        onSwitchView={() => undefined}
        onClose={() => undefined}
      />,
    );
    // The label, not the id. This used to assert `getByText('ArchaeologistReviewPass7')`, which
    // passed only because the panel printed the id it could not name.
    expect(screen.getByText('Seven Review Passes')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('ArchaeologistReviewPass7');
    expect(
      screen.getByText('Completed at least 7 full archaeology review passes.'),
    ).toBeInTheDocument();
  });

  it('opens detail for long unbroken badge ids', () => {
    render(
      <InventoryBadgesPanel
        view="badges"
        inventory={[]}
        badges={['ArchaeologistPhaseComplete']}
        collectedNotes={[]}
        {...baseProps}
        subjectName="Linear Algebra"
        clearedRoomCount={0}
        totalRoomCount={1}
        xpTotal={50}
        rank="Apprentice"
        onSwitchView={() => undefined}
        onClose={() => undefined}
      />,
    );

    // Anchored on the published name rather than matched with `/ArchaeologistPhaseComplete/i`,
    // which is the string this panel used to draw. The point of the test - that a name long
    // enough to need wrapping still opens its detail - is unchanged by which name is drawn.
    fireEvent.click(screen.getByRole('button', { name: /^Deep Reader\b/ }));

    expect(screen.getByText('Archaeologist milestone')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to badges' })).toBeInTheDocument();
  });

  it('opens extra detail when a badge is clicked', () => {
    render(
      <InventoryBadgesPanel
        view="badges"
        inventory={[]}
        badges={['CreatorPhaseComplete']}
        collectedNotes={[]}
        {...baseProps}
        subjectName="Linear Algebra"
        clearedRoomCount={0}
        totalRoomCount={1}
        xpTotal={50}
        rank="Apprentice"
        onSwitchView={() => undefined}
        onClose={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^First Map\b/ }));

    expect(screen.getByText('Creator milestone')).toBeInTheDocument();
    expect(
      screen.getByText('Map at least 90% of the dungeon rooms during the creator phase.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to badges' })).toBeInTheDocument();
  });

  it('renders collected notes journal entries', () => {
    render(
      <InventoryBadgesPanel
        view="journal"
        inventory={[]}
        badges={[]}
        collectedNotes={[
          {
            noteId: 'dungeon:room-1',
            dungeonId: 'dungeon',
            roomId: 'room-1',
            topic: 'Vector Spaces',
            floorLabel: 'Linear Algebra',
            artifactPreview: 'A concise artifact summary.',
            noteMarkdown: '## Key ideas\nA full encounter note.',
            artifactMarkdown: '## Key ideas\nA full artifact note.',
            collectedAt: '2026-01-01T00:00:00.000Z',
          },
        ]}
        {...baseProps}
        subjectName="Linear Algebra"
        clearedRoomCount={0}
        totalRoomCount={1}
        xpTotal={50}
        rank="Apprentice"
        onSwitchView={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText('Vector Spaces')).toBeInTheDocument();
    expect(screen.getByText('Linear Algebra')).toBeInTheDocument();
  });

  it('opens full collected note content from the diary list', () => {
    render(
      <InventoryBadgesPanel
        view="journal"
        inventory={[]}
        badges={[]}
        collectedNotes={[
          {
            noteId: 'dungeon:room-1',
            dungeonId: 'dungeon',
            roomId: 'room-1',
            topic: 'Vector Spaces',
            floorLabel: 'Linear Algebra',
            artifactPreview: 'A concise artifact summary.',
            noteMarkdown: '## Key ideas\nA full encounter note for recall.',
            artifactMarkdown: '## Key ideas\nA full artifact note for recall.',
            collectedAt: '2026-01-01T00:00:00.000Z',
          },
        ]}
        {...baseProps}
        subjectName="Linear Algebra"
        clearedRoomCount={0}
        totalRoomCount={1}
        xpTotal={50}
        rank="Apprentice"
        onSwitchView={() => undefined}
        onClose={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Vector Spaces' }));
    expect(screen.getByText('A full encounter note for recall.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to journal' })).toBeInTheDocument();
  });

  it('auto-opens a collected note when autoOpenNoteId is provided', () => {
    render(
      <InventoryBadgesPanel
        view="journal"
        inventory={[]}
        badges={[]}
        collectedNotes={[
          {
            noteId: 'dungeon:room-2',
            dungeonId: 'dungeon',
            roomId: 'room-2',
            topic: 'Graph Traversal',
            floorLabel: 'Algorithms',
            artifactPreview: 'Traversal summary',
            noteMarkdown: '## Summary\nDepth-first and breadth-first traversal notes.',
            artifactMarkdown: '## Summary\nArtifact fallback text.',
            collectedAt: '2026-01-02T00:00:00.000Z',
          },
        ]}
        autoOpenNoteId="dungeon:room-2"
        {...baseProps}
        subjectName="Algorithms"
        clearedRoomCount={0}
        totalRoomCount={1}
        xpTotal={10}
        rank="Novice"
        onSwitchView={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByText('Depth-first and breadth-first traversal notes.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to journal' })).toBeInTheDocument();
  });

  it('renders local images in collected note view when a resolver is provided', () => {
    render(
      <InventoryBadgesPanel
        view="journal"
        inventory={[]}
        badges={[]}
        collectedNotes={[
          {
            noteId: 'dungeon:room-3',
            dungeonId: 'dungeon',
            roomId: 'room-3',
            topic: 'Matrices',
            floorLabel: 'Linear Algebra',
            artifactPreview: 'Matrix summary',
            noteMarkdown: '![matrix diagram](local:asset-42)',
            artifactMarkdown: 'Artifact fallback',
            collectedAt: '2026-01-03T00:00:00.000Z',
          },
        ]}
        autoOpenNoteId="dungeon:room-3"
        resolveCollectedNoteImage={(roomId, attachmentId) =>
          roomId === 'room-3' && attachmentId === 'asset-42'
            ? 'https://example.com/matrix.png'
            : null
        }
        {...baseProps}
        subjectName="Linear Algebra"
        clearedRoomCount={0}
        totalRoomCount={1}
        xpTotal={10}
        rank="Novice"
        onSwitchView={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByRole('img', { name: 'matrix diagram' })).toHaveAttribute(
      'src',
      'https://example.com/matrix.png',
    );
  });
});

/**
 * The Badges tab names every badge it holds.
 *
 * ## The defect these tests exist for
 *
 * The panel resolved names with `BADGE_LABELS[badgeId] ?? badgeId` over a table holding exactly one
 * entry - `ScribeCentury120` - so ten of the eleven ids this build can award reached the screen as
 * their own internal identifier: `CreatorPhaseComplete`, `ArchaeologistReviewPass15`,
 * `FshMasterAngler`. It was the **name** of the badge, not a debug field, on the surface a learner
 * opens to find out what they earned, and three of the tests above were written to pass against it.
 * Names now come from `canonicalBadgeLabel` in `src/core/share/shareCardContent.ts`, which returns
 * `undefined` for anything it does not recognise and never the id.
 *
 * ## Why the table below is written out rather than read from that module
 *
 * A test that expects `canonicalBadgeLabel(id)` to equal what the panel rendered from
 * `canonicalBadgeLabel(id)` is tautological - it would pass against any label the module happened
 * to return, including a future regression where a label *is* an id. The expected names are
 * therefore literal here, so this file pins the published copy, and the module is compared against
 * the table separately. The two can then only ever fail together, and both say what changed.
 *
 * ## What is asserted, on each badge
 *
 * The name appears in the list **and** in the detail card, and the id appears nowhere in the
 * document in either state. The second half is the half that catches a leak into a description, an
 * unlock line, or the dialog's `aria-label`, and it is why these tests open the detail view rather
 * than checking the list alone.
 */
const CANONICAL_BADGE_NAMES: ReadonlyArray<readonly [badgeId: string, label: string]> = [
  ['CreatorPhaseComplete', 'First Map'],
  ['ScribePhaseComplete', 'Keeper of the Notes'],
  ['ArchaeologistPhaseComplete', 'Deep Reader'],
  ['ArchaeologistReviewPass3', 'Three Review Passes'],
  ['ArchaeologistReviewPass7', 'Seven Review Passes'],
  ['ArchaeologistReviewPass15', 'Fifteen Review Passes'],
  // The literal, not the exported constant: `it.each` prints its first column in the test name,
  // and a test called "publishes SCRIBE_CENTURY_120_BADGE_ID as ..." would report this defect by
  // identifier rather than by badge. The enumeration test below proves the literal is that value.
  ['ScribeCentury120', 'Scribe Century (120+ Words)'],
  ['FshFirstCatch', 'First Catch'],
  ['FshAngler', 'Angler'],
  ['FshMasterAngler', 'Master Angler'],
  ['FshFullCreel', 'Full Creel'],
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The Badges tab, and nothing else: one badge in, one badge out. */
function renderBadges(badges: readonly string[]) {
  return render(
    <InventoryBadgesPanel
      view="badges"
      inventory={[]}
      badges={badges}
      collectedNotes={[]}
      equippedItems={[]}
      equipBonuses={{ qualityBonus: 0, xpMultiplier: 1, xpBonus: 0, streakBonus: 0 }}
      onEquip={() => undefined}
      onUnequip={() => undefined}
      subjectName="Linear Algebra"
      clearedRoomCount={0}
      totalRoomCount={1}
      xpTotal={50}
      rank="Apprentice"
      onSwitchView={() => undefined}
      onClose={() => undefined}
    />,
  );
}

/** Everything the badges tab is currently drawing. */
function renderedText(): string {
  return document.body.textContent ?? '';
}

/** The names in the Badges tab, in DOM order. */
function renderedBadgeNames(): string[] {
  return [...document.querySelectorAll('.badge-label')].map((node) => node.textContent ?? '');
}

describe('every canonical badge is named, and no badge is named by its id', () => {
  it('covers exactly the ids the content module publishes a name for', () => {
    // Eleven: six phase badges, the note-length badge, four fishing badges. Read off the module
    // rather than typed, so an id added upstream has to be added to this table too - and the
    // per-badge tests below then fail until its name is written down here.
    expect(CANONICAL_SHARE_BADGE_IDS).toHaveLength(11);
    expect(CANONICAL_BADGE_NAMES.map(([badgeId]) => badgeId)).toEqual([
      ...CANONICAL_SHARE_BADGE_IDS,
    ]);
    // The one literal in the table above is the constant this file already imported.
    expect('ScribeCentury120').toBe(SCRIBE_CENTURY_120_BADGE_ID);
  });

  it.each(CANONICAL_BADGE_NAMES)('publishes %s as %s', (badgeId, label) => {
    // The panel's source of truth agrees with the table above. Reported separately so a content
    // rename fails as "the name moved", not as "the panel drew the wrong thing".
    expect(canonicalBadgeLabel(badgeId)).toBe(label);
  });

  it.each(CANONICAL_BADGE_NAMES)('names %s in the list and in its detail card', (badgeId, label) => {
    renderBadges([badgeId]);

    // The list: the published name, as the badge's own name.
    expect(renderedBadgeNames()).toEqual([label]);
    expect(screen.getByText(label)).toBeInTheDocument();

    // And not the id, in the list.
    expect(renderedText()).not.toContain(badgeId);

    // The detail card: the same name in the heading, and the dialog names itself the same way.
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${escapeRegExp(label)}`) }));
    expect(screen.getByRole('heading', { level: 3, name: label })).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', `Badge: ${label}`);

    // And not the id, anywhere in the detail view either. This is the assertion that covers the
    // definition list, where a "Badge ID" row used to draw the raw id beside the name.
    expect(renderedText()).not.toContain(badgeId);
  });

  it('names all eleven at once, in order, with no id anywhere on the tab', () => {
    renderBadges([...CANONICAL_SHARE_BADGE_IDS]);

    expect(renderedBadgeNames()).toEqual(CANONICAL_BADGE_NAMES.map(([, label]) => label));
    for (const [badgeId] of CANONICAL_BADGE_NAMES) {
      expect(renderedText(), badgeId).not.toContain(badgeId);
    }
    // Each is still its own control: a learner can open any of them.
    expect(screen.getAllByRole('button', { name: /Click for more detail\.$/ })).toHaveLength(11);
  });

  /*
   * The fishing badges are earned at the pond by catching fish.
   *
   * They used to be explained as "Milestone badge" / "Earned by reaching a progression milestone in
   * the dungeon" - the generic fallback, applied to all four - which is false, and which only became
   * visible once each of them finally had a name to sit above it. Both branches are asserted:
   * `FshMasterAngler` is a threshold, and `FshFullCreel` is the one badge whose threshold is not a
   * number of catches.
   */
  it.each([
    ['FshMasterAngler', 'Master Angler', 'Caught 25 fish at the pond.', 'Catch 25 fish at the pond.'],
    [
      'FshFullCreel',
      'Full Creel',
      'Caught one of every fish species in the pond.',
      'Catch every fish species in the pond.',
    ],
  ])('explains %s as a catch rather than as a dungeon milestone', (badgeId, label, earned, unlock) => {
    renderBadges([badgeId]);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${escapeRegExp(label)}`) }));

    expect(screen.getByText('Fishing milestone')).toBeInTheDocument();
    expect(screen.getByText(earned)).toBeInTheDocument();
    expect(screen.getByText(unlock)).toBeInTheDocument();
    expect(renderedText()).not.toContain('progression milestone');
  });
});

/**
 * An id the app cannot name is named neutrally, never printed, and never explained away.
 *
 * `canonicalBadgeLabel` answers `undefined` for an id it does not recognise. That means *omit* on a
 * published card, and the panel keeps the row for a different reason: the tab header counts every
 * badge the learner holds, so dropping an unnameable one would make the list disagree with the
 * number above it with nothing to explain the gap. The row is kept under a neutral name, and the
 * detail copy says what is actually known - that this version has no name for it - instead of
 * asserting a milestone rule the panel does not have.
 *
 * The ids below are four different ways to be unrecognised, and each one has broken something:
 * a legacy **display name** in the id slot; an id in the app's own naming scheme for a badge this
 * build does not define, which is the dangerous one because it looks canonical; a canonical id in
 * the wrong **case**, which must not resolve; and `constructor`, which an object-literal table
 * answers from `Object.prototype` - it used to reach React as a function and crash the list.
 */
describe('an unrecognised badge id is never printed', () => {
  const UNRECOGNISED = 'Unrecognised badge';

  const UNKNOWN_IDS: ReadonlyArray<readonly [shape: string, badgeId: string]> = [
    ['a legacy display name in the id slot', 'First Steps'],
    ['an id in this app\'s own naming scheme that this build does not define', 'FshSilverAngler'],
    ['a canonical id differing only in case', 'archaeologistreviewpass7'],
    ['an Object.prototype member name', 'constructor'],
  ];

  it.each(UNKNOWN_IDS)('shows %s as an unrecognised badge, not as text', (_shape, badgeId) => {
    renderBadges([badgeId]);

    // One row, still there: the badge was not dropped from the learner's own list.
    expect(renderedBadgeNames()).toEqual([UNRECOGNISED]);
    expect(renderedText()).not.toContain(badgeId);
    // Also not the id as a *name*, in any element, however it is cased on screen.
    expect(screen.queryByText(badgeId)).toBeNull();
  });

  it.each(UNKNOWN_IDS)(
    'tells the truth about %s rather than claiming a milestone rule',
    (_shape, badgeId) => {
      renderBadges([badgeId]);
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${escapeRegExp(UNRECOGNISED)}`) }));

      // What the panel does know.
      expect(screen.getByRole('heading', { level: 3, name: UNRECOGNISED })).toBeInTheDocument();
      expect(screen.getByText('Badge in your saved record')).toBeInTheDocument();
      expect(
        screen.getByText('Not shown: this version of the app does not award this badge.'),
      ).toBeInTheDocument();
      // That the record still counts it, so a learner does not read the missing name as a lost badge.
      expect(
        screen.getByText(/Your saved record lists a badge this version of the app has no name for\./),
      ).toBeInTheDocument();

      // What it does not know, and must not claim. These two sentences were the generic fallback
      // every unrecognised id used to receive.
      expect(renderedText()).not.toContain('Milestone badge earned during your dungeon journey.');
      expect(renderedText()).not.toContain('Earned by reaching a progression milestone');
      expect(renderedText()).not.toContain('Badge ID');
      expect(renderedText()).not.toContain(badgeId);
    },
  );

  it('does not resolve a canonical id that differs only in case', () => {
    renderBadges(['ArchaeologistReviewPass7', 'archaeologistreviewpass7']);

    // The real badge is named, and the case variant is not silently folded into it: exactly one
    // element carries the name, so the second row did not resolve to the first badge's.
    expect(renderedBadgeNames()).toEqual(['Seven Review Passes', UNRECOGNISED]);
    expect(screen.getAllByText('Seven Review Passes')).toHaveLength(1);
  });

  it('does not repair a canonical id that arrived padded with spaces', () => {
    // Repairing it would be a guess about which badge a corrupt record meant, and a guess that
    // names the wrong achievement is worse than naming none - the reason
    // `canonicalBadgeLabel` refuses to trim.
    renderBadges([' CreatorPhaseComplete ']);

    expect(renderedBadgeNames()).toEqual([UNRECOGNISED]);
    expect(renderedText()).not.toContain('First Map');
  });
});

/**
 * The fallback cannot come back without this failing.
 *
 * Structural, because the DOM assertions above cannot see a second label table that happens to
 * agree with the module on all eleven ids - which is exactly what a reintroduction of
 * `BADGE_LABELS` would be.
 */
describe('the panel has one source of badge names', () => {
  it('declares no badge-name table and no id fallback of its own', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('node:path') as typeof import('node:path');
    const source = readFileSync(
      join(process.cwd(), 'src', 'ui', 'components', 'InventoryBadgesPanel.tsx'),
      'utf8',
    );

    // Comments stripped first: the panel documents this defect by name in prose, and a source gate
    // that matched its own documentation would fail for the right reason in the wrong place.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

    // Labels come from the published content module and nowhere else.
    expect(code).toContain("import { canonicalBadgeLabel } from '@/core/share/shareCardContent'");
    expect(code).not.toMatch(/BADGE_LABELS\b/);
    // The defect itself, in the shape it had: a lookup that ends in the id it failed to name.
    expect(code).not.toMatch(/\?\?\s*badgeId\b/);
    expect(code).not.toMatch(/\|\|\s*badgeId\b/);
  });
});
