/**
 * Typography for Knowledge Dungeon.
 *
 * Phase 8 removed the remote Google Fonts dependency. The app now renders with
 * system font stacks only: no `@import`, no `@font-face`, no network request,
 * and no bundled binary font. `docs/plans/001-cozy-pixi-rebuild.md` Phase 8 exit
 * criterion is "The app renders without remote font requests."
 *
 * Stack policy, from the plan and the `implement-visual-theme` skill:
 * - "Prefer a readable system rounded font stack unless a verified CC0 font is
 *   selected." `ui-rounded` is a CSS generic family (Safari); the named entries
 *   that follow are faces present on mainstream operating systems.
 * - "Do not force a pixel font into long notes." The note/editor surfaces use
 *   `body`; only headings and HUD labels use the display stack.
 * - Long-form note text uses `md` (14px) at `normal` line height. Nothing in a
 *   learner's notes is rendered at a display size.
 *
 * No family name here may name a face that is not already local. Naming a web
 * font would work - the browser would simply fall back - but it would make the
 * "no remote font" claim depend on there being no `@font-face` for it, which is
 * exactly the kind of implicit coupling Phase 8 removes.
 *
 * A future CC0 font can be added by extending the *end* of a stack after the
 * system entries, with a CC0 record in `public/assets/asset-licenses.json` and
 * a self-hosted `@font-face` pointing at a bundled file - never a remote URL.
 *
 * Renderer-neutral by contract: see `RENDERER_NEUTRAL_THEME_MODULES` in
 * `cozyTokens.ts`. A PixiJS text object takes a `fontFamily` CSS string, so the
 * same values serve a canvas `Text` style as well as the DOM.
 *
 * Both tables are frozen: a stack is read by a renderer per text object and
 * shared with the DOM, so a consumer that edited one in place would change it
 * for everyone. See the integrity contract in `cozyTokens.ts`.
 */

export const TYPOGRAPHY = Object.freeze({
  /**
   * Display stack: headings, titles, HUD labels, tab text.
   *
   * `ui-rounded` is the rounded storybook face where the platform provides one
   * (macOS/iOS). The rest degrade through rounded system faces to `system-ui`.
   */
  primary:
    "ui-rounded, 'SF Pro Rounded', 'Hiragino Maru Gothic ProN', 'Segoe UI Variable Display', 'Trebuchet MS', 'Segoe UI', system-ui, -apple-system, sans-serif",

  /**
   * Body stack: notes, paragraphs, labels, everything a learner reads at length.
   * No monospace, no display styling - this is the default for long text.
   */
  body: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",

  /** Monospace: the note editor's code spans and keyboard hints. */
  mono: "ui-monospace, 'Cascadia Code', 'SFMono-Regular', Menlo, Consolas, 'DejaVu Sans Mono', monospace",
} as const);

/** Which stack a surface should use. Mirrors the Cozy token's role split. */
export const TYPOGRAPHY_ROLES = Object.freeze({
  display: 'primary',
  body: 'body',
  code: 'mono',
} as const satisfies Readonly<Record<string, keyof typeof TYPOGRAPHY>>);

/**
 * The font stack for a canvas text object, in the argument order a Phaser or
 * PixiJS `TextStyle` wants.
 *
 * Exported rather than inlined at each call site so a renderer cannot drift
 * from the DOM. Phase 8 does not call this from `src/game/**`; the two canvas
 * call sites there that still name a display serif are reported as a Phase 17
 * follow-up, because `src/game/**` is not Phase 8's to edit.
 */
export function canvasFontFamily(role: keyof typeof TYPOGRAPHY_ROLES = 'body'): string {
  return TYPOGRAPHY[TYPOGRAPHY_ROLES[role]];
}
