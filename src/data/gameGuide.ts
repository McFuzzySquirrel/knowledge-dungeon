/**
 * The in-app game guide. Source of truth: `docs/GAME-GUIDE.md`; keep the two in step.
 *
 * Why the Phase 3 section is selected here rather than written once.
 *
 * `VITE_ARCHAEOLOGIST_REVIEW_WORKSPACE` has `productionDefault: true` after the Phase 23
 * cutover, so the build that ships today renders the redesigned review panel. The flag-off
 * lane is the one-release rollback to the pre-Phase-16 panel: the note body and a "Done
 * reviewing" button, and nothing else. A manual is supposed to describe the app the reader is
 * actually running, so the guide is built in two lanes and the flag picks one at build time.
 *
 * Read from `@/config/featureFlags` once, at module scope, for the same reason and with the same
 * shape as `CREATOR_WORKSPACE_ENABLED` in `RoomPanel.tsx`: the flag is inlined at build time,
 * so the bundler drops the unused lane's bytes from a given artifact. A test can mock
 * `@/config/featureFlags` to choose. It is deliberately not a function argument - a manual has
 * one caller and no per-call variation.
 *
 * WHAT BELONGS TO WHICH LANE. The rest of the document is byte-identical in both lanes, and so
 * is the shape of this section: same `### Phase 3` heading, same **Goal:** line, same
 * `### The Three Phases` ordering. Only the sentences differ, and only where the code differs.
 *
 * - BOTH LANES, because the code is shared and flag-free. The unlock gate: a room must be
 *   cleared itself *and* every other room must be cleared (`canReviewRoom` asks
 *   `room-not-cleared` first, then `review-locked` at a ratio of 1). Pressing **E** opens the
 *   room for review and marks nothing (`roomInteract` opens the panel; it does not record).
 *   Closing the panel counts the pass at a rating of 3 (`closeInfoPanel` ->
 *   `finalizePendingReview` applies `CLOSED_WITHOUT_RATING_QUALITY` unconditionally, with no
 *   flag check on the route). The SM-2 schedule mechanics, in `spacedRepetition.ts`. The six
 *   Study Statistics rows, which `StudyStatsPanel.tsx` renders in both lanes because nothing
 *   gates that panel.
 * - FLAG-ON ONLY, because `ArchaeologistWorkspace` renders them and the rollback lane does not:
 *   the 0-5 rating control, "Save and finish later", "Pick this review back up", and the
 *   next-review-date and pass-progress display. The workspace states all four itself, in its
 *   `recall`, `standing`, and `schedule` regions - so the rollback lane's job is to *not
 *   contradict* them rather than to restate them.
 *
 * **Do not merge the two variants.** They are not a draft and a revision; they are the same
 * section made true twice, and collapsing them would reintroduce the bug this split exists to
 * prevent. `docs/GAME-GUIDE.md` should carry `ARCHAEOLOGIST_REVIEW_WORKSPACE_PHASE_3` and note
 * the flag-off variant beside it.
 */

import { runtimeConfig } from '@/config/featureFlags';

const ARCHAEOLOGIST_REVIEW_WORKSPACE_ENABLED = runtimeConfig.archaeologistReviewWorkspace;

/** Everything up to and including the Phase 3 goal line - identical in both lanes. */
const GUIDE_BEFORE_PHASE_3: string = "# Knowledge Dungeon - Game Guide\n\n## Overview\n\nKnowledge Dungeon is a local-first study dungeon-crawler. You build subjects as mindmaps of topic-rooms, then defeat each room's encounter by writing structured notes. Your progress earns XP, loot, badges, and cross-subject achievements.\n\nAll data lives on your device - no accounts, no cloud.\n\n---\n\n## Getting Started\n\n### First Launch\n\nWhen you open the app, you arrive at the **Welcome Screen**. From here you can:\n\n1. **Create a new subject** - Enter a subject name, root topic, and pick a Dungeon theme (biome). Click Create.\n2. **Continue to Village** - If subjects already exist, jump straight to the village.\n3. **Start the tutorial** - A guided 3-room dungeon that teaches notes, attachments, and navigation.\n\n### Player Setup\n\nBefore entering a dungeon, pick an **archetype** from the Player Setup tab:\n\n| Archetype | Perk |\n|-----------|------|\n| **Scholar** | Quality bonus on notes - higher loot rates |\n| **Cartographer** | Cross-link suggestions in the editor |\n| **Archivist** | Higher self-check cap during review phase |\n\n---\n\n## The Village Hub\n\nThe village is your home base. Walk around with **WASD** or arrow keys and press **E** to interact with buildings.\n\n### Village Buildings\n\n| Building | What it does |\n|----------|-------------|\n| **🌀 Dungeon Portals** | Enter a subject dungeon. Biome shows in the info panel - you can change it anytime. |\n| **🏛 Keeper's Tower** | Quest board with guided objectives. The Keeper NPC gives step-by-step advice. |\n| **🏰 Guild Hall** | Lists all your subjects. Create new subjects or enter existing ones. |\n| **⚔ Training Grounds** | Start the tutorial dungeon. |\n| **🏆 Trophy Hall** | View cross-subject stats - badges, inventory, collected notes, dungeons mastered. |\n| **📖 Library** | Game guide and controls reference (this document!). |\n| **📋 Quest Board** | Active quests with progress indicators. |\n| **🪧 Signposts** | Directional waypoints. The entrance signpost shows a welcome message. |\n\n### Creating a Subject from the Village\n\nOpen the Guild Hall (walk up + press E), then click **\"+ Create New Subject\"**. Or use the **\"+ Create New\"** button in the HUD sidebar. Fill in subject name, root topic, and dungeon theme.\n\n---\n\n## The Three Phases\n\nKnowledge Dungeon has three gameplay phases. You progress through them for each subject.\n\n### Phase 1: Creator\n\n**Goal:** Build your topic map by adding rooms.\n\n- Walk to any room and press **E** to open the Room Panel\n- Use the \"Add child topics\" textarea to create subtopic rooms\n- Each new line becomes a separate room. Commas also split topics\n- Rooms are linked as subtopics and form the dungeon layout\n- The root room (your subject's central topic) cannot be deleted\n- You can create rooms from ANY room - deeper nesting stays on the same floor\n\n**Tip:** Each direct child of the root topic becomes its own \"floor\" in the dungeon.\n\n### Phase 2: Scribe\n\n**Goal:** Clear every room by writing structured notes.\n\n- Walk through the dungeon (WASD/arrows), press **E** to enter a room\n- The Note Editor opens with three section tabs: **Summary**, **Key Points**, **Recall Question**\n- Use the **Format** toolbar button for markdown: bold, italic, code, links, images, lists, headings, quotes, horizontal rules\n- Click **Images** to upload and attach images to the room\n- Click **Checks** to see validation criteria (scored 0-2 per criterion)\n- Tick \"I confirm these notes are my own\" and click **Defeat Encounter** to clear the room\n- Quality bonus (0-10) determines loot rarity - thorough notes with all sections yield better rewards\n\n**Markdown tips:**\n- `**bold**` for emphasis\n- `[label](https://...)` for clickable links\n- `![alt](url)` for embedded images\n- `- ` for bullet lists\n- `` `code` `` for inline code\n- `## Heading` for section headers\n\n### Phase 3: Archaeologist (Review)\n\n**Goal:** Review cleared rooms using spaced repetition.\n\n";

/** Everything from the `---` that closes The Three Phases onward - identical in both lanes. */
const GUIDE_AFTER_PHASE_3: string = "\n\n---\n\n## Dungeon Mechanics\n\n### Navigating the Dungeon\n\n| Key | Action |\n|-----|--------|\n| **W/A/S/D** or Arrow keys | Move |\n| **E** | Interact (enter room, talk to NPC, use portal) |\n| **M** | Open dungeon map (click any room to teleport on the current floor) |\n| **I** | Toggle room info panel |\n| **H** | Return to village |\n| **?** | Help overlay |\n\n### Floors\n\n- The root room lives on **Floor 1**\n- Each direct child of the root becomes a separate floor (Floor 2, 3, 4...)\n- Deeper subtopics stay on the same floor as their ancestor\n- Portals (stairs up/down) connect between floors\n- Press **E** on a portal room to change floors\n\n### Biomes (Dungeon Themes)\n\nChoose a biome when creating a subject, or change it anytime from the dungeon portal info panel in the village.\n\nNine biomes available: Knowledge Dungeon, Mathematics Caverns, Science Labs, History Ruins, Language Library, Deep Forest, Frozen Tundra, Crystal Caverns, Sunken Swamp.\n\nEach biome has distinct floor tile patterns, wall colors, and corridor hues.\n\n### Boss Encounters\n\nBoss rooms appear every **5th floor** (floors 5, 10, 15...). Defeating a boss room grants:\n\n- **2x–4x boosted XP**\n- **Boosted quality bonus**\n- **Guaranteed rare or epic loot**\n\nFive unique boss types cycle as you progress deeper.\n\n### Loot & Gear\n\nDefeating rooms with high-quality notes earns loot. Loot includes:\n\n- **Equippable items** - Weapons, armor, accessories. Equip from your inventory for stat bonuses\n- **Rarity tiers** - Common, Rare, Epic (higher quality notes = better rarity)\n- **Stat bonuses** - Quality bonus, XP multiplier, streak protection\n\n### Room NPCs\n\nEach room has a guide NPC. Walk up and press **E** to get tips and lore about the room's topic. The dialogue bubble follows the NPC as you move.\n\n---\n\n## Progression\n\n### XP & Leveling\n\n- Earn XP for clearing rooms, completing reviews, and defeating bosses\n- Higher quality notes = more XP\n- Boss rooms give multiplied XP\n\n### Badges\n\nSpecial achievements earned across subjects:\n- **Scribe Century** - Write 120+ words in a single note\n- Clear rooms, master subjects, collect artifacts, and more\n\n### Achievements\n\nCross-subject meta-achievements track your overall progress:\n- Subjects mastered\n- Total notes written\n- Total XP earned\n- Rooms cleared\n- Review sessions completed\n- Artifacts collected\n- Bosses defeated\n- Badges earned\n\n### Study Statistics\n\nAccess your stats from the village HUD. The dashboard shows:\n- Total study time and sessions\n- Rooms per session\n- Retention trends\n- Review streaks\n- Per-subject breakdowns\n\n---\n\n## Data Management\n\n### Import / Export\n\nFrom the Welcome Screen's **Data** tab or the village's data management modal:\n\n- **Export subject as JSON** - Full backup including notes and artifacts\n- **Export as template** - Graph structure only (no notes/artifacts), reusable as a starting point\n- **Import from JSON** - Restore a subject from a backup or template\n- **Electron desktop** - Open subjects folder directly or export entire subjects root\n\n### Tags\n\nTag rooms with keywords for cross-topic linking:\n\n- Add tags in the Room Panel during Creator phase\n- Tags create connections across rooms and subjects\n- Use the tag navigation to find related rooms\n\nAll data persists to localStorage (web) or your local filesystem (Electron).\n\n---\n\n## Tips & Strategy\n\n1. **Start with the tutorial** - It walks through all core mechanics in a 3-room dungeon\n2. **Write thorough notes** - Include all three sections (Summary, Key Points, Recall Question) for maximum quality bonus and better loot\n3. **Use the Format button** - Markdown formatting makes notes more readable and earns better clarity scores\n4. **Attach images** - Visual aids improve recall question quality\n5. **Check the Checks tab** - See exactly what criteria you're missing before submitting\n6. **Change biomes** - If a dungeon feels stale, swap the theme from the village portal panel\n7. **Review regularly** - The SM-2 algorithm spaces reviews optimally; don't let them pile up\n8. **Tag rooms** - Tags help you find connections across subjects during review\n9. **Boss floors reward preparation** - Save your best notes for floors 5, 10, 15... for maximum loot\n";

/** Phase 3 with the Phase 16 review workspace rendered (`VITE_ARCHAEOLOGIST_REVIEW_WORKSPACE=true`). */
const ARCHAEOLOGIST_REVIEW_WORKSPACE_PHASE_3: string = "Reviewing a room needs two gates: that room's own encounter is cleared, and every other room in the dungeon is cleared too. Open a cleared room with **E**, read its artifact, answer its recall prompts out loud, and rate how well you recalled it. Each room's next review date is then scheduled with the **SM-2 algorithm**.\n\n- Pressing **E** opens the room for review and marks nothing; the pass is counted when you finish with the room panel\n- Rate your recall from 0 to 5, labelled from Forgot through Perfect\n- A rating below 3 resets the room to 1 day; 3 or higher gives 1 day, then 6 days, then multiplies by the room's own ease factor\n- Completing the review counts the pass at the rating you chose; closing the room panel counts it at a rating of 3 instead\n- If you have to leave part way through, **Save and finish later** keeps the review here, and the room offers to **Pick this review back up** the next time you open it\n- The panel shows this room's next review date, how far you are toward the next full pass, and whether the room is overdue\n- Study Statistics tracks reviewable rooms, rooms reviewed, full review passes, due today, overdue reviews, and average ease factor";

/**
 * Phase 3 with the pre-Phase-16 panel rendered - the one-release rollback lane
 * (`VITE_ARCHAEOLOGIST_REVIEW_WORKSPACE=false`), not the production default after the
 * Phase 23 cutover.
 *
 * The SM-2 bullet is stated as the schedule that `ratingOfPass` actually produces in this lane
 * rather than as the general rule. The general rule is the flag-on bullet above; here every pass
 * arrives at 3, so describing the below-3 branch would describe something no learner in this
 * build can reach.
 */
const LEGACY_REVIEW_PHASE_3: string = "Reviewing a room needs two gates: that room's own encounter is cleared, and every other room in the dungeon is cleared too. Press **E** in a cleared room to open the room panel for that room's review, then read its artifact and work through the self-check prompts out loud. Pressing **E** opens the panel and marks nothing - closing the panel is what counts the pass. Each room's next review date is then scheduled with the **SM-2 algorithm**.\n\n- The pass is recorded at a rating of 3, the \"correct with serious difficulty\" step of that schedule: 1 day, then 6 days, then multiplying by the room's own ease factor\n- Study Statistics tracks reviewable rooms, rooms reviewed, full review passes, due today, overdue reviews, and average ease factor";

export const GAME_GUIDE_MARKDOWN: string = [
  GUIDE_BEFORE_PHASE_3,
  ARCHAEOLOGIST_REVIEW_WORKSPACE_ENABLED
    ? ARCHAEOLOGIST_REVIEW_WORKSPACE_PHASE_3
    : LEGACY_REVIEW_PHASE_3,
  GUIDE_AFTER_PHASE_3,
].join('');
