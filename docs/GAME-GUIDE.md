# Knowledge Dungeon - Game Guide

## Overview

Knowledge Dungeon is a local-first study dungeon-crawler. You build subjects as mindmaps of topic-rooms, then defeat each room's encounter by writing structured notes. Your progress earns XP, loot, badges, and cross-subject achievements.

All data lives on your device - no accounts, no cloud.

---

## Getting Started

### First Launch

When you open the app, you arrive at the **Welcome Screen**. From here you can:

1. **Create a new subject** - Enter a subject name, root topic, and pick a Dungeon theme (biome). Click Create.
2. **Continue to Village** - If subjects already exist, jump straight to the village.
3. **Start the tutorial** - A guided 3-room dungeon that teaches notes, attachments, and navigation.

### Player Setup

Before entering a dungeon, pick an **archetype** from the Player Setup tab:

| Archetype | Perk |
|-----------|------|
| **Scholar** | Quality bonus on notes - higher loot rates |
| **Cartographer** | Cross-link suggestions in the editor |
| **Archivist** | Higher self-check cap during review phase |

---

## The Village Hub

The village is your home base. Walk around with **WASD** or arrow keys and press **E** to interact with buildings.

### Village Buildings

| Building | What it does |
|----------|-------------|
| **🌀 Dungeon Portals** | Enter a subject dungeon. Biome shows in the info panel - you can change it anytime. |
| **🏛 Keeper's Tower** | Quest board with guided objectives. The Keeper NPC gives step-by-step advice. |
| **🏰 Guild Hall** | Lists all your subjects. Create new subjects or enter existing ones. |
| **⚔ Training Grounds** | Start the tutorial dungeon. |
| **🏆 Trophy Hall** | View cross-subject stats - badges, inventory, collected notes, dungeons mastered. |
| **📖 Library** | Game guide and controls reference (this document!). |
| **📋 Quest Board** | Active quests with progress indicators. |
| **🪧 Signposts** | Directional waypoints. The entrance signpost shows a welcome message. |

### Creating a Subject from the Village

Open the Guild Hall (walk up + press E), then click **"+ Create New Subject"**. Or use the **"+ Create New"** button in the HUD sidebar. Fill in subject name, root topic, and dungeon theme.

---

## The Three Phases

Knowledge Dungeon has three gameplay phases. You progress through them for each subject.

### Phase 1: Creator

**Goal:** Build your topic map by adding rooms.

- Walk to any room and press **E** to open the Room Panel
- Use the "Add child topics" textarea to create subtopic rooms
- Each new line becomes a separate room. Commas also split topics
- Rooms are linked as subtopics and form the dungeon layout
- The root room (your subject's central topic) cannot be deleted
- You can create rooms from ANY room - deeper nesting stays on the same floor

**Tip:** Each direct child of the root topic becomes its own "floor" in the dungeon.

### Phase 2: Scribe

**Goal:** Clear every room by writing structured notes.

- Walk through the dungeon (WASD/arrows), press **E** to enter a room
- The Note Editor opens with three section tabs: **Summary**, **Key Points**, **Recall Question**
- Use the **Format** toolbar button for markdown: bold, italic, code, links, images, lists, headings, quotes, horizontal rules
- Click **Images** to upload and attach images to the room
- Click **Checks** to see validation criteria (scored 0-2 per criterion)
- Tick "I confirm these notes are my own" and click **Defeat Encounter** to clear the room
- Quality bonus (0-10) determines loot rarity - thorough notes with all sections yield better rewards

**Markdown tips:**
- `**bold**` for emphasis
- `[label](https://...)` for clickable links
- `![alt](url)` for embedded images
- `- ` for bullet lists
- `` `code` `` for inline code
- `## Heading` for section headers

### Phase 3: Archaeologist (Review)

**Goal:** Review cleared rooms using spaced repetition.

Once every room is cleared, the Archaeologist phase unlocks. Review prompts are scheduled using the **SM-2 algorithm**:

- Rate your recall on a 0-5 scale
- Easy cards get longer intervals; hard cards repeat sooner
- Track your review streak and overdue count
- Self-check prompts help you verify knowledge retention

---

## Dungeon Mechanics

### Navigating the Dungeon

| Key | Action |
|-----|--------|
| **W/A/S/D** or Arrow keys | Move |
| **E** | Interact (enter room, talk to NPC, use portal) |
| **M** | Open dungeon map (click any room to teleport on the current floor) |
| **I** | Toggle room info panel |
| **H** | Return to village |
| **?** | Help overlay |

### Floors

- The root room lives on **Floor 1**
- Each direct child of the root becomes a separate floor (Floor 2, 3, 4...)
- Deeper subtopics stay on the same floor as their ancestor
- Portals (stairs up/down) connect between floors
- Press **E** on a portal room to change floors

### Biomes (Dungeon Themes)

Choose a biome when creating a subject, or change it anytime from the dungeon portal info panel in the village.

Nine biomes available: Knowledge Dungeon, Mathematics Caverns, Science Labs, History Ruins, Language Library, Deep Forest, Frozen Tundra, Crystal Caverns, Sunken Swamp.

Each biome has distinct floor tile patterns, wall colors, and corridor hues.

### Boss Encounters

Boss rooms appear every **5th floor** (floors 5, 10, 15...). Defeating a boss room grants:

- **2x–4x boosted XP**
- **Boosted quality bonus**
- **Guaranteed rare or epic loot**

Five unique boss types cycle as you progress deeper.

### Loot & Gear

Defeating rooms with high-quality notes earns loot. Loot includes:

- **Equippable items** - Weapons, armor, accessories. Equip from your inventory for stat bonuses
- **Rarity tiers** - Common, Rare, Epic (higher quality notes = better rarity)
- **Stat bonuses** - Quality bonus, XP multiplier, streak protection

### Room NPCs

Each room has a guide NPC. Walk up and press **E** to get tips and lore about the room's topic. The dialogue bubble follows the NPC as you move.

---

## Progression

### XP & Leveling

- Earn XP for clearing rooms, completing reviews, and defeating bosses
- Higher quality notes = more XP
- Boss rooms give multiplied XP

### Badges

Special achievements earned across subjects:
- **Scribe Century** - Write 120+ words in a single note
- Clear rooms, master subjects, collect artifacts, and more

### Achievements

Cross-subject meta-achievements track your overall progress:
- Subjects mastered
- Total notes written
- Total XP earned
- Rooms cleared
- Review sessions completed
- Artifacts collected
- Bosses defeated
- Badges earned

### Study Statistics

Access your stats from the village HUD. The dashboard shows:
- Total study time and sessions
- Rooms per session
- Retention trends
- Review streaks
- Per-subject breakdowns

---

## Data Management

### Import / Export

From the Welcome Screen's **Data** tab or the village's data management modal:

- **Export subject as JSON** - Full backup including notes and artifacts
- **Export as template** - Graph structure only (no notes/artifacts), reusable as a starting point
- **Import from JSON** - Restore a subject from a backup or template
- **Electron desktop** - Open subjects folder directly or export entire subjects root

### Tags

Tag rooms with keywords for cross-topic linking:

- Add tags in the Room Panel during Creator phase
- Tags create connections across rooms and subjects
- Use the tag navigation to find related rooms

All data persists to localStorage (web) or your local filesystem (Electron).

---

## Tips & Strategy

1. **Start with the tutorial** - It walks through all core mechanics in a 3-room dungeon
2. **Write thorough notes** - Include all three sections (Summary, Key Points, Recall Question) for maximum quality bonus and better loot
3. **Use the Format button** - Markdown formatting makes notes more readable and earns better clarity scores
4. **Attach images** - Visual aids improve recall question quality
5. **Check the Checks tab** - See exactly what criteria you're missing before submitting
6. **Change biomes** - If a dungeon feels stale, swap the theme from the village portal panel
7. **Review regularly** - The SM-2 algorithm spaces reviews optimally; don't let them pile up
8. **Tag rooms** - Tags help you find connections across subjects during review
9. **Boss floors reward preparation** - Save your best notes for floors 5, 10, 15... for maximum loot
