/**
 * The renderer-neutral statistics domain.
 *
 * Three modules, in dependency order:
 *
 * - {@link ./localCalendar} - local calendar-day keys and calendar-day arithmetic, with
 *   the daylight-saving rules stated. No imports at all.
 * - {@link ./statisticsEvents} - the idempotent, counted-once event ledger carried in the
 *   per-subject progression record's preserved app-owned fields. Imports only the
 *   calendar module.
 * - {@link ./statisticsMetrics} - the published metrics, the single implementation of
 *   every number the dashboard shows. Imports the calendar and event modules plus
 *   `@/core/review` and `@/core/progression`.
 *
 * Nothing here imports a store, a service, React, a renderer, the DOM, or the network.
 * `tests/phase18/statisticsDomainBoundary.test.ts` walks the import graph of `src/core/`
 * and fails on any renderer edge.
 */
export * from './localCalendar';
export * from './statisticsEvents';
export * from './statisticsMetrics';
export * from './activitySink';