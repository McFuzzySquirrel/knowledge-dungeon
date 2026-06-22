export interface VillageNpc {
  id: string;
  label: string;
  gridX: number;
  gridY: number;
  path?: { x: number; y: number }[];
  dialogue: string[];
  greeting: string;
  questDialogue?: Record<string, string[]>;
  quotes?: string[];
}

const LEARNING_QUOTES = [
  '"The mind is not a vessel to be filled but a fire to be kindled."',
  '"Knowledge is power. Information is liberating."',
  '"Study the past if you would define the future."',
  '"The beautiful thing about learning is that nobody can take it away from you."',
  '"An investment in knowledge pays the best interest."',
  '"The more that you read, the more things you will know."',
  '"Learning is a treasure that will follow its owner everywhere."',
  '"Tell me and I forget. Teach me and I remember. Involve me and I learn."',
  '"The capacity to learn is a gift; the ability to learn is a skill; the willingness to learn is a choice."',
  '"Knowledge is a journey, not a destination."',
  '"Curiosity is the wick in the candle of learning."',
  '"The expert in anything was once a beginner."',
];

export interface VillageStructure {
  id: string;
  type: 'portal-icon' | 'keeper-tower' | 'guild-hall' | 'training-gate' | 'fountain' | 'tree' | 'torch' | 'gate' | 'bench' | 'signpost' | 'waysign' | 'trophy-hall' | 'bush' | 'rock' | 'library' | 'pond' | 'flower' | 'workshop';
  label: string;
  gridX: number;
  gridY: number;
  width: number;
  height: number;
  subjectId?: string;
  subjectName?: string;
  roomCount?: number;
  clearedCount?: number;
}

export interface VillageMapDef {
  width: number;
  height: number;
  tileSize: number;
  structures: VillageStructure[];
  npcs: VillageNpc[];
  playerStart: { x: number; y: number };
  entranceTile: { x: number; y: number };
}

export const VILLAGE_TILE_SIZE = 48;

export const VILLAGE_MAP: VillageMapDef = {
  width: 36,
  height: 30,
  tileSize: VILLAGE_TILE_SIZE,
  playerStart: { x: 5, y: 27 },
  entranceTile: { x: 5, y: 28 },
  structures: [
    // ── Signposts at crossroads ───────────────────────
    {
      id: 'sign-entrance',
      type: 'waysign',
      label: '',
      gridX: 3, gridY: 24, width: 1, height: 1,
    },
    {
      id: 'sign-center',
      type: 'waysign',
      label: '',
      gridX: 15, gridY: 14, width: 1, height: 1,
    },
    {
      id: 'sign-library',
      type: 'waysign',
      label: '',
      gridX: 13, gridY: 8, width: 1, height: 1,
    },
    {
      id: 'sign-south',
      type: 'waysign',
      label: '',
      gridX: 17, gridY: 22, width: 1, height: 1,
    },
    {
      id: 'sign-east',
      type: 'waysign',
      label: '',
      gridX: 25, gridY: 14, width: 1, height: 1,
    },

    // ── Entrance ──────────────────────────────────────
    {
      id: 'village-gate',
      type: 'gate',
      label: '',
      gridX: 3, gridY: 27,
      width: 4, height: 2,
    },


    // ── Major buildings (spread out) ──────────────────
    {
      id: 'library',
      type: 'library',
      label: 'Library',
      gridX: 12, gridY: 3,
      width: 3, height: 3,
    },
    {
      id: 'keeper-tower',
      type: 'keeper-tower',
      label: "Keeper's Tower",
      gridX: 16, gridY: 3,
      width: 3, height: 3,
    },
    {
      id: 'training-gate',
      type: 'training-gate',
      label: 'Training Grounds',
      gridX: 4, gridY: 5,
      width: 3, height: 3,
    },
    {
      id: 'guild-hall',
      type: 'guild-hall',
      label: 'Guild Hall',
      gridX: 30, gridY: 10,
      width: 3, height: 3,
    },
    {
      id: 'trophy-hall',
      type: 'trophy-hall',
      label: 'Trophy Hall',
      gridX: 30, gridY: 24,
      width: 3, height: 3,
    },
    {
      id: 'artisan-workshop',
      type: 'workshop',
      label: 'Artisan Workshop',
      gridX: 26, gridY: 3,
      width: 3, height: 3,
    },

    // ── Central feature ───────────────────────────────
    {
      id: 'central-fountain',
      type: 'fountain',
      label: 'Central Fountain',
      gridX: 17, gridY: 16,
      width: 2, height: 2,
    },

    // ── Corner trees (20 total, filling empty areas) ──
    { id: 't-00', type: 'tree', label: '', gridX: 0,  gridY: 1,  width: 1, height: 1 },
    { id: 't-01', type: 'tree', label: '', gridX: 0,  gridY: 10, width: 1, height: 1 },
    { id: 't-02', type: 'tree', label: '', gridX: 0,  gridY: 22, width: 1, height: 1 },
    { id: 't-03', type: 'tree', label: '', gridX: 2,  gridY: 14, width: 1, height: 1 },
    { id: 't-04', type: 'tree', label: '', gridX: 7,  gridY: 2,  width: 1, height: 1 },
    { id: 't-05', type: 'tree', label: '', gridX: 9,  gridY: 11, width: 1, height: 1 },
    { id: 't-06', type: 'tree', label: '', gridX: 11, gridY: 3,  width: 1, height: 1 },
    { id: 't-07', type: 'tree', label: '', gridX: 13, gridY: 9,  width: 1, height: 1 },
    { id: 't-08', type: 'tree', label: '', gridX: 14, gridY: 1,  width: 1, height: 1 },
    { id: 't-09', type: 'tree', label: '', gridX: 14, gridY: 27, width: 1, height: 1 },
    { id: 't-10', type: 'tree', label: '', gridX: 20, gridY: 2,  width: 1, height: 1 },
    { id: 't-11', type: 'tree', label: '', gridX: 22, gridY: 27, width: 1, height: 1 },
    { id: 't-12', type: 'tree', label: '', gridX: 25, gridY: 1,  width: 1, height: 1 },
    { id: 't-13', type: 'tree', label: '', gridX: 27, gridY: 6,  width: 1, height: 1 },
    { id: 't-14', type: 'tree', label: '', gridX: 28, gridY: 16, width: 1, height: 1 },
    { id: 't-15', type: 'tree', label: '', gridX: 28, gridY: 21, width: 1, height: 1 },
    { id: 't-16', type: 'tree', label: '', gridX: 33, gridY: 0,  width: 1, height: 1 },
    { id: 't-17', type: 'tree', label: '', gridX: 34, gridY: 14, width: 1, height: 1 },
    { id: 't-18', type: 'tree', label: '', gridX: 34, gridY: 27, width: 1, height: 1 },
    { id: 't-19', type: 'tree', label: '', gridX: 35, gridY: 5,  width: 1, height: 1 },

    // ── Scattered bushes ──────────────────────────────
    { id: 'b-0', type: 'bush', label: '', gridX: 2,  gridY: 17, width: 1, height: 1 },
    { id: 'b-1', type: 'bush', label: '', gridX: 9,  gridY: 5,  width: 1, height: 1 },
    { id: 'b-2', type: 'bush', label: '', gridX: 12, gridY: 22, width: 1, height: 1 },
    { id: 'b-3', type: 'bush', label: '', gridX: 18, gridY: 6,  width: 1, height: 1 },
    { id: 'b-4', type: 'bush', label: '', gridX: 22, gridY: 10, width: 1, height: 1 },
    { id: 'b-5', type: 'bush', label: '', gridX: 26, gridY: 19, width: 1, height: 1 },
    { id: 'b-6', type: 'bush', label: '', gridX: 32, gridY: 17, width: 1, height: 1 },

    // ── Small rocks near fountain ─────────────────────
    { id: 'r-0', type: 'rock', label: '', gridX: 15, gridY: 14, width: 1, height: 1 },
    { id: 'r-1', type: 'rock', label: '', gridX: 20, gridY: 18, width: 1, height: 1 },

    // ── Ponds ─────────────────────────────────────────
    { id: 'pond-0', type: 'pond', label: '', gridX: 0,  gridY: 13, width: 2, height: 1 },
    { id: 'pond-1', type: 'pond', label: '', gridX: 34, gridY: 9,  width: 2, height: 1 },
    { id: 'pond-2', type: 'pond', label: '', gridX: 10, gridY: 27, width: 2, height: 1 },

    // ── Flowers near entrance ─────────────────────────
    { id: 'fl-0', type: 'flower', label: '', gridX: 2,  gridY: 24, width: 1, height: 1 },
    { id: 'fl-1', type: 'flower', label: '', gridX: 7,  gridY: 24, width: 1, height: 1 },
    { id: 'fl-2', type: 'flower', label: '', gridX: 3,  gridY: 26, width: 1, height: 1 },
    { id: 'fl-3', type: 'flower', label: '', gridX: 6,  gridY: 23, width: 1, height: 1 },
    { id: 'fl-4', type: 'flower', label: '', gridX: 5,  gridY: 20, width: 1, height: 1 },

    // ── Torches along paths ───────────────────────────
    { id: 'torch-1', type: 'torch', label: '', gridX: 8,  gridY: 20, width: 1, height: 1 },
    { id: 'torch-2', type: 'torch', label: '', gridX: 24, gridY: 20, width: 1, height: 1 },
    { id: 'torch-3', type: 'torch', label: '', gridX: 8,  gridY: 12, width: 1, height: 1 },
    { id: 'torch-4', type: 'torch', label: '', gridX: 24, gridY: 12, width: 1, height: 1 },
    { id: 'torch-5', type: 'torch', label: '', gridX: 16, gridY: 5,  width: 1, height: 1 },

    // ── Benches ──────────────────────────────────────
    { id: 'bench-1', type: 'bench', label: '', gridX: 12, gridY: 20, width: 2, height: 1 },
    { id: 'bench-2', type: 'bench', label: '', gridX: 22, gridY: 14, width: 2, height: 1 },
  ],
  npcs: [
    {
      id: 'villager-1',
      gridX: 8, gridY: 18,
      label: 'Wandering Scholar',
      path: [
        { x: 3, y: 8 }, { x: 3, y: 16 }, { x: 8, y: 20 },
        { x: 16, y: 20 }, { x: 16, y: 14 }, { x: 10, y: 12 }, { x: 6, y: 8 },
      ],
      greeting: 'Ah, a fellow seeker of knowledge!',
      dialogue: ['Every question is a key to a new door.', 'The joy of learning is in the journey, not the destination.'],
      quotes: LEARNING_QUOTES,
    },
    {
      id: 'villager-2',
      gridX: 22, gridY: 16,
      label: 'Thoughtful Traveler',
      path: [
        { x: 18, y: 17 }, { x: 24, y: 17 }, { x: 26, y: 14 },
        { x: 30, y: 14 }, { x: 30, y: 11 }, { x: 26, y: 14 },
        { x: 24, y: 14 }, { x: 20, y: 14 },
      ],
      greeting: 'Greetings! Care for a thought?',
      dialogue: ['Wisdom comes from many places.', 'Sometimes the smallest discoveries lead to the greatest understanding.'],
      quotes: LEARNING_QUOTES,
    },
    {
      id: 'villager-3',
      gridX: 30, gridY: 22,
      label: 'Curious Apprentice',
      path: [
        { x: 25, y: 23 }, { x: 30, y: 23 }, { x: 34, y: 24 },
        { x: 34, y: 18 }, { x: 30, y: 18 }, { x: 25, y: 18 },
      ],
      greeting: 'Hello! Have you discovered something new today?',
      dialogue: ['I spend my days reading in the library.', 'Every book holds a secret waiting to be uncovered.'],
      quotes: LEARNING_QUOTES,
    },
    {
      id: 'villager-4',
      gridX: 28, gridY: 8,
      label: 'Elder Sage',
      path: [
        { x: 25, y: 5 }, { x: 20, y: 5 }, { x: 16, y: 5 },
        { x: 16, y: 8 }, { x: 20, y: 8 }, { x: 25, y: 8 },
      ],
      greeting: 'Patience, young scholar. Knowledge ripens with time.',
      dialogue: ['I have walked these paths for many years.', 'The greatest lessons are often the simplest.'],
      quotes: LEARNING_QUOTES,
    },
    {
      id: 'villager-5',
      gridX: 14, gridY: 22,
      label: 'Ink-Stained Scribe',
      path: [
        { x: 12, y: 24 }, { x: 16, y: 24 }, { x: 18, y: 17 },
        { x: 16, y: 14 }, { x: 12, y: 14 }, { x: 10, y: 17 },
      ],
      greeting: 'A fresh page awaits your thoughts!',
      dialogue: ['I have filled many scrolls with notes.', 'The pen is mightier than the sword - and the keyboard mightier still.'],
      quotes: LEARNING_QUOTES,
    },
    {
      id: 'keeper',
      label: 'Keeper of Knowledge',
      gridX: 17, gridY: 5,
      path: [
        { x: 14, y: 8 },
        { x: 20, y: 8 },
        { x: 20, y: 3 },
        { x: 14, y: 3 },
      ],
      greeting: 'Welcome, seeker! I am the Keeper of Knowledge, guardian of this village.',
      dialogue: [
        "This village is your sanctuary. Every portal you see leads to a dungeon of knowledge - a subject you've created, waiting to be explored.",
        "The path of knowledge has three phases: Create your map, Scribe your notes, and Review your artifacts.",
        "To begin, visit the Guild Hall to create your first subject, or head to the Training Grounds if you'd like a guided introduction.",
        "In the Creator phase, you build rooms and connect ideas. In the Scribe phase, you defeat encounters by writing structured notes. In the Archaeologist phase, you return to strengthen your recall.",
        "The more rooms you clear and review, the more XP you earn. Ranks and badges await those who persevere.",
      ],
      questDialogue: {
        'intro': ['Ah, a fresh face! Welcome to the Dungeon Village. I am the Keeper of Knowledge. Come closer and I shall guide you.', 'Every great journey begins with a single step. Your first step is to create a subject - a topic you wish to study.', 'Head to the Guild Hall (the building to the east) or press E while near me to learn more.'],
        'meet-keeper': ['You found me! Well done. Now, let me show you around.', 'See the portals scattered around the village? Each one leads to a dungeon - but you need a subject first.', 'Visit the Guild Hall to create your first subject. It\'s the large building with the lanterns.' ],
        'create-subject': ['You\'ve created your first subject! Excellent.', 'Now you need to choose a study archetype - your class. Check the panel on the right side of the screen.', 'Each archetype has a unique perk. The Scholar is balanced, the Cartographer excels at mapping, and the Archivist loves revisiting old material.'],
        'visit-training': ['The Training Grounds await! Step through the gate to begin a guided 3-room tutorial.', 'You\'ll learn how to write notes, attach images, navigate the dungeon, and clear encounters.', 'Follow the on-screen instructions carefully. I\'ll be here when you return.'],
        'pick-archetype': ['An excellent choice of archetype! Your class will shape how you approach each dungeon.', 'Now, approach one of the dungeon portals and press E to enter your first dungeon.', 'Don\'t be shy - step through and begin your adventure!'],
        'enter-dungeon': ['You\'ve entered a dungeon! Each room is a topic to master.', 'In Scribe mode, press E in a room to open the encounter editor. Write a structured note with a Summary, Key Points, and a Recall Question.', 'Pass the validation checks to earn an artifact and clear the room.'],
        'clear-room': ['You cleared a room! Well fought, scholar.', 'Your artifact has been collected. You can view it in your journal.', 'Keep going - clear more rooms to earn XP and unlock badges.'],
        'write-note': ['Your notes are the weapons of this dungeon. The sharper they are, the easier your encounters will be.', 'Remember: each note needs a Summary (big picture), Key Points (specifics), and a Recall Question (self-test).', 'You can also attach images to your notes for richer artifacts.'],
        'review-artifact': ['You\'ve entered the Archaeologist phase. Return to cleared rooms and run review passes.', 'Each review pass strengthens your memory and increases your review streak.', 'Complete enough passes and you\'ll earn Archaeologist badges.'],
        'complete': ['You\'ve learned the ways of the Knowledge Dungeon. The rest is up to you.', 'Remember: every subject is a dungeon, every room is a topic, and every note is a step toward mastery.', 'The portals will always be here. I will always be here. Go forth and learn!'],
      },
    },
  ],
};

export function getDungeonPortalSlots(): { gridX: number; gridY: number }[] {
  return [
    { gridX: 3,  gridY: 3  },   // NW - near training gate
    { gridX: 7,  gridY: 18 },   // W - south of central path
    { gridX: 12, gridY: 25 },   // SW - near bottom edge
    { gridX: 23, gridY: 23 },   // SE - near trophy hall
    { gridX: 25, gridY: 5  },   // NE - near guild hall
    { gridX: 30, gridY: 15 },   // E - between guild hall and trophy hall
  ];
}
