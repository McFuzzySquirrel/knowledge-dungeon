/**
 * Offline static-shell service-worker registration wrapper (Phase 22).
 *
 * ## What this owns, and what it deliberately does not
 *
 * This module registers the hand-written `public/sw.js` for the origin the app is
 * served from. It owns exactly three things: the service-worker URL, the scope, and
 * the update check. It does not own the cache policy - that lives in `sw.js` - and
 * it never touches learner data.
 *
 * ## Base path (`import.meta.env.BASE_URL`) is the whole point
 *
 * The app is deployed under a Vite base path. On the Phase 23 GitHub Pages target
 * that is `/knowledge-dungeon/`, and on the default web build it is `/`. Both the
 * script URL and the registration scope are built from `import.meta.env.BASE_URL`,
 * never from a hard-coded `/`. Registering `/sw.js` with scope `/` under a
 * `/knowledge-dungeon/` deployment would 404 the script (the file is emitted at
 * `/knowledge-dungeon/sw.js`) and would also claim the wrong scope. So both values
 * come from the same source the HTML and the asset URLs come from.
 *
 * ## Registration is additive, never load-bearing
 *
 * A browser that refuses registration (a private window, an unsupported engine, a
 * disabled feature) must still boot the application. `registerOfflineShell` swallows
 * that failure and returns `null` - it does not throw, log, or block. There is
 * nothing here worth failing a boot over, and nothing here may ever be logged: no
 * learner data, no request data, no URL a learner typed. Failures are silent by
 * design.
 *
 * ## Why the module self-registers
 *
 * The build injects this module as an extra `<script type="module">` only when
 * `VITE_OFFLINE_SHELL` is on (`offlineShellPlugin` in `vite.config.ts`), so the
 * default artifact never contains it and no application entry has to reference the
 * service worker. On a flagged build the module registers on import; the guard below
 * is a second, cheap belt so an accidental import on an unflagged build is inert.
 */

/** The hand-written service worker's file name, emitted at the deploy base root. */
export const OFFLINE_SHELL_SW_FILENAME = 'sw.js';

/**
 * The service-worker script URL for a deploy base path.
 *
 * `baseUrl` defaults to `import.meta.env.BASE_URL`, which Vite inlines at build
 * time (`/` or `/knowledge-dungeon/`). Exposed for tests so the base-path behavior
 * is asserted without a browser.
 */
export function offlineShellSwUrl(baseUrl: string = import.meta.env.BASE_URL): string {
  return new URL(OFFLINE_SHELL_SW_FILENAME, new URL(baseUrl, window.location.origin)).href;
}

/** The registration scope for a deploy base path. Always the base directory itself. */
export function offlineShellScope(baseUrl: string = import.meta.env.BASE_URL): string {
  return new URL(baseUrl, window.location.origin).pathname;
}

/**
 * Registers the offline shell service worker, or returns `null` when the browser
 * cannot. Never throws.
 */
export async function registerOfflineShell(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;

  const baseUrl = import.meta.env.BASE_URL;
  try {
    const registration = await navigator.serviceWorker.register(offlineShellSwUrl(baseUrl), {
      scope: offlineShellScope(baseUrl),
      // Imported scripts (`offline-shell-manifest.js`) are always fetched from the
      // network during an update check, so a new build's version token is noticed
      // even when the top-level `sw.js` is unchanged. This is what keeps a stale
      // shell from surviving a deploy for up to the default 24-hour check window.
      updateViaCache: 'imports',
    });
    // Ask for an update immediately: an existing install checks for a new shell on
    // navigation only if it is older than the browser's check interval, and a
    // just-deployed build should not have to wait for it.
    void registration.update();
    return registration;
  } catch {
    return null;
  }
}

if (import.meta.env.VITE_OFFLINE_SHELL === 'true') {
  void registerOfflineShell();
}
