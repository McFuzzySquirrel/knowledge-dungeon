/**
 * Renderer-neutral application contracts.
 *
 * World models, world events, application commands, and renderer capabilities
 * are declared once here. Renderers adapt to these interfaces; they are never
 * imported the other way around. `src/core` and `src/application` must not
 * import Phaser, PixiJS, or anything under `src/game`.
 */
export * from './world';
export * from './events';
export * from './commands';
export * from './renderer';
