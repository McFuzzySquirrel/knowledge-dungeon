# Create Repository Mindmap Skill

A GitHub Copilot skill that analyzes your repository and generates a Knowledge Dungeon subject (playable mindmap) documenting your codebase's architecture, design, and implementation.

## What This Skill Does

Invoke this skill in your Copilot session and it will:

1. **Analyze your repository** — Explore the codebase structure, identify core modules, technologies, and patterns
2. **Generate a mindmap structure** — Create 30-40 interconnected rooms organized by topic
3. **Write comprehensive notes** — Author detailed, validation-ready notes for each topic
4. **Apply a phase-ready profile** — Generate content for Creator, Scribe, or Archaeologist entry
5. **Create the subject folder** — Output a complete Knowledge Dungeon subject ready to import
6. **Provide import instructions** — Show you exactly how to load it into Knowledge Dungeon

## How to Use

### In Your Copilot Session

Simply invoke the skill with your repository:

```
/skill create-repo-mindmap
```

Or provide context about what you want:

```
/skill create-repo-mindmap --repo-path . --depth balanced --name "My Project"
```

### Parameters

- `--repo-path` (optional) — Path to analyze (default: current directory `.`)
- `--depth` (optional) — Content depth: `light`, `balanced`, or `deep` (default: `balanced`)
- `--name` (optional) — Project name for the mindmap (auto-detected from repo if not provided)
- `--output` (optional) — Where to write the subject folder (default: `maps/{project-name}-mindmap`)
- `--entry-phase` (optional) — Generated start profile: `creator`, `scribe`, `archaeologist` (default: `scribe`)
- `--review-ready` (optional) — Shortcut for `--entry-phase archaeologist`

## What You Get

After running the skill, you'll have a folder structure ready to import:

```
maps/{project-name}-mindmap/
├── dungeon.json          # Subject manifest with all rooms and edges
├── README.md             # Import instructions
└── rooms/
    ├── room-architecture-1/
    │   ├── notes.txt
    │   └── artifact.md   # present for archaeologist-ready output
    ├── room-tech-stack-1/
    │   ├── notes.txt
    │   └── artifact.md   # present for archaeologist-ready output
    └── ... (30-40 rooms total)
```

## Phase-Ready Generation

Use `--entry-phase` to control how playable the generated subject is on first load.

- `creator` — Structure-focused seed for map editing. Rooms are `Created` and ready for authoring.
- `scribe` — Default. Rooms include complete notes that are ready to study and validate in encounters.
- `archaeologist` — Review-ready seed. Rooms include finalized artifacts and progression metadata so users can jump straight into Archaeologist mode.

For archaeologist-ready output, generation should set all of the following:

- `dungeon.phaseState` to `ArchaeologistUnlocked` or `ArchaeologistActive`
- each room summary status to `ArtifactCollected`
- each room metadata to include:
    - `validationState.finalPass: true`
    - a non-empty `artifactMarkdown` (and mirrored `rooms/{room-id}/artifact.md`)
    - `reviewPassCount` initialized (usually `0`)

This keeps generated subjects aligned with current Knowledge Dungeon behavior while enabling immediate review runs.

## Topics Covered

The skill automatically creates rooms across these areas:

- **Architecture & Core Domains** — Key modules, structure, design patterns
- **Technology Stack** — Languages, frameworks, libraries, tools used
- **Features & Mechanics** — Main functionality and user-facing systems
- **Game/App Systems** — How components interact and integrate
- **Development Workflow** — Build, test, and deployment processes
- **Data & State Management** — Storage, persistence, state handling

## Importing Into Knowledge Dungeon

Once the skill generates the subject folder:

### Web Version
1. Open Knowledge Dungeon (web)
2. Click **"Create Subject"** → **"Import Subject"**
3. Drag-and-drop the generated `maps/{project-name}-mindmap/` folder
4. Click **"Load Subject"** to explore

### Desktop Version (Electron)
1. Open Knowledge Dungeon (app)
2. Go to **Admin** (bottom right)
3. Click **"Import Subject"**
4. Select the generated `maps/{project-name}-mindmap/` folder
5. Click **"Load"** to explore

## Then Explore

- **Creator Phase** — See the complete structure of your codebase mapped out
- **Scribe Phase** — Walk through each topic, refine the notes, defeat rooms
- **Archaeologist Phase** — Review your learning and build retention

If generated with `--entry-phase archaeologist` (or `--review-ready`), you can immediately choose **Archaeologist** from the phase picker and start reviewing artifacts.

## Example Session

```
User: /skill create-repo-mindmap

Copilot:
✓ Analyzing repository structure...
✓ Detected: JavaScript/TypeScript project
✓ Found key modules: src/core, src/game, src/ui
✓ Technology: React, Vite, TypeScript, Electron
✓ Generating 36 rooms across 6 topic areas...
✓ Writing 36 detailed notes...
✓ Creating edges and relationships (48 total)...
✓ Applying phase profile: archaeologist-ready

✅ Subject created: maps/my-project-mindmap/

📖 Next steps:
   1. Open Knowledge Dungeon
   2. Click "Import Subject"
   3. Select: maps/my-project-mindmap/
   4. Explore!
```

## Customization

### Adjusting Depth

- **`--depth light`** — Overview-level notes, fewer details, faster generation
- **`--depth balanced`** — Mix of overview and detail (recommended)
- **`--depth deep`** — Detailed technical notes with code examples

### Choosing a Start Profile

- **`--entry-phase creator`** — Best for teams who want to author/refine the map structure first
- **`--entry-phase scribe`** — Best for normal study progression from encounters to review
- **`--entry-phase archaeologist`** — Best for instant recall/review sessions after generation

### Using Your Own Repository

The skill works with:
- **Local repos** — `--repo-path ./my-project`
- **GitHub URLs** — Automatically clones and analyzes
- **Languages** — Auto-detects JavaScript, Python, Go, Rust, Java, C#, etc.

## What Makes These Notes Special

The skill generates notes that:

✅ **Pass Knowledge Dungeon validation** — Structured with required sections
✅ **Are educational** — Explain concepts, not just code
✅ **Include design decisions** — Why things were built a certain way
✅ **Connect topics** — Link to related concepts via edges
✅ **Match your codebase** — Analysis-driven, not generic templates

## Tips for Best Results

1. **Run in your repo root** — The skill needs access to source files to analyze
2. **Let it analyze first** — Don't use `--skip-analysis` unless it's a known structure
3. **Review the output** — Check `README.md` in the generated folder for context
4. **Start with balanced depth** — You can regenerate with `deep` if needed
5. **Customize after import** — Edit notes in Knowledge Dungeon during Scribe phase

## Common Questions

### Can I regenerate if I want different depth?
Yes! Just run the skill again with `--depth deep` or `--depth light` and it will overwrite.

### Can I start directly in Archaeologist after generation?
Yes. Generate with `--entry-phase archaeologist` (or `--review-ready`) and then select Archaeologist in the welcome phase picker.

### Can I use this on any language?
Yes! The skill auto-detects and adapts to JavaScript, Python, Go, Rust, Java, C#, and more.

### Will it work with monorepos?
Yes, but specify `--repo-path path/to/subproject` to focus on a specific part.

### Can I share the generated mindmap?
Absolutely! Copy the `maps/{project-name}-mindmap/` folder and share it. Others can import it directly.

### What if my repo is private?
The skill only analyzes what's in your local directory. No data is sent anywhere.

## Requirements

- GitHub Copilot with skill support enabled
- A repository to analyze (local path or cloned)
- Read access to your repository files
- Space for generated subject folder

## Example Use Cases

### For Onboarding
Generate a mindmap of your codebase to help new team members understand the architecture interactively.

### For Documentation
Create self-documenting architecture mindmaps that stay in sync with your code.

### For Learning
Use this skill to learn about any open-source repository by exploring its structure as a game.

### For Presentations
Generate a mindmap, import into Knowledge Dungeon, and walk through your architecture visually.

## Sharing Your Generated Mindmap

After generating:

```bash
# Email/share the folder
zip -r my-project-mindmap.zip maps/my-project-mindmap/

# Or commit to your repo
git add maps/my-project-mindmap/
git commit -m "docs: add knowledge dungeon mindmap"
git push

# Others can then import from your repo directly
```

## Troubleshooting

### "Skill not found"
Make sure you have GitHub Copilot with skill support. Try `/help` first.

### "Permission denied accessing files"
Ensure the skill has read access to your repository directory.

### "Notes seem generic"
Try `--depth deep` for more detailed analysis-driven content.

### "Too many/too few rooms"
Regenerate with different project name or adjust via manual config after generation.

## Next Steps

1. Invoke the skill: `/skill create-repo-mindmap`
2. Wait for completion
3. Import the generated folder into Knowledge Dungeon
4. Explore your codebase as an interactive mindmap!

---

**Want to create a mindmap of another project?** Just invoke the skill again in that repository!

**Questions?** Check the generated README.md in your mindmap folder for more details.
