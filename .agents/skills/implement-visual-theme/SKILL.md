---
name: implement-visual-theme
description: Applies the Cozy storybook design system across React DOM and PixiJS with shared tokens, accessible contrast, reduced motion, system-font fallback, and CC0 media checks.
---

# Implement the Cozy Visual Theme

Use this skill for the visual system in `docs/plans/001-cozy-pixi-rebuild.md`. React DOM and PixiJS must consume shared design decisions without duplicating palettes or requiring remote fonts.

## Process

### 1. Define tokens

Create shared tokens for parchment surfaces, moss and berry accents, ink text, firelight highlights, borders, spacing, typography, motion, focus, and high-contrast states. Keep CSS variables and Pixi color constants generated from the same source of truth where practical.

### 2. Define typography

Prefer a readable system rounded font stack unless a verified CC0 font is selected. Do not import Google Fonts or another remote font. Use readable body text and restrained display text; do not force a pixel font into long notes.

### 3. Apply React DOM styles

Replace raw colors and old theme selectors with Cozy tokens. Use rounded storybook panels, clear focus rings, strong contrast, generous touch targets, and responsive side-panel or bottom-sheet layouts.

### 4. Apply Pixi styles

Use the shared palette for world surfaces, lighting, selection, and effects. Keep text and complex controls in React DOM. Use restrained filters and particles, with reduced-motion fallbacks.

### 5. Register media

Every new image, icon, animation, and sound must have CC0 metadata, source, checksum, and license record. Do not include unverified legacy media in the default Pixi bundle.

### 6. Validate

Test contrast, focus, 200% zoom, 320px layout, tablet portrait and landscape, reduced motion, and representative world routes. Confirm no remote font or media request is required.

## Output

The theme work should produce:

- Shared Cozy tokens
- React DOM component styling
- Pixi world styling
- Accessible motion and contrast behavior
- CC0-compliant media references
- Responsive and reduced-motion verification evidence
