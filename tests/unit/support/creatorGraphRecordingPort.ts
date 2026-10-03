/**
 * A recording implementation of `CreatorGraphStorePort`.
 *
 * The application layer reaches the outside world through exactly three ports,
 * so a recording port is enough to observe a command completely: which snapshot
 * it read, which snapshot it committed, which failure message it reported, and
 * in what order. Nothing here is a stub that hides behavior - the port is the
 * seam the production code was written for, and every assertion about "did it
 * write?" is an assertion about `commits`, not about a spy on internals.
 */
import type { CreatorGraphStorePort } from '@/application/creatorGraphCommands';
import type { SubjectSnapshot } from '@/core/validation/persistence';

export interface RecordingStore {
  port: CreatorGraphStorePort;
  /** Every snapshot handed to `commit`, in order. */
  readonly commits: SubjectSnapshot[];
  /** Every message handed to `reportFailure`, in order. */
  readonly failures: string[];
  /** How many times `readSnapshot` was called. */
  readCount(): number;
  /** The snapshot the port currently holds, or `null` for "no active subject". */
  current(): SubjectSnapshot | null;
}

export function createRecordingStore(initial: SubjectSnapshot | null): RecordingStore {
  let held = initial;
  let reads = 0;

  const commits: SubjectSnapshot[] = [];
  const failures: string[] = [];

  return {
    commits,
    failures,
    readCount: () => reads,
    current: () => held,
    port: {
      readSnapshot: () => {
        reads += 1;
        return held;
      },
      commit: async (snapshot) => {
        commits.push(snapshot);
        held = snapshot;
      },
      reportFailure: (message) => {
        failures.push(message);
      },
    },
  };
}

/**
 * A deterministic room-id mint: `room-minted-1`, `room-minted-2`, ...
 *
 * Injected rather than stubbed so nothing in these tests can reach
 * `Math.random` or `Date.now` for an id.
 */
export function createSequentialRoomIds(prefix = 'room-minted'): () => string {
  let next = 0;
  return () => `${prefix}-${(next += 1)}`;
}