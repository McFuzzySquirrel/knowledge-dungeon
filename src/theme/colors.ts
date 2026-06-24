/**
 * Shared 5-color palette for Knowledge Dungeon - applied in both
 * React CSS custom properties AND Phaser runtime colors.
 *
 * Our "Wood & Stone" palette:
 *   - stone (primary)   : warm grey-brown for panels, walls
 *   - gold  (accent)    : parchment gold for highlights, icons
 *   - moss  (secondary) : muted green for success states, nature elements
 *   - ink   (text)      : off-white warm tone for primary text
 *   - shadow (bg)       : deepest dungeon black-blue for backgrounds
 */

export const PALETTE = {
  stone: '#3a3048', // warm grey-purple-brown (panels, borders, "stone")
  gold: '#d4a857', // parchment / aged gold (highlights, accents, icons)
  moss: '#7a9c6c', // muted moss green (success, good states, nature)
  ink: '#e8e0d4', // off-white warm tone (primary text on dark backgrounds)
  shadow: '#0f1118', // deepest dungeon black-blue (background)

  // Derived / secondary tones for fine-tuning
  stoneDark: '#2a2235', // darker stone for hover/active states
  stoneLight: '#4e4260', // lighter stone for subtle borders
  goldDark: '#b88a36', // deeper gold for pressed states
  goldLight: '#ead7a3', // pale gold for soft highlights
  mossDark: '#5a7a4e', // deeper moss for hover
  mossLight: '#9ec48c', // lighter moss for disabled/soft
  inkMuted: '#8a8279', // muted ink for secondary text
  shadowLight: '#1a1d2a', // slightly lighter shadow for panel backgrounds

  // Semantic aliases
  success: '#7a9c6c', // moss
  danger: '#c44a4a', // reddish danger
  warning: '#d4a857', // gold
  info: '#6a9ec8', // cool blue for info
} as const;

/** CSS custom-property block that can be injected into Phaser text */
export function paletteCSS(): string {
  return `
    --kd-stone: ${PALETTE.stone};
    --kd-gold: ${PALETTE.gold};
    --kd-moss: ${PALETTE.moss};
    --kd-ink: ${PALETTE.ink};
    --kd-shadow: ${PALETTE.shadow};
  `;
}
