/**
 * Shared icon definitions for Knowledge Dungeon.
 *
 * All icons are defined as inline SVG data URLs so they work in both
 * React (as <img src="..."> or CSS background-image) and Phaser
 * (loaded via this.textures.addBase64 or this.load.svg).
 *
 * Icon set (15 icons):
 *   chest, map, book, gear, sword, potion, shield, scroll,
 *   key, crown, star, heart, compass, torch, crystal
 */

type IconName =
  | 'chest'
  | 'map'
  | 'book'
  | 'gear'
  | 'sword'
  | 'potion'
  | 'shield'
  | 'scroll'
  | 'key'
  | 'crown'
  | 'star'
  | 'heart'
  | 'compass'
  | 'torch'
  | 'crystal';

// Simple 24×24 pixel-art-style SVG icons with the "gold" accent
function svgIcon(d: string, fill = '#d4a857'): string {
  // data URL encoding via encodeURIComponent is safe for SVG
  const raw = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><path d="${d}" fill="${fill}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(raw)}`;
}

export const ICONS: Record<IconName, string> = {
  chest: svgIcon(
    'M5 4h14l2 6H3l2-6zm0 8v6h14v-6H5zm2-7v2h10V5H7zM6 12v1h12v-1H6z',
    '#d4a857',
  ),
  map: svgIcon(
    'M3 5l6-2 6 2 6-2v14l-6 2-6-2-6 2V5zm5 1.16V18l4-1.33V4.84L8 6.16zM16 4.84L12 6.16V18l4 1.33V4.84z',
    '#d4a857',
  ),
  book: svgIcon(
    'M4 4h6l2 1 2-1h6v14h-7l-2 1-2-1H4V4zm2 2v10h4l1 .5V7l-1-.5L6 6zm10 0l-4 .5V16.5l1-.5h3V6z',
    '#d4a857',
  ),
  gear: svgIcon(
    'M12 2l1.5 4.1.8-.2 1.4-4.3 3.5 3.5-4.3 1.4-.2.8L19 10l-1.2 3.6-1.5-.6-.8.2-.5 1.7L11 17l-1.2-3.5-1.6.6-.7-.2L7 10.1l4-1.4.6-1.5L10 6l2-4zm0 6a2 2 0 100 4 2 2 0 000-4z',
    '#d4a857',
  ),
  sword: svgIcon(
    'M18.36 2.64l2.83 2.83-1.41 1.41-2.83-2.83 1.41-1.41zM7.07 7.07L9.9 4.24 11.31 5.66 8.49 8.48l4.95 4.95-7.78 7.78-4.24-4.24 7.78-7.78-2.13-2.12zM16.24 2l2.83 2.83-1.42 1.41L14.83 3.4 16.24 2z',
    '#d4a857',
  ),
  potion: svgIcon(
    'M9 2V1h6v1h-1v3.5l4 6V15H6v-3.5l4-6V2H9zm1 4.5L7 12h10l-3-5.5V2h-4v4.5zM8 16h8v2H8v-2z',
    '#d4a857',
  ),
  shield: svgIcon(
    'M12 2L4 5v5c0 5.5 3.8 10.3 8 12 4.2-1.7 8-6.5 8-12V5l-8-3zm0 2.18L18 6.3v3.7c0 4.2-2.8 8.1-6 9.8-3.2-1.7-6-5.6-6-9.8V6.3l6-2.12zM11 7h2v3h3v2h-3v3h-2v-3H8v-2h3V7z',
    '#d4a857',
  ),
  scroll: svgIcon(
    'M4 4h16v4H4V4zm0 6h16v2H4v-2zm0 4h10v2H4v-2zm0 4h16v4H4v-4zm2 2v2h12v-2H6z',
    '#e8e0d4',
  ),
  key: svgIcon(
    'M12.7 2a6 6 0 00-5.7 8L2 15v3h3v-2h2v-2h2l2.9-2.9a6 6 0 10.8-9.1zm-.7 2a4 4 0 11-4 4 4 4 0 014-4zm1 3l1 1-1 1 1 1 1-1 1-1-1-1h-2z',
    '#d4a857',
  ),
  crown: svgIcon(
    'M2 4l3 8 7-5 7 5 3-8-4 4-6-4-6 4-4-4zm0 12h20v4H2v-4zm2 2v2h16v-2H4z',
    '#d4a857',
  ),
  star: svgIcon(
    'M12 2l3 6 6 1-4 4 1 7-6-3-6 3 1-7-4-4 6-1 3-6z',
    '#d4a857',
  ),
  heart: svgIcon(
    'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
    '#c44a4a',
  ),
  compass: svgIcon(
    'M12 2a10 10 0 1010 10A10 10 0 0012 2zm0 18a8 8 0 118-8 8 8 0 01-8 8zm4.9-12.9l-2.8 6.2-6.2 2.8 2.8-6.2 6.2-2.8zM12 11a1 1 0 101 1 1 1 0 00-1-1z',
    '#d4a857',
  ),
  torch: svgIcon(
    'M13 2v6h3l-4 9v-6H9l4-9zm-2 2.5L9 8h2v5l1-2.5V4.5z',
    '#d4a857',
  ),
  crystal: svgIcon(
    'M12 2L2 12l10 10 10-10L12 2zm0 3.8L18.2 12 12 18.2 5.8 12 12 5.8zM12 8l-4 4 4 4 4-4-4-4zm0 2.5L13.5 12 12 13.5 10.5 12 12 10.5z',
    '#6a9ec8',
  ),
} as const;

export type { IconName };

/** Map of icon name to accessible label */
export const ICON_LABELS: Record<IconName, string> = {
  chest: 'Treasure chest',
  map: 'Map',
  book: 'Book of knowledge',
  gear: 'Gear / settings',
  sword: 'Sword / encounter',
  potion: 'Potion',
  shield: 'Shield / defense',
  scroll: 'Scroll / notes',
  key: 'Key / unlock',
  crown: 'Crown / mastery',
  star: 'Star / favorite',
  heart: 'Heart / health',
  compass: 'Compass / navigation',
  torch: 'Torch / light',
  crystal: 'Crystal / artifact',
};

/** Returns an <img>-ready data URL for the named icon */
export function iconUrl(name: IconName): string {
  return ICONS[name];
}

/** Returns a React-safe object for use in <img src={...}> */
export function iconSrc(name: IconName): string {
  return ICONS[name];
}
