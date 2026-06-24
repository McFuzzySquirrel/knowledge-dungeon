/**
 * Typography configuration for Knowledge Dungeon.
 *
 * Primary font: "Cinzel" (fantasy serif, loaded from Google Fonts via CSS)
 *   - Used for headings, titles, key HUD text
 * Secondary font: "JetBrains Mono" (monospace, for code/notes)
 *   - Already loaded via styles.css var(--font-mono)
 *
 * Both React and Phaser text objects reference these families.
 */

export const TYPOGRAPHY = {
  /** Primary fantasy serif - headings, titles, prominent UI text */
  primary: "'Cinzel', 'Georgia', 'Times New Roman', serif",
  /** Monospace - code, note editor, keyboard hints */
  mono: "'JetBrains Mono', ui-monospace, 'Cascadia Code', monospace",
  /** Body font - clean sans-serif where fantasy feels too heavy */
  body: "'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
} as const;

/** Google Fonts URL for Cinzel (regular 400 + bold 700 + black 900) */
export const CINZEL_FONT_URL =
  'https://fonts.googleapis.com/css2?family=Cinzel:wght@400;700;900&display=swap';

/**
 * Returns the Phaser WebFontConfig object so Phaser can load
 * Cinzel for its canvas text objects via the WebFontLoader plugin.
 */
export function phaserWebFontConfig() {
  return {
    google: {
      families: ['Cinzel:400,700,900'],
    },
    active: () => {
      // Font is loaded and ready - Phaser text will re-render automatically
    },
  };
}
