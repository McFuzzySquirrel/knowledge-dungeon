/**
 * Subject persistence contracts.
 *
 * `types.ts` owns the subject schema version and the subject snapshot shapes.
 * `subjectValidation.ts` and `subjectMigration.ts` are pure, renderer-neutral,
 * and free of any storage access, so the legacy importer and the storage-v2
 * migration share one rule set and one transform.
 */
export * from './types';
export * from './subjectValidation';
export * from './subjectMigration';
