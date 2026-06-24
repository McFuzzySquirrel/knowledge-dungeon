---
name: implement-visual-theme
description: >
  Applies a unified visual theme (color palette, typography, border styles,
  and iconography) across both the React UI shell and Phaser game canvas
  in Knowledge Dungeon, following the research in docs/research/ui-enhancements.txt.
---

# Skill: Implement a Visual Theme

Harmonizes the visual identity of the React UI shell and Phaser game canvas by applying shared colors, fonts, borders, and icons across both rendering systems.

---

## Process

### Step 0: Create the Shared Colors Module

Before changing any scene or component files, create the single source of truth for all Phaser hex values. This prevents colors from getting scattered across scene files.

Create `src/game/themeColors.ts`:

```typescript
/** Single source of truth - CSS vars in src/styles.css must match these values. */
export const THEME_COLORS = {
  bgDark:       0x1a1025,
  bgPanel:      0x2a1a3e,
  accentGold:   0xc9a84c,
  textPrimary:  0xe8dcc8,
  accentBlue:   0x4a7fb5,
} as const;
```

All Phaser scene files import from this module:
```typescript
import { THEME_COLORS } from '../game/themeColors';
```

### Step 1: Define the Palette

Choose a cohesive 5-color palette. Load `assets/palettes.md` for full palette definitions including Dark Fantasy and Wood & Stone examples with hex-to-0x conversion tables.

Define the chosen palette as CSS custom properties on `:root` in `src/styles.css`:

```css
:root {
  --bg-dark: #1a1025;
  --bg-panel: #2a1a3e;
  --accent-gold: #c9a84c;
  --text-primary: #e8dcc8;
  --accent-blue: #4a7fb5;
}
```

Mirror these exact values in `src/game/themeColors.ts` (see Step 0).

### Step 2: Apply in React

Replace hardcoded color values in React components with CSS custom properties:

```css
.hud-sidebar {
  background: var(--bg-panel);
  border: 2px solid var(--accent-gold);
  color: var(--text-primary);
}

.btn-primary {
  background: var(--accent-blue);
  color: var(--text-primary);
  border: 1px solid var(--accent-gold);
}
```

Apply to all panels, modals, buttons, text, and backgrounds. Update the three theme variants (Night, Arcade, Aurora) to use the same custom property names with different values.

### Step 3: Apply in Phaser

Use the shared theme constants in Phaser scene code:

```typescript
// In Phaser scene create() - import at top of file
import { THEME_COLORS } from '../game/themeColors';

this.add.rectangle(x, y, width, height, THEME_COLORS.bgPanel)
  .setStrokeStyle(2, THEME_COLORS.accentGold);

this.add.text(x, y, 'Room Info', {
  fontFamily: '"Press Start 2P", monospace',
  fontSize: '14px',
  color: '#e8dcc8',
});
```

**Note:** Phaser text `color` uses CSS hex strings (not 0xNNN) - keep text color strings in sync with `--text-primary` from `src/styles.css`.

### Step 4: Choose and Apply a Shared Font

Select one primary font. For a pixel/game aesthetic, use "Press Start 2P" (Google Fonts):

```css
/* In src/styles.css */
@import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap');

:root {
  --font-game: '"Press Start 2P", monospace';
}

body, .ui-skin {
  font-family: var(--font-game);
}
```

In Phaser, use the same font family string:

```typescript
this.add.text(x, y, text, {
  fontFamily: '"Press Start 2P", monospace',
  fontSize: '12px',
  color: TEXT_PRIMARY,
});
```

For readable body text, consider a secondary readable font (e.g., "IBM Plex Mono") and use it for longer text sections like notes.

### Step 5: Unify Borders and Shadows

Pick a border style and apply consistently:

```css
/* 2px solid gold border - all panels */
.panel, .modal, .tooltip {
  border: 2px solid var(--accent-gold);
  border-radius: 4px;
  box-shadow: 0 0 8px rgba(201, 168, 76, 0.3);
}
```

Recreate in Phaser where panels exist:

```typescript
const panel = this.add.rectangle(x, y, w, h, THEME_COLORS.bgPanel)
  .setStrokeStyle(2, THEME_COLORS.accentGold);
```

### Step 6: Integrate Shared Icons

Create or source 10–15 icons as a sprite sheet in `public/assets/ui/icons.png` with a matching `public/assets/ui/icons.json` (Phaser frame data). Use the same sprite sheet in both React and Phaser:

```typescript
// Phaser - load in preload()
this.load.atlas('icons', '/assets/ui/icons.png', '/assets/ui/icons.json');

// Use in create()
this.add.image(x, y, 'icons', 'icon-chest');
```

```tsx
// React - reference the same image
import iconsUrl from '/assets/ui/icons.png';
// Use CSS background-position or <img> with the sprite
```

---

## Output Format

The theme change should produce:
- Updated CSS custom properties in `src/styles.css`
- Updated Phaser color constants in scene files
- Updated fontFamily on all Phaser text objects
- Consistent border styles on all React panels and Phaser UI rectangles
- Shared icon sprite sheet in `public/assets/ui/`

---

## Validation

- [ ] React UI and Phaser game canvas use the same hex codes for all themed elements
- [ ] A single font renders consistently in both React and Phaser (same family, similar size scaling)
- [ ] All panels and modals in React use the same border/shadow style
- [ ] Phaser in-game UI elements (room labels, HUD overlays) use matching border styles
- [ ] Icons render correctly in both React and Phaser from the same sprite sheet
- [ ] All three themes (Night, Arcade, Aurora) still work after the change
- [ ] Mobile responsive layout is not broken by the theme changes

---

## Gotchas

- Phaser uses hex numbers (0xRRGGBB) for fill/stroke, but CSS uses hex strings (#RRGGBB) - keep a mapping table in a shared constants file to ensure they stay in sync
- Font sizes will NOT match 1:1 between React (CSS pixels) and Phaser (canvas pixels) - adjust Phaser fontSize to be ~2px smaller for visual parity
- The "Press Start 2P" pixel font is very large at small sizes - use it for headings and labels, not body text; use a readable fallback for note content
- Theme changes affect ALL components - test the full application after applying
- The existing three themes (Night, Arcade, Aurora) must all adopt the new unified palette structure, not just the default theme
- Google Fonts `@import` requires network access on first load - for Electron offline builds, download the font `.woff2` file to `public/assets/fonts/` and reference it via `@font-face` in `src/styles.css` instead of `@import url(...)`. Coordinate with `infrastructure-engineer` for Electron compatibility

---

## Reference

See [docs/research/ui-enhancements.txt](../../../docs/research/ui-enhancements.txt) for the original research:
- **Item 1** - Unified color palette rationale and approach
- **Item 2** - Typography harmonization
- **Item 3** - Border/panel frame unification
- **Item 4** - Shared icons and asset bridging

See [docs/PRD.md](../../../docs/PRD.md):
- **Section 14 - Phase 3a** - Visual UI Unification
- **Section 12** - Theming and interaction design
