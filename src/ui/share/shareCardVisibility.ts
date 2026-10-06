/**
 * What a share card is allowed to **show**, in one place, shared by the canvas and the DOM.
 *
 * ## Why this module exists
 *
 * The first version of Phase 20 had the privacy filter in the canvas renderer
 * (`renderShareCard.ts`) and again - separately, and slightly differently - in the dialog's text
 * list. A test caught the consequence: with a subject name of `room-7f3a`, the **image** left the name
 * off while the **text list beside it** published it. The accessible surface leaked exactly what the
 * picture protected, and a screen-reader user got strictly more than a sighted one.
 *
 * That cannot be fixed by being careful twice. It is fixed by having one function, and by both
 * surfaces calling it - which is what this module is.
 *
 * ## What is filtered, and what deliberately is not
 *
 * **Filtered: the subject name.** It is the one free-text field on a card, and `shareCardModel.ts`
 * documents that it carries whatever the learner typed and that policing it is the caller's job:
 *
 * > a caller that puts an id in it gets their own text rendered - which is exactly why the *caller*
 * > must not, and why this documents the boundary rather than pretending to police it.
 *
 * This module is the caller that polices it. A name the value-level denylist refuses is not drawn,
 * not listed, and not written into a suggested file name - because the file name is the one place a
 * name survives into an operating system's UI and onto a disk.
 *
 * **Not filtered: row labels and the model's own values.** Those are app-owned published vocabulary,
 * and `shareCardPolicy.ts` is explicit that such content must survive:
 *
 * > What is deliberately **not** here: the app's own public-ish vocabulary. `Novice`, `Scholar`,
 * > `Master`, `common`, `rare`, `epic`, and every canonical badge label are published content.
 *
 * Running a value-level denylist over that vocabulary would not make a card safer - it would make it
 * **wrong**, and quietly. This is not hypothetical: the current
 * `SHARE_CARD_FIELD_LABELS` include `roomsCleared: 'Rooms cleared'`, and the denylist denies any
 * value containing the word `room` (that is how it catches `room-7f3a`). An earlier version of this
 * module filtered row labels too, and it silently deleted both room rows from every subject-summary
 * card. A test asserting the row count caught it.
 *
 * So the filter is applied to the one string that came from outside the application, and to nothing
 * else. That is a narrower claim than "the card is filtered", and it is the one that is actually
 * true.
 */
import { mayFieldAppearOnCard, mayValueAppearOnCard } from '@/core/share/shareCardPolicy';
import type { ShareCardModel, ShareCardRow } from '@/core/share/types';

/**
 * A row together with the value this surface should show for it.
 *
 * The value is computed once here rather than in each surface, because the canvas needs a formatted
 * string and the DOM needs the same formatted string - and two formatters are two chances for the
 * accessible surface to say something the image does not.
 */
export interface VisibleShareCardRow {
  readonly row: ShareCardRow;
  readonly value: string;
}

/**
 * The **value** a row shows. Total over the row union.
 *
 * Returns `null` when there is nothing to show, which is different from a value of `'—'`: the dash
 * means "this field exists and it is empty", and `null` means the row should not be rendered at all.
 *
 * Counts use `String(n)`, never `toLocaleString`. A locale group separator would put `1,240` on one
 * device and `1240` on another for the same learner state, which is the Phase 19 defect class on a
 * card.
 */
export function shareCardRowValue(row: ShareCardRow): string | null {
  switch (row.field) {
    case 'badgeLabels': {
      const labels = (row as { badges: readonly { label: string; count: number }[] }).badges;
      if (labels.length === 0) return '—';
      return labels
        .map((badge) => (badge.count === 1 ? badge.label : `${badge.label} ×${badge.count}`))
        .join(' · ');
    }
    case 'fishRarityCounts': {
      // `row.order` is the model's fixed rarity order, never the caller's key order.
      const group = row as { counts: Readonly<Record<string, number>>; order: readonly string[] };
      const parts = group.order.map((key) => `${key} ${group.counts[key] ?? 0}`);
      return parts.length === 0 ? '—' : parts.join(' · ');
    }
    case 'recallAccuracy': {
      const ratio = row as { numerator: number; denominator: number };
      // A zero denominator renders as a dash, not `0%`: "no recalls yet" and "0% recall" are
      // different claims, and the model keeps them distinguishable by keeping the row present.
      return ratio.denominator === 0 ? '—' : `${Math.round((ratio.numerator / ratio.denominator) * 100)}%`;
    }
    case 'rank':
      return (row as { value: string }).value;
    default:
      return String((row as { value: number }).value);
  }
}

/**
 * The rows this surface may render, in the model's order.
 *
 * Two filters:
 *
 * 1. {@link mayFieldAppearOnCard} - the policy's own documented renderer entry point. For a model the
 *    domain built this cannot fire, and it is kept because a surface that does not ask the policy is
 *    not using the policy it claims to use.
 * 2. A `null` value from {@link shareCardRowValue}, which is the one case where a row exists but has
 *    nothing to say.
 *
 * Row **labels** are deliberately not filtered; see the module header for why running a value-level
 * denylist over app-owned vocabulary deletes real rows.
 */
export function visibleShareCardRows(model: ShareCardModel): readonly VisibleShareCardRow[] {
  const out: VisibleShareCardRow[] = [];
  for (const row of model.rows) {
    if (!mayFieldAppearOnCard(model.kind, row.field)) continue;
    const value = shareCardRowValue(row);
    if (value === null) continue;
    out.push({ row, value });
  }
  return out;
}

/**
 * The subject name this surface may publish, or `null`.
 *
 * The single value-level privacy decision on a card, and the reason {@link visibleShareCardRows}
 * does not do it: this is the only string on a card that came from outside the application.
 */
export function visibleShareCardSubjectName(model: ShareCardModel): string | null {
  const name = model.subjectName;
  if (name === null) return null;
  return mayValueAppearOnCard(name) ? name : null;
}

/**
 * Was the subject name dropped **by the filter**, as opposed to never being selected?
 *
 * A dialog uses it to explain the missing heading. A card that silently loses its title reads as a
 * bug, and this one is a deliberate refusal - so the learner is told, in words.
 */
export function shareCardNameWasWithheld(model: ShareCardModel): boolean {
  return model.subjectName !== null && visibleShareCardSubjectName(model) === null;
}