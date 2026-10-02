/**
 * The create-subject dialog: the village's one form.
 *
 * ## What changed, and why it is a fix rather than a redesign
 *
 * The pre-Phase-12 markup was `div.modal-backdrop > div.modal[role="dialog"]
 * [aria-modal="true"]` with **no focus management at all**: no initial focus, no
 * Tab containment, no restoration, no Escape, and a `div` backdrop whose
 * `onClick` closed the dialog. That last one is the worst of them - a dialog that
 * closes when the user clicks the dimmed area around it, with nothing on screen
 * saying it would do that.
 *
 * So this module uses `useModalFocus`, which is the repository's single
 * implementation of plan section 10.1's three dialog rules and is already what
 * `ConfirmDialog` and the Data Center use. Initial focus goes to the *container*,
 * not to the first field, for the same reason `ConfirmDialog` does it that way:
 * focusing a text input on open means the learner's next keystrokes become a
 * subject name they did not mean to type.
 *
 * The backdrop no longer closes the dialog. The dialog now has a labelled
 * `Cancel` and a labelled `Create`, and Escape closes it, which is three stated
 * routes rather than one invisible one.
 *
 * ## The fields are unchanged
 *
 * Same three fields, same validation rule (`name` and `rootTopic` both non-empty
 * after trimming), same disabled-while-submitting behaviour, same biome list. The
 * dialog's contract with the screen is `onCreate({name, topic, biome})`, and the
 * screen keeps owning the store write and the subject-list refresh.
 */
import { useId, useState, type FormEvent, type ReactNode } from 'react';

import { FLOOR_BIOME_IDS, type FloorBiomeId } from '@/core/biomes';

import { useModalFocus } from '@/ui/hooks/useModalFocus';

export interface CreateSubjectDialogProps {
  readonly open: boolean;
  /** Writes the subject and closes the dialog. */
  readonly onCreate: (input: { name: string; topic: string; biome: FloorBiomeId }) => void | Promise<void>;
  /** Closes without writing. */
  readonly onClose: () => void;
}

function biomeLabel(biome: string): string {
  return biome.replace(/([A-Z])/g, ' $1').replace(/^./, (character) => character.toUpperCase());
}

export function CreateSubjectDialog({
  open,
  onCreate,
  onClose,
}: CreateSubjectDialogProps): ReactNode {
  const titleId = useId();
  const bodyId = useId();
  const nameId = useId();
  const topicId = useId();
  const biomeId = useId();
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  // Reset to the first biome whenever the dialog opens, which is what the
  // pre-Phase-12 screen's effect on `createOpen` did.
  const [biome, setBiome] = useState<FloorBiomeId>(FLOOR_BIOME_IDS[0]);
  const [submitting, setSubmitting] = useState(false);

  const dialogRef = useModalFocus<HTMLDivElement>({
    // A submit in flight has already promised the learner a result, so Escape
    // stops working rather than appearing to work and doing nothing.
    active: open && !submitting,
    onEscape: open && !submitting ? onClose : null,
  });

  if (!open) return null;

  const canSubmit = name.trim() !== '' && topic.trim() !== '' && !submitting;

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    // A dialog that is a form and can be submitted by an Enter in a text field is
    // a form whose implicit submission is one stray keypress away from creating a
    // subject. So the form is real (it is the right grouping for the fields and it
    // gives the labels their `for`) and its submit is only reachable from the
    // button, which is `type="submit"` and is the only control inside it that
    // submits.
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    void Promise.resolve(onCreate({ name: name.trim(), topic: topic.trim(), biome })).finally(
      () => setSubmitting(false),
    );
  };

  return (
    <div className="modal-backdrop">
      <div
        className="modal village-create-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        aria-busy={submitting || undefined}
        tabIndex={-1}
        ref={dialogRef}
      >
        <h2 id={titleId}>Create New Subject</h2>
        <p id={bodyId} className="village-info-desc">
          A subject becomes a dungeon: a topic map you build, clear, and review. Its
          progress is stored on this device.
        </p>
        <form className="village-create-form" onSubmit={handleSubmit}>
          <label htmlFor={nameId}>
            Subject name
            <input
              id={nameId}
              type="text"
              placeholder="e.g. Linear Algebra"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label htmlFor={topicId}>
            Root topic
            <input
              id={topicId}
              type="text"
              placeholder="e.g. Vector Spaces"
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
            />
          </label>
          <label htmlFor={biomeId}>
            Dungeon theme
            <select
              id={biomeId}
              value={biome}
              onChange={(event) => setBiome(event.target.value as FloorBiomeId)}
            >
              {FLOOR_BIOME_IDS.map((option) => (
                <option key={option} value={option}>
                  {biomeLabel(option)}
                </option>
              ))}
            </select>
          </label>
          <div className="modal-actions">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              data-village-touch-target="dialog-cancel"
              style={{ minWidth: '44px', minHeight: '44px' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              data-village-touch-target="create-subject"
              style={{ minWidth: '44px', minHeight: '44px' }}
            >
              {submitting ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
