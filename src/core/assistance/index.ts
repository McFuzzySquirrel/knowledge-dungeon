/**
 * The renderer-neutral adaptive-assistance domain (plan section 8).
 *
 * Three modules, in dependency order, and the order is the whole design:
 *
 * - {@link ./types} - the closed vocabularies and the input/output shapes. Imports nothing.
 * - {@link ./subjectInput} - the **only** module that knows a subject snapshot's shape. It
 *   copies numeric and enum facts out of a room and cannot produce a sentence, because the
 *   room view it produces has no field a sentence could go in.
 * - {@link ./assistanceEngine} - the ranking. A pure function of
 *   {@link AssistanceEngineInput}; no clock, no randomness, no storage, no renderer, no
 *   network, and no write capability of any kind.
 *
 * `tests/phase19/assistanceDomainBoundary.test.ts` walks this directory's **runtime** import
 * graph and fails on any edge outside `src/core/`, which is the mechanical form of three
 * separate claims: assistance cannot render, cannot persist, and cannot leave the device.
 */
export * from './types';
export * from './subjectInput';
export * from './assistanceEngine';
