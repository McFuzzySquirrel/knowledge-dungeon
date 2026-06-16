# Repo-to-Mindmap Dungeon Generator

> This guide documents an aspirational CLI experience.
> The currently supported interface in this repository is the Copilot skill:
> `/skill create-repo-mindmap` with arguments documented in `SKILL.md`.

A reusable tool to automatically generate Knowledge Dungeon mindmaps documenting any software repository's architecture, design, and implementation.

## Overview

This tool analyzes a GitHub repository and generates a complete Knowledge Dungeon subject (playable mindmap) that documents:

- **Architecture & Core Domains** - Key modules and their responsibilities
- **Technology Stack** - Languages, frameworks, libraries used
- **Key Features** - Main functionality and mechanics
- **Design Patterns** - How the system is organized
- **Development Workflow** - Build, test, deploy processes
- **Data & State** - Storage and state management

The generated subject is immediately playable: import it into Knowledge Dungeon and explore your own codebase as an interactive learning experience.

## Quick Start

### Option 1: Using the CLI Tool (Recommended)

```bash
# Clone or download this package
git clone <this-repo>
cd repo-to-mindmap

# Install dependencies
npm install

# Generate a mindmap for a repository
node generate.js --repo https://github.com/owner/repo --output ./my-repo-mindmap

# Import into Knowledge Dungeon
# 1. Open Knowledge Dungeon
# 2. Click "Import Subject"
# 3. Select the generated folder
```

### Option 2: Using the Template Generator

```bash
# Interactive setup
npm run interactive

# Follow prompts to:
# 1. Specify your repository path or URL
# 2. Customize topic areas
# 3. Choose content depth (overview vs. detailed)
# 4. Generate the mindmap
```

### Option 3: Manual Template Approach

1. Copy the `template/` folder
2. Edit `config.json` with your repository details
3. Populate `topics/` with your content
4. Run `npm run build` to generate dungeon.json
5. Import into Knowledge Dungeon

## Features

### Automatic Analysis
- Scans repository structure
- Identifies key modules and files
- Detects technology stack
- Extracts README and documentation
- Analyzes package.json/requirements.txt

### Flexible Content
- **Mixed Depth**: Core modules detailed, supporting systems lighter
- **Customizable Topics**: Define what matters for your repo
- **Edge Types**: Subtopic, prerequisite, depends_on, related, analogy
- **Validation-Ready**: Generated notes pass Knowledge Dungeon rubric
- **Phase-ready profiles**: Generate Creator, Scribe, or Archaeologist entry-ready subjects

### Easy Customization
- Simple YAML/JSON config format
- Template system for note generation
- Support for multiple programming languages
- Markdown to Knowledge Dungeon format conversion

## How It Works

### 1. Analyze Repository
```
repo/
├── src/
├── tests/
├── docs/
└── README.md
     ↓
```

### 2. Generate Structure
```
36-48 rooms organized by:
- Architecture
- Tech Stack
- Features
- Patterns
- Workflow
- Optional: Testing, Docs, Deployment
```

### 3. Create Notes
```
For each room:
- Overview section
- Key Concepts
- Key Operations
- Design Insight

(Structured to pass validation)
```

### 4. Connect Topics
```
48+ edges with relationships:
- subtopic, prerequisite, depends_on, related, analogy
```

### 5. Output
```
{repo-name}-mindmap/
├── dungeon.json
├── README.md
└── rooms/
    └── room-{id}/
  ├── notes.txt
  └── artifact.md   # present for archaeologist-ready output
```

## Installation

### Prerequisites
- Node.js 18+
- npm or yarn
- Git (optional, for cloning repos)

### Setup

```bash
# Using npm
npm install -g repo-to-mindmap

# Or clone and run locally
git clone <this-repo>
cd repo-to-mindmap
npm install
npm link  # Make available globally as `mindmap` command
```

## Usage

### CLI Command

```bash
mindmap generate --repo <path-or-url> [options]

Options:
  --repo, -r <path>        Repository path or GitHub URL (required)
  --output, -o <path>      Output directory (default: ./{repo-name}-mindmap)
  --depth <level>          Content depth: light, balanced, deep (default: balanced)
  --entry-phase <phase>    Start profile: creator, scribe, archaeologist (default: scribe)
  --review-ready           Shortcut for --entry-phase archaeologist
  --lang <language>        Repository language: js, python, go, rust, java (auto-detect)
  --config <file>          Custom config file (YAML/JSON)
  --skip-analysis          Skip auto-analysis, use manual config only
  --verbose, -v            Verbose output
  --dry-run                Generate without writing files
```

### Examples

```bash
# Generate for a GitHub repo
mindmap generate --repo https://github.com/facebook/react

# Generate for local repo with deep analysis
mindmap generate --repo ./my-project --depth deep --output ~/knowledge-dungeons/my-project

# Generate review-ready output so users can jump directly into Archaeologist
mindmap generate --repo ./my-project --entry-phase archaeologist

# Use custom config
mindmap generate --repo ./codebase --config my-topics.yaml

# Generate and show what would be created
mindmap generate --repo ./project --dry-run --verbose
```

### Phase-ready output modes

- `creator`: room statuses stay `Created` for map-authoring workflows.
- `scribe`: default study flow with encounter-ready notes.
- `archaeologist`: review-ready output with collected artifacts so users can start in Archaeologist immediately.

For archaeologist-ready output, generate with:

- `dungeon.phaseState`: `ArchaeologistUnlocked` or `ArchaeologistActive`
- room summary statuses: `ArtifactCollected`
- room metadata with `validationState.finalPass: true`
- populated `artifactMarkdown` and matching `rooms/{room-id}/artifact.md`
- `reviewPassCount` initialized (typically `0`)

### Configuration

Create a `mindmap.config.yaml` in your repo:

```yaml
# Project metadata
project:
  name: "My Project"
  description: "Short description"
  language: "javascript"
  repoUrl: "https://github.com/user/repo"

# Topic areas to generate
topics:
  - id: "architecture"
    label: "Architecture & Core Domains"
    count: 5
    depth: "detailed"
    description: "Key modules and their responsibilities"
    
  - id: "tech-stack"
    label: "Technology Stack"
    count: 6
    depth: "balanced"
    
  - id: "features"
    label: "Features & Mechanics"
    count: 7
    depth: "balanced"
    
  - id: "workflow"
    label: "Development Workflow"
    count: 5
    depth: "light"

# Custom edges to create
edges:
  - from: "architecture"
    to: "tech-stack"
    type: "depends_on"
    
  - from: "features"
    to: "architecture"
    type: "depends_on"

# File patterns to analyze
patterns:
  core_modules:
    - "src/core/**/*.ts"
    - "src/domain/**/*.ts"
  
  game_systems:
    - "src/game/**/*.ts"
    - "src/scenes/**/*.ts"
  
  features:
    - "src/features/**/*.ts"
    - "src/ui/**/*.tsx"

# Exclude patterns
exclude:
  - "node_modules/**"
  - "dist/**"
  - "*.test.ts"
  - ".git/**"

# Note generation settings
notes:
  includeCodeExamples: true
  includeFileReferences: true
  maxExampleLines: 5
  validateAgainstRubric: true
```

## Understanding the Output

### dungeon.json Structure

```json
{
  "dungeon": {
    "schemaVersion": "1.0.0",
    "dungeonId": "my-project-mindmap",
    "subjectName": "How We Built My Project",
    "rooms": [
      { "roomId": "arch-core", "topic": "Core Architecture", "status": "Created" }
    ],
    "edges": [
      {
        "fromRoomId": "arch-core",
        "toRoomId": "tech-stack",
        "relationType": "depends_on",
        "createdAt": "2025-01-15T10:00:00Z",
        "createdByPhase": "Creator"
      }
    ]
  },
  "rooms": {
    "arch-core": {
      "roomId": "arch-core",
      "topic": "Core Architecture",
      "state": "Created",
      "notePath": "rooms/room-arch-core/notes.txt",
      "artifactPath": "rooms/room-arch-core/artifact.md",
      "validationState": { ... }
    }
  }
}
```

### Room Notes Structure

Each room's `notes.txt` follows this structure (for validation compatibility):

```markdown
# Overview

Brief explanation of what this topic is and why it matters.

## Key Concepts

The main ideas, terms, definitions. What are the core concepts here?

## Key Operations

How do you use this? What can you do with it? Include examples if helpful.

## Design Insight

Why is it designed this way? What's the philosophy? What decisions were made and why?
```

## Customization Guide

### For JavaScript/TypeScript Projects

The tool auto-detects and optimizes for:
- React, Vue, Angular frameworks
- Node.js, Express, Nest.js servers
- TypeScript strict mode analysis
- Package.json dependency extraction

### For Python Projects

- Identifies Django/Flask/FastAPI patterns
- Parses requirements.txt dependencies
- Recognizes test patterns (pytest, unittest)
- Extracts class hierarchies

### For Go Projects

- Scans package organization
- Extracts interface definitions
- Identifies middleware patterns
- Parses go.mod dependencies

### For Other Languages

Provide a custom config file specifying topics and patterns.

## Creating Custom Topics

Edit or extend the topic configuration:

```yaml
topics:
  - id: "custom-area"
    label: "My Custom Topic Area"
    count: 5
    depth: "balanced"
    description: "What this area covers"
    rooms:
      - id: "room-1"
        topic: "Specific Topic"
        sourceFiles:
          - "src/specific/**/*.ts"
      - id: "room-2"
        topic: "Another Topic"
        sourceFiles:
          - "src/another/**/*.ts"
```

## Connecting to Existing Repos

### Using a GitHub URL

```bash
mindmap generate --repo https://github.com/user/repo
# Clones to temp directory, analyzes, generates
```

### Using a Local Path

```bash
mindmap generate --repo /path/to/my/repo
# Analyzes immediately
```

### Analyzing Without Writing Files

```bash
mindmap generate --repo ./project --dry-run --verbose
# Shows what would be generated
```

## Importing Into Knowledge Dungeon

### Web Version

1. Launch Knowledge Dungeon (web)
2. Click **"Create Subject"**
3. Click **"Import Subject"**
4. Drag-and-drop or select the generated folder
5. Click **"Load Subject"** to explore

### Electron (Desktop)

1. Launch Knowledge Dungeon (desktop)
2. Go to **Admin** (bottom right)
3. Click **"Import Subject"**
4. Select the generated folder
5. Subject appears in list; click **"Load"**

## Sharing Your Mindmap

### As a GitHub Release

```bash
# Package the mindmap
zip -r my-repo-mindmap.zip my-repo-mindmap/

# Upload to GitHub Release
# Users can then import via the `.zip` file
```

### In the Repository

Add the generated mindmap to your repo:

```bash
# Commit to maps/ directory
git add maps/my-repo-mindmap/
git commit -m "docs: add knowledge dungeon mindmap of codebase"
git push
```

Users can then:
1. Clone your repo
2. Copy `maps/my-repo-mindmap/` to their Knowledge Dungeon `maps/` folder
3. Import via the app

### As a Standalone Template

Share just the config + generate script:

```bash
# Share config.yaml
# Others run: mindmap generate --repo https://github.com/user/repo --config your-config.yaml
```

## Examples

### Knowledge Dungeon Itself

Generated mindmap documenting the Knowledge Dungeon app:

```bash
mindmap generate --repo https://github.com/McFuzzySquirrel/knowledge-dungeon
```

### React

Mindmap of React library structure:

```bash
mindmap generate --repo https://github.com/facebook/react --depth deep
```

### Your Own Project

```bash
mindmap generate --repo ./my-project --output ~/mindmaps/my-project
```

## Advanced Features

### Custom Note Templates

Create `templates/note-{lang}.hbs`:

```handlebars
# {{topic}}

## Overview

This section covers {{topic}} in {{projectName}}.

## Key Concepts

{{#if keyConcepts}}
{{keyConcepts}}
{{/if}}

## Key Operations

{{#if keyOperations}}
{{keyOperations}}
{{/if}}

## Design Insight

{{#if designInsight}}
{{designInsight}}
{{/if}}

## Related Files

{{#each sourceFiles}}
- `{{this}}`
{{/each}}
```

### Programmatic Usage

```javascript
const { MindmapGenerator } = require('repo-to-mindmap');

const generator = new MindmapGenerator({
  repo: './my-project',
  depth: 'balanced',
  language: 'javascript'
});

const mindmap = await generator.generate();
await mindmap.write('./output');
```

### CI/CD Integration

```yaml
# .github/workflows/generate-mindmap.yml
name: Generate Mindmap

on:
  push:
    paths:
      - 'src/**'
      - 'mindmap.config.yaml'
  workflow_dispatch:

jobs:
  generate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v4
        with:
          node-version: '18'
      
      - run: npm install -g repo-to-mindmap
      - run: mindmap generate --repo . --output ./maps/mindmap
      
      - uses: actions/upload-artifact@v3
        with:
          name: mindmap
          path: ./maps/mindmap/
```

## Troubleshooting

### "Cannot find repository"

```bash
# Use full path or URL
mindmap generate --repo /full/path/to/repo
mindmap generate --repo https://github.com/owner/repo
```

### "Analysis found no modules"

```bash
# Provide custom config
mindmap generate --repo ./repo --config custom-topics.yaml
```

### "Notes don't validate"

Check:
- All required sections present (Overview, Key Concepts, Key Operations, Design Insight)
- At least 100 words per note
- Key terms from topic mentioned
- Links to related topics included

Run with `--verbose` to see validation details.

### "Generation is slow"

```bash
# Skip deep analysis
mindmap generate --repo ./repo --skip-analysis

# Use lighter depth
mindmap generate --repo ./repo --depth light
```

## Contributing

Improvements welcome! Areas to enhance:

- [ ] More language support (C#, Kotlin, Ruby, etc.)
- [ ] Auto-generated topic suggestions from code analysis
- [ ] Better file/code example extraction
- [ ] Interactive note review before generation
- [ ] Multi-repo mindmaps
- [ ] Framework-specific templates (Next.js, Django, etc.)

## License

MIT - Use freely in your projects.

---

**Questions?** Check the examples or open an issue.

**Want to share a mindmap you created?** Let us know and we'll feature it in the examples!
