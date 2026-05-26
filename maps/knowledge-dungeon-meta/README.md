# Knowledge Dungeon Meta-Mindmap

## What Is This?

This is a **playable subject** for Knowledge Dungeon that documents the app's own architecture, design, and implementation. It's a meta-learning experience: you learn *about* the game by playing *through* the game itself.

## How to Use This Subject

### Web Version

1. Launch Knowledge Dungeon (web)
2. Click **"Create Subject"**
3. Click **"Import Subject"** 
4. Upload or drag-and-drop this folder's `dungeon.json`
5. Click **"Load Subject"** to start exploring

### Electron (Desktop) Version

1. Launch Knowledge Dungeon (desktop app)
2. Go to **Admin** section (bottom right)
3. Click **"Import Subject"**
4. Select this `knowledge-dungeon-meta` folder
5. Subject appears in your list; click **"Load"**

## What You'll Explore

The subject is organized into **6 major topic areas** with 36 total rooms:

### 1. Architecture & Core Domains (5 rooms)
- **Core Graph Module** — Manages dungeon structure (rooms, edges)
- **Validation Engine** — Deterministic quality checking
- **Progression System** — XP, ranks, badges
- **Artifacts & Review System** — Generated markdown records
- **Persistence Layer** — Storage abstraction

### 2. Technology Stack (7 rooms)
- **Frontend: React & Phaser** — UI and game rendering
- **State Management: Zustand** — Client-side store
- **Build Tools: Vite & TypeScript** — Development environment
- **Desktop: Electron** — Native app packaging
- **Testing: Vitest & Testing Library** — Test infrastructure
- **Code Quality: ESLint** — Linting and standards

### 3. The Three Phases (4 rooms)
- **Creator Phase** — Design the topic map
- **Scribe Phase** — Write notes and defeat rooms
- **Archaeologist Phase** — Review and consolidate learning

### 4. Game Systems (5 rooms)
- **Dungeon Rendering & Navigation** — Phaser canvas and movement
- **Encounter System** — Modal dialogs for note submission
- **Room Panel & HUD** — React overlays
- **Minimap & Controls** — Navigation aids

### 5. Features & Mechanics (7 rooms)
- **Subject Management** — Create, load, export subjects
- **Note Validation System** — Quality rubric and feedback
- **Quality Scoring** — Deterministic scoring (0–10)
- **Artifact Generation** — Markdown records
- **Review Mechanics** — Streaks and revalidation
- **Progression Tracking** — XP, ranks, badges

### 6. Development Workflow (6 rooms)
- **Build Scripts & Commands** — npm run ... reference
- **Testing Practices** — Vitest philosophy and examples
- **Persistence Strategies** — Web and Electron storage
- **Electron Packaging** — Building installers
- **Performance & Bundle Size** — Optimization strategies

## How It's Structured

Each room contains **detailed notes** explaining:

- **Core modules**: In-depth technical explanations with code references
- **Game systems**: How the UI works and integrates
- **Features**: User-facing mechanics and design rationale
- **Development**: Practical commands and best practices

Notes are designed to pass the **validation rubric**:
- Overview section
- Key concepts
- Key operations (or practical examples)
- Design insights (why it's built this way)

## Study Approach

### Creator Phase
You'll see the complete mindmap with 48 edges connecting related topics. Links indicate:
- **Subtopic** — Breaks down a concept
- **Prerequisite** — Learn this first
- **Depends_on** — Technical dependency
- **Related** — Connected concepts
- **Analogy** — Similar idea elsewhere

### Scribe Phase
Write notes explaining each aspect of the app. You'll learn by **articulating understanding**. Notes are validated to ensure depth.

### Archaeologist Phase
Revisit your notes and answer self-check prompts:
- *"What's the core concept here?"*
- *"How does this fit in the bigger picture?"*
- *"When would you use this in practice?"*
- *"What's the design philosophy?"*

## Tips for Best Learning

1. **Don't rush** — Read the notes carefully; they contain insights
2. **Take the notes seriously** — The validation rubric expects real understanding
3. **Follow the edges** — Use the minimap to explore related topics
4. **Review multiple times** — Come back to this subject after building with the app
5. **Compare to code** — The notes reference actual `/src/` paths; explore the real code

## File Structure

```
knowledge-dungeon-meta/
  dungeon.json              # Subject manifest (rooms list, edges, metadata)
  rooms/
    room-{id}/
      notes.txt             # Your notes (submit during Scribe phase)
      artifact.md           # Generated artifact (after defeating room)
```

## Notes

- This subject is **static content** — you can't edit room names or add new rooms via the Creator interface (it's sealed)
- You can clear rooms (Scribe phase) and review them (Archaeologist phase) normally
- Subject can be exported and shared with others
- Backups are created automatically (Electron version)

## Future Updates

This mindmap reflects **Knowledge Dungeon v1**. As the app evolves, the subject can be updated with new rooms and edges covering new features and systems.

---

Enjoy learning about the app by playing through it! 🎮📚
