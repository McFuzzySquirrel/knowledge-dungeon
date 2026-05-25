# Customization

This guide covers two questions that come up often:

1. **How do I add custom images** (logos, room art, sprites) so they show up in
   the React UI or the Phaser dungeon scene?
2. **Where is the "root"** when I create a new subject — both the *root topic /
   root room* concept and the on-disk location of saved data?

---

## 1. Adding custom images

The project is built with [Vite](https://vitejs.dev/), which gives you two
places to put image assets:

| Location | Use when… | Reference in code as… |
| -------- | --------- | --------------------- |
| `public/` | The file is a fixed asset that should be copied to the build output verbatim (favicons, large textures, anything you don't need to import). | An absolute URL path, e.g. `/my-image.png` or `/assets/sprites/hero.png`. |
| `src/` (e.g. `src/assets/`) | You want Vite to hash, bundle, and tree-shake the asset alongside your TypeScript code. | An `import` statement, e.g. `import heroUrl from '@/assets/hero.png';`. |

### Option A — Drop-in static asset via `public/`

1. Put your file under `public/`. You can create any subfolders you want:

   ```text
   public/
     assets/
       ui/
         my-logo.png
       sprites/
         hero.png
   ```

2. Reference it from React or Phaser using its **absolute URL path** —
   everything in `public/` is served from the site root, so
   `public/assets/ui/my-logo.png` becomes `/assets/ui/my-logo.png`:

   ```tsx
   // React
   <img src="/assets/ui/my-logo.png" alt="" />
   ```

   ```ts
   // Phaser scene (e.g. in DungeonScene.preload)
   this.load.image('hero', '/assets/sprites/hero.png');
   // …then in create():
   this.add.image(x, y, 'hero');
   ```

   This works the same in `npm run dev`, the production web build, and the
   Electron build.

### Option B — Bundled asset via `src/`

If you want the image to be hashed for cache-busting and only included when
imported, drop it under `src/assets/` (create the folder if it doesn't exist)
and import it:

```tsx
import heroUrl from '@/assets/hero.png';

export function Banner() {
  return <img src={heroUrl} alt="" />;
}
```

For Phaser, do the same import and pass the resolved URL to `this.load.image`:

```ts
import heroUrl from '@/assets/hero.png';

// inside a Phaser.Scene
preload() {
  this.load.image('hero', heroUrl);
}
```

### Where to render images

- **Top-level UI surfaces** (HUD, room panel, welcome screen, help overlay)
  live in `src/ui/`. Drop an `<img>` or background-image CSS into the
  appropriate component there.
- **In-dungeon visuals** (room walls, player sprite, decorations) are drawn
  by `src/game/scenes/DungeonScene.ts`. Today the scene draws rooms and the
  player as solid `Phaser.GameObjects.Rectangle` / `Graphics` shapes. To use
  custom artwork, add a `preload()` method to the scene that loads your
  textures, then replace the `add.rectangle(...)` calls with
  `add.image(...)` / `add.sprite(...)`.

### Tips

- Stick to web-friendly formats: `.png`, `.jpg`, `.webp`, `.svg`, `.gif`.
- For pixel art, set `pixelArt: true` in the Phaser `Game` config (see
  `src/game/createGame.ts`) so textures aren't blurred when scaled.
- Keep large binary assets out of `src/`. Anything bigger than a few hundred
  KB is usually better off in `public/` so it doesn't bloat the JS bundle
  (the CI guard `npm run check:bundle-size` will catch regressions).

---

## 2. Where the "root" lives when creating a subject

There are **two** different "roots" to know about. Don't confuse them.

### 2a. The root *topic* (a domain concept)

When you create a new subject from the welcome screen you fill in two fields:

- **Subject name** — the human-readable title of the dungeon
  (e.g. `Linear Algebra`).
- **Root topic** — the seed concept that becomes the *root room* of the
  dungeon (e.g. `Vector Spaces`).

The root topic is rendered as the first room in the Phaser scene and is the
spawn point for the player. In the data model it is the room whose
`isRoot: true` flag is set; see `src/game/systems/dungeonGenerator.ts` and the
`createRootDungeon` helper in `src/core/graph/`.

Every additional room you add via the **Topic → Add child topic** form is
attached to the currently-focused room as a child of that subgraph — there is
only ever one root, and it's whatever you typed in that "Root topic" field
when you created the subject.

### 2b. The root *directory / storage key* (where saved subjects live)

Persistence is handled by `src/services/persistence/subjectPersistence.ts`,
which transparently picks one of two backends:

#### Electron desktop build

Subjects are saved as JSON files under your OS's per-user *application data*
directory, scoped by subject id:

```text
<userData>/dungeon-data/
  <subject-id>/
    dungeon.json          # the SubjectSnapshot
    .backups/             # timestamped previous versions
```

`<userData>` is determined by Electron's `app.getPath('userData')` and resolves
to the standard location for your platform:

| Platform | Default `<userData>` |
| -------- | ----------------------- |
| macOS    | `~/Library/Application Support/knowledge-dungeon/` |
| Windows  | `%APPDATA%\knowledge-dungeon\` |
| Linux    | `~/.config/knowledge-dungeon/` |

The directory is created on demand the first time you save a subject — see
`dungeonDataRoot()` and `ensureSubjectRoot()` in `src/electron/main.ts`.

#### Web build (browser / `npm run dev`)

There is no filesystem, so subjects are written to `localStorage` under a
namespaced key prefix:

```text
knowledge-dungeon:v1:activeSubjectId  → "<subject-id>"
knowledge-dungeon:v1:subjects         → JSON array of known subject ids
knowledge-dungeon:v1:subject:<subject-id>  → JSON SubjectSnapshot
knowledge-dungeon:v1:progression      → XP / rank state
knowledge-dungeon:v1:session          → last-used phase, class, etc.
```

You can inspect these in your browser DevTools under *Application →
Local Storage*. Use the import/export helpers exposed from
`subjectPersistence.ts` to move a subject between machines or between the
web and Electron builds.
