/**
 * Phase 20: the panel that opens the share dialog.
 *
 * ## Why this file exists
 *
 * `InventoryBadgesPanel` is the host surface, and it is the **eagerly reachable** half of this phase:
 * `GameScreen` imports it directly, so anything it imports statically lands in the entry chunk.
 * That is precisely the property `vite.config.ts` fails the default production build over, and it is
 * why the dialog is reached through `React.lazy` here rather than imported normally.
 *
 * So this file gates three things a static-import regression would break:
 *
 * 1. **The two pre-Phase-20 instant-download buttons are gone** and are replaced by a
 *    preview-and-select flow. The old buttons exported the instant they were clicked: no preview, no
 *    choice, and a collection image carrying raw badge ids.
 * 2. **`ShareCardDialog` is reached only through a dynamic import.** Asserted on the module's own
 *    source, because the *structural* claim is the one that matters and a behavioural test cannot see
 *    it: a component that lazily loads on mount and renders statically would pass every DOM assertion
 *    and still ship a card renderer to a Welcome visitor.
 * 3. **The panel passes counts, not content.** It holds note bodies and item descriptions in hand and
 *    must hand the dialog only lengths, so there is no parameter through which either could arrive.
 *
 * ## What this file cannot verify
 *
 * **No contrast and no rendered target size.** jsdom computes neither. The 44x44 assertions below are
 * the *inline* floors; whether a control is 44x44 in a browser is Phase 21's measurement.
 *
 * Privacy: every string here is synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { PHASE_BADGE_IDS } from '@/core/progression/types';
import { canonicalBadgeLabel } from '@/core/share/shareCardContent';
import type { CollectedNoteEntry, LootItem } from '@/store/progressionStore';
import { InventoryBadgesPanel } from '@/ui/components/InventoryBadgesPanel';
import {
  SHARE_CARD_FIELD_ATTRIBUTE,
  SHARE_CARD_ID_ATTRIBUTE,
  SHARE_CARD_IDS,
  SHARE_CARD_KIND_ATTRIBUTE,
} from '@/ui/share/shareCardTestIds';
import {
  installRecordingCanvas,
  installShareSpy,
  removeShareApi,
} from '../unit/shareCardRenderSupport';

/** A note whose topic and body are the strings a card must never publish. */
const NOTE: CollectedNoteEntry = {
  noteId: 'dungeon:room-1',
  dungeonId: 'dungeon',
  roomId: 'room-1',
  topic: 'ZZ-a-note-topic-that-must-not-be-shared',
  floorLabel: 'Linear Algebra',
  artifactPreview: 'ZZ-an-artifact-preview-that-must-not-be-shared',
  noteMarkdown: '## Key ideas\nZZ-a-note-body-that-must-not-be-shared.',
  artifactMarkdown: 'ZZ-an-artifact-body-that-must-not-be-shared.',
  collectedAt: '2026-01-01T00:00:00.000Z',
};

const LOOT = {
  id: 'loot-1',
  name: 'Worn Compass',
  description: 'ZZ-an-item-description-that-must-not-be-shared.',
  rarity: 'common',
  acquiredAt: '2026-01-01T00:00:00.000Z',
} as unknown as LootItem;

const BASE_PROPS = {
  equippedItems: [],
  equipBonuses: { qualityBonus: 0, xpMultiplier: 1, xpBonus: 0, streakBonus: 0 },
  onEquip: () => undefined,
  onUnequip: () => undefined,
  onSwitchView: () => undefined,
  onClose: () => undefined,
} as const;

let restoreCanvas: () => void;

beforeEach(() => {
  const installed = installRecordingCanvas();
  restoreCanvas = installed.restore;
  installShareSpy();
});

afterEach(() => {
  restoreCanvas();
  removeShareApi();
  vi.restoreAllMocks();
});

function renderPanel(overrides: Record<string, unknown> = {}) {
  return render(
    <InventoryBadgesPanel
      view="inventory"
      inventory={[LOOT]}
      badges={[...PHASE_BADGE_IDS]}
      collectedNotes={[NOTE]}
      subjectName="Linear Algebra"
      clearedRoomCount={12}
      totalRoomCount={40}
      xpTotal={1240}
      rank="Master"
      {...BASE_PROPS}
      {...overrides}
    />,
  );
}

/** The controls that open the share dialog, in DOM order. */
function openers(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[${SHARE_CARD_ID_ATTRIBUTE}="${SHARE_CARD_IDS.open}"]`)];
}

describe('the panel offers a preview, not an instant download', () => {
  it('has no control that exports on click', () => {
    renderPanel();
    // The two pre-Phase-20 labels. Their absence is the regression this file exists to catch: the
    // old buttons drew and downloaded in one step, so a learner could not see or choose first.
    expect(screen.queryByRole('button', { name: /export summary image/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /export collections image/i })).toBeNull();
    // And no control whose name suggests an immediate export.
    const labels = [...document.querySelectorAll('button')].map((node) =>
      (node.textContent ?? '').trim().toLowerCase(),
    );
    expect(labels.some((label) => label.includes('export'))).toBe(false);
  });

  it('opens a preview on the summary card, naming the card kind it opens', async () => {
    renderPanel();
    const [summary, collection] = openers();
    expect(summary.getAttribute(SHARE_CARD_KIND_ATTRIBUTE)).toBe('subject-summary');
    expect(collection.getAttribute(SHARE_CARD_KIND_ATTRIBUTE)).toBe('collection');

    fireEvent.click(summary);
    await waitFor(() => {
      expect(document.querySelector(`[${SHARE_CARD_ID_ATTRIBUTE}="${SHARE_CARD_IDS.dialog}"]`)).not.toBeNull();
    });
    const dialog = document.querySelector(`[${SHARE_CARD_ID_ATTRIBUTE}="${SHARE_CARD_IDS.dialog}"]`) as HTMLElement;
    expect(screen.getByRole('radio', { name: 'Subject summary' })).toBeChecked();
    // A preview, not a download: the dialog is what appeared.
    expect(dialog.textContent).toContain('Download PNG');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('opens the collection card from its own control', async () => {
    renderPanel();
    fireEvent.click(openers()[1]);
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Collection' })).toBeChecked());
  });

  it('shows no dialog before a control is pressed', () => {
    renderPanel();
    expect(document.querySelector(`[${SHARE_CARD_ID_ATTRIBUTE}="${SHARE_CARD_IDS.dialog}"]`)).toBeNull();
  });

  it('gives both openers a 44x44 inline floor, because jsdom computes no layout', () => {
    renderPanel();
    const controls = openers();
    expect(controls).toHaveLength(2);
    for (const control of controls) {
      expect(control.style.minWidth).toBe('44px');
      expect(control.style.minHeight).toBe('44px');
    }
  });

  it('keeps working after the dialog is closed, and the panel is not left broken', async () => {
    const onClose = vi.fn();
    renderPanel({ onClose });
    fireEvent.click(openers()[0]);
    await waitFor(() => expect(document.querySelector(`[${SHARE_CARD_ID_ATTRIBUTE}="${SHARE_CARD_IDS.dialog}"]`)).not.toBeNull());
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(document.querySelector(`[${SHARE_CARD_ID_ATTRIBUTE}="${SHARE_CARD_IDS.dialog}"]`)).toBeNull());
    // The panel's own close is untouched by the share dialog.
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('the panel hands the dialog counts, never content', () => {
  it('publishes no note topic, body, preview, room id, or item description', async () => {
    renderPanel();
    fireEvent.click(openers()[0]);
    await waitFor(() => {
      expect(document.querySelector(`[${SHARE_CARD_ID_ATTRIBUTE}="${SHARE_CARD_IDS.dialog}"]`)).not.toBeNull();
    });
    /*
     * Scoped to the **dialog**, not to the document.
     *
     * The panel behind it legitimately renders the note topic, the item description, and a collected
     * timestamp - those are the panel's own surfaces, and a learner looking at their journal expects to
     * see them. The first version of this assertion read `document.body`, and it failed on the item
     * description for exactly that reason: the claim is about the card, and a whole-document assertion
     * would have required deleting the inventory list to make it pass.
     */
    const dialog = document.querySelector(`[${SHARE_CARD_ID_ATTRIBUTE}="${SHARE_CARD_IDS.dialog}"]`) as HTMLElement;
    const rendered = dialog.textContent ?? '';
    for (const forbidden of [
      'ZZ-a-note-topic-that-must-not-be-shared',
      'ZZ-a-note-body-that-must-not-be-shared',
      'ZZ-an-artifact-preview-that-must-not-be-shared',
      'ZZ-an-artifact-body-that-must-not-be-shared',
      'ZZ-an-item-description-that-must-not-be-shared',
      // `dungeon:room-1` is the note's own composite id, and `room-1` the room id. The bare word
      // `dungeon` is deliberately **not** in this list: it appears in the app-owned label
      // `roomTotal: 'Rooms in the dungeon'`, and asserting on it would be a gate that could only be
      // satisfied by renaming a published field label.
      'dungeon:room-1',
      'room-1',
      '2026-01-01',
    ]) {
      expect(rendered, forbidden).not.toContain(forbidden);
    }
    // And the control: the panel's own inventory still shows the description, so this is a claim about
    // the card and not about the panel being emptied.
    expect(document.body.textContent).toContain('ZZ-an-item-description-that-must-not-be-shared');
  });

  it('shows the counts it does publish, so the reduction is not a loss', async () => {
    renderPanel();
    fireEvent.click(openers()[0]);
    await waitFor(() => {
      const preview = document.querySelector(`[${SHARE_CARD_ID_ATTRIBUTE}="${SHARE_CARD_IDS.previewText}"]`);
      expect(preview?.textContent).toContain('Linear Algebra');
    });
    const preview = document.querySelector(`[${SHARE_CARD_ID_ATTRIBUTE}="${SHARE_CARD_IDS.previewText}"]`) as HTMLElement;
    /*
     * The counts, read as `label` + `value` from one term/definition pair rather than as a
     * concatenated substring: `textContent` on a `<dl>` joins the term and the definition with no
     * separator, so `'Badges6'` happens to work today and would break the moment a label gained
     * trailing whitespace. Reading the pair is the assertion that means what it says.
     */
    const rowValue = (field: string): string | null => {
      const row = preview.querySelector(`[${SHARE_CARD_FIELD_ATTRIBUTE}="${field}"]`);
      return row?.querySelector('dd')?.textContent ?? null;
    };
    expect(rowValue('badgeCount')).toBe(String(PHASE_BADGE_IDS.length));
    expect(rowValue('inventoryCount')).toBe('1');
    expect(rowValue('xpTotal')).toBe('1240');
    expect(rowValue('roomsCleared')).toBe('12');
    expect(rowValue('roomTotal')).toBe('40');
    // The note count is available but unchecked, so it is not on the card.
    expect(rowValue('collectedNoteCount')).toBeNull();
    expect(preview.textContent).not.toContain('Collected notes');
  });

  it('builds its facts object from lengths, so no array crosses the boundary', () => {
    // Structural: the panel passes `.length`, not the array. Asserted on the source because the DOM
    // cannot distinguish "passed the array and reduced it inside" from "passed the length".
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('node:path') as typeof import('node:path');
    const source = readFileSync(
      join(process.cwd(), 'src', 'ui', 'components', 'InventoryBadgesPanel.tsx'),
      'utf8',
    );
    expect(source).toContain('inventoryCount: inventory.length');
    expect(source).toContain('collectedNoteCount: collectedNotes.length');
    // And the share facts object has no member that could hold an array of content.
    expect(source).not.toMatch(/inventory:\s*inventory\b/);
    expect(source).not.toMatch(/collectedNotes:\s*collectedNotes\b/);
  });
});

describe('the dialog is reached only through a dynamic import', () => {
  it('reaches ShareCardDialog with import(), not with a plain import', () => {
    /*
     * The structural claim, and the one a DOM test cannot make. The whole application core is emitted
     * into a single entry chunk today, so "statically reachable" and "in the entry chunk" are the same
     * statement - a plain import here would spend Welcome bytes on a card renderer.
     *
     * Asserted on the panel's own source rather than on the emitted bundle, because the emitted-bundle
     * version of this claim is `vite.config.ts`'s check 2 and that gate already exists; this is the
     * cheap local check that names the *cause* when the build gate fires.
     */
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('node:path') as typeof import('node:path');
    const source = readFileSync(
      join(process.cwd(), 'src', 'ui', 'components', 'InventoryBadgesPanel.tsx'),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    expect(code).toMatch(/import\(\s*['"]@\/ui\/share\/ShareCardDialog['"]\s*\)/);
    // No static import of any of the three declared lane modules.
    expect(code).not.toMatch(/^import .*@\/ui\/share\/ShareCardDialog/m);
    expect(code).not.toMatch(/^import .*@\/ui\/share\/renderShareCard/m);
    expect(code).not.toMatch(/^import .*@\/core\/share\/shareCardPolicy/m);
    // `lazy` and `Suspense` are both used, and the fallback renders nothing: an element that exists
    // only to be replaced is still an element.
    expect(code).toContain('Suspense');
    expect(code).toContain('lazy(');
    expect(code).toContain('fallback={null}');
  });

  it('imports no lane module through a type-only import either', () => {
    /*
     * `import type` carries no runtime edge, so this is *not* a bundle concern - it is a coupling one,
     * and this repository applies the same rule to every renderer: a `type` import still couples the
     * module to a path, and a lane path renamed without this file would produce a type error in a
     * place that has nothing to do with types.
     *
     * The panel legitimately does need the **kind** union, and it takes it from `types.ts`, which is
     * deliberately not a lane module (`infraShareBuildLane.test.ts` documents why: `types.ts` and
     * `shareCardModel.ts` ride along free with any chunk carrying the lane, so naming either would add
     * no sensitivity).
     */
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('node:path') as typeof import('node:path');
    const source = readFileSync(
      join(process.cwd(), 'src', 'ui', 'components', 'InventoryBadgesPanel.tsx'),
      'utf8',
    );
    expect(source).toContain("import type { ShareCardKind } from '@/core/share/types'");
    expect(source).toContain("import type { ShareCardFacts } from '@/ui/share/shareCardFacts'");
    // `shareCardFacts` and `shareCardTestIds` are not lane modules either - only the policy, the
    // renderer, and the dialog are - so importing them statically costs nothing in the entry chunk.
    expect(source).not.toContain("from '@/ui/share/ShareCardDialog'");
  });

  it('does not import the card model, the policy, or the renderer directly', () => {
    /*
     * The entry-chunk claim, and the three lane modules are the whole of it.
     *
     * `@/core/share/shareCardContent` was on this list and is not any more. It was there because the
     * panel used to carry its own badge-name table, which is the defect this phase exists to fix:
     * `BADGE_LABELS[badgeId] ?? badgeId`, one entry, ten raw ids on screen as badge *names*. A panel
     * that names badges by a second, local lookup is a panel that can disagree with the published
     * names on a shared image, so the panel now reads its names from the content module and there
     * is no local table left to forbid.
     *
     * The next test is the narrower property that replaces that entry: the content module is a
     * table with one runtime edge, into `@/core/progression`, which the entry already carries.
     */
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('node:path') as typeof import('node:path');
    const source = readFileSync(
      join(process.cwd(), 'src', 'ui', 'components', 'InventoryBadgesPanel.tsx'),
      'utf8',
    );
    for (const forbidden of [
      '@/core/share/shareCardModel',
      '@/core/share/shareCardPolicy',
      '@/ui/share/renderShareCard',
      '@/ui/share/shareCardDelivery',
      '@/ui/utils/progressionShareExport',
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('imports the published badge names, which drag in nothing from the lane', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('node:path') as typeof import('node:path');
    const fromRoot = (...parts: string[]): string =>
      join(process.cwd(), 'src', ...parts);
    const panel = readFileSync(fromRoot('ui', 'components', 'InventoryBadgesPanel.tsx'), 'utf8');
    expect(panel).toContain("from '@/core/share/shareCardContent'");

    /*
     * A static import puts a module in the Welcome payload, which is why the three lane modules are
     * forbidden above. So what keeps this one safe is its own closure: comments and type-only
     * imports blanked first - `./types` is erased by the build, so counting it would be counting a
     * file no browser downloads - the only runtime specifier is `@/core/progression/types`, which the
     * panel's other imports had already put in the entry chunk before Phase 20 named a badge.
     *
     * This is the tripwire for that claim. Add a runtime import to the content module and this goes
     * red here, which is the moment to ask whether the panel may still reach it eagerly.
     */
    const content = readFileSync(fromRoot('core', 'share', 'shareCardContent.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/import\s+type\s+[^;]*;/g, ' ');
    expect([...content.matchAll(/from '([^']+)'/g)].map((match) => match[1])).toEqual([
      '@/core/progression/types',
    ]);
  });
});

describe('the pre-Phase-20 test gate keeps passing on the panel', () => {
  it('still renders the empty-inventory placeholder', () => {
    renderPanel({ inventory: [] });
    expect(screen.getByText(/No loot yet/i)).toBeInTheDocument();
  });

  it('still renders the badges view, listing every badge the panel was given', () => {
    renderPanel({ view: 'badges' });
    /*
     * The panel lists every badge it holds, in the Badges tab - that is the panel's own surface and
     * it is where a learner looks up what they earned. The share card is the thing that must not
     * carry an id, and the two are asserted separately on purpose: a gate that only checked the card
     * could hide a regression that emptied the badges tab.
     *
     * **What changed is how a badge is named, and this gate asserted the defect.** It read
     * `getByRole('button', { name: new RegExp(badgeId) })` for each of the six, which passed only
     * because the panel drew the id it had no published name for - `CreatorPhaseComplete` and the
     * rest, as the badge's name. The property now asserted is the one that was always intended:
     * one control per badge, each named by its published label, and **no id anywhere on the tab**.
     * The published copy itself is pinned in `tests/unit/InventoryBadgesPanel.test.tsx`; here the
     * labels are read from the content module, because what this file is about is that the panel
     * and the card agree on them rather than that they have not changed.
     */
    expect([...document.querySelectorAll('.badge-label')].map((node) => node.textContent)).toEqual(
      PHASE_BADGE_IDS.map((badgeId) => canonicalBadgeLabel(badgeId)),
    );
    const rendered = document.body.textContent ?? '';
    for (const badgeId of PHASE_BADGE_IDS) {
      expect(rendered, badgeId).not.toContain(badgeId);
    }
    // Each is still its own control, so the first assertion cannot be satisfied by hiding rows.
    expect(screen.getAllByRole('button', { name: /Click for more detail\.$/ })).toHaveLength(
      PHASE_BADGE_IDS.length,
    );
  });

  it('still opens the collected-note detail', () => {
    renderPanel({ view: 'journal' });
    fireEvent.click(screen.getByRole('button', { name: 'ZZ-a-note-topic-that-must-not-be-shared' }));
    expect(screen.getByText(/ZZ-a-note-body/)).toBeInTheDocument();
    // The journal view is the panel's own surface and legitimately shows note content; the card does
    // not. Both facts are asserted, because a gate that only checked the card would let a regression
    // in the journal go unnoticed.
    expect(screen.getByRole('button', { name: 'Back to journal' })).toBeInTheDocument();
  });
});