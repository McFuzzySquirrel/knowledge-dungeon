/**
 * Phase 1A renderer-neutral web support matrix.
 *
 * This module is the single machine-readable source for approved web support
 * dimensions. It is imported by `playwright.config.ts`, so a Playwright project
 * cannot drift from the documented matrix, and by the compatibility suite, which
 * records the observed environment against these declarations.
 *
 * The dimensions are deliberately separate:
 *
 * - `hostOperatingSystems`: hosts that have an approved automated lane.
 * - `engine`: the browser engine under test (Chromium, Firefox, WebKit).
 * - `channel`: how the browser binary is obtained. `playwright-bundled` is the
 *   engine build Playwright ships; `microsoft-edge-stable` is a branded browser
 *   channel. A bundled WebKit build is WebKit evidence, never a Safari release
 *   claim, and an Edge channel run is branded-browser evidence rather than a
 *   claim about every Chromium build.
 * - `formFactor`, `viewport`, `deviceScaleFactor`, `inputMode`: emulated
 *   form-factor evidence only. Viewport and touch emulation is never physical
 *   device or operating-system certification.
 * - `evidenceClass`: how strong the recorded evidence is.
 * - `ciLanes`: the staged CI lanes allowed to execute the lane.
 *
 * Nothing in this file may contain learner data, credentials, request headers,
 * queries, fragments, request bodies, or private URLs.
 */

export const SUPPORT_MATRIX_SCHEMA_VERSION = 1;

export const HOST_OPERATING_SYSTEMS = ['linux', 'macos', 'windows'] as const;
export type HostOperatingSystem = (typeof HOST_OPERATING_SYSTEMS)[number];

export const BROWSER_ENGINES = ['chromium', 'firefox', 'webkit'] as const;
export type BrowserEngine = (typeof BROWSER_ENGINES)[number];

export const BROWSER_CHANNELS = ['playwright-bundled', 'microsoft-edge-stable'] as const;
export type BrowserChannel = (typeof BROWSER_CHANNELS)[number];

export const BROWSER_INSTALL_TARGETS = ['chromium', 'firefox', 'webkit', 'msedge'] as const;
export type BrowserInstallTarget = (typeof BROWSER_INSTALL_TARGETS)[number];

export const FORM_FACTORS = ['desktop', 'chromebook', 'tablet-portrait', 'tablet-landscape'] as const;
export type FormFactor = (typeof FORM_FACTORS)[number];

export const INPUT_MODES = ['pointer-keyboard', 'touch-emulated'] as const;
export type InputMode = (typeof INPUT_MODES)[number];

export const EVIDENCE_CLASSES = [
  'emulated-viewport',
  'engine-automation',
  'branded-channel-automation',
  'physical-device-manual',
] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

export const CI_LANES = ['pull-request', 'scheduled-release'] as const;
export type CiLane = (typeof CI_LANES)[number];

export const SUITES = ['phase-1-current-build', 'cross-engine-compatibility'] as const;
export type SuiteId = (typeof SUITES)[number];

/** Renderer modes the compatibility suite can observe. Phase 1A expects Phaser. */
export const RENDERER_MODES = ['phaser', 'pixi', 'unknown'] as const;
export type RendererMode = (typeof RENDERER_MODES)[number];

export interface SupportMatrixEntry {
  /** Playwright project name. Must be unique across the matrix. */
  readonly project: string;
  /** Which suite owns the project. */
  readonly suite: SuiteId;
  /** Hosts with an approved automated lane for this project. */
  readonly hostOperatingSystems: readonly HostOperatingSystem[];
  readonly engine: BrowserEngine;
  readonly channel: BrowserChannel;
  /** Playwright `channel` option; only branded channels set this. */
  readonly channelOption?: 'msedge';
  readonly formFactor: FormFactor;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
  readonly inputMode: InputMode;
  readonly hasTouch: boolean;
  readonly isMobileEmulation: boolean;
  readonly evidenceClass: EvidenceClass;
  readonly ciLanes: readonly CiLane[];
  /** Current GitHub-hosted runner labels approved for this project. */
  readonly runnerLabels: readonly string[];
  readonly installTargets: readonly BrowserInstallTarget[];
  /** Renderer the recorded production artifact is expected to mount. */
  readonly expectedRendererMode: 'phaser' | 'pixi';
  /** Bounded statement this evidence supports. */
  readonly claim: string;
  /** Explicit statements this evidence does not support. */
  readonly doesNotProve: readonly string[];
}

const PHASER_DEFAULT = 'phaser' as const;

const EMULATION_LIMITATIONS = [
  'Not a physical device, ChromeOS, or operating-system version certification.',
  'Not a certificate for every distribution, browser patch, GPU, or assistive technology.',
] as const;

/**
 * The approved staged web matrix.
 *
 * The first four projects are the verified Phase 1 current-build Phaser/axe/
 * privacy viewport matrix and must keep their existing names, viewports, device
 * scale factors, and touch settings. The `compat-*` projects are the bounded
 * Phase 1A cross-engine production-artifact lanes.
 */
export const SUPPORT_MATRIX: readonly SupportMatrixEntry[] = Object.freeze([
  {
    project: 'desktop-chromium',
    suite: 'phase-1-current-build',
    hostOperatingSystems: ['linux'],
    engine: 'chromium',
    channel: 'playwright-bundled',
    formFactor: 'desktop',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    inputMode: 'pointer-keyboard',
    hasTouch: false,
    isMobileEmulation: false,
    evidenceClass: 'emulated-viewport',
    ciLanes: ['pull-request'],
    runnerLabels: ['ubuntu-latest'],
    installTargets: ['chromium'],
    expectedRendererMode: PHASER_DEFAULT,
    claim:
      'Current production build passes the Phase 1 Phaser, axe, and privacy smoke suite in a desktop Chromium viewport.',
    doesNotProve: [
      ...EMULATION_LIMITATIONS,
      'Not Firefox, WebKit, Edge, macOS, or Windows evidence.',
      'Not a cross-engine result; the cross-engine lanes are the compat-* projects.',
    ],
  },
  {
    project: 'chromebook',
    suite: 'phase-1-current-build',
    hostOperatingSystems: ['linux'],
    engine: 'chromium',
    channel: 'playwright-bundled',
    formFactor: 'chromebook',
    viewport: { width: 1366, height: 768 },
    deviceScaleFactor: 1,
    inputMode: 'pointer-keyboard',
    hasTouch: false,
    isMobileEmulation: false,
    evidenceClass: 'emulated-viewport',
    ciLanes: ['pull-request'],
    runnerLabels: ['ubuntu-latest'],
    installTargets: ['chromium'],
    expectedRendererMode: PHASER_DEFAULT,
    claim:
      'Current production build passes the Phase 1 smoke suite in a 1366x768 emulated viewport commonly used by Chromebook-class displays.',
    doesNotProve: [
      ...EMULATION_LIMITATIONS,
      'Not a physical Chromebook or ChromeVox check; those remain a later manual gate.',
    ],
  },
  {
    project: 'tablet',
    suite: 'phase-1-current-build',
    hostOperatingSystems: ['linux'],
    engine: 'chromium',
    channel: 'playwright-bundled',
    formFactor: 'tablet-portrait',
    viewport: { width: 834, height: 1112 },
    deviceScaleFactor: 1,
    inputMode: 'touch-emulated',
    hasTouch: true,
    isMobileEmulation: true,
    evidenceClass: 'emulated-viewport',
    ciLanes: ['pull-request'],
    runnerLabels: ['ubuntu-latest'],
    installTargets: ['chromium'],
    expectedRendererMode: PHASER_DEFAULT,
    claim:
      'Current production build passes the Phase 1 smoke suite in an emulated tablet-portrait viewport with emulated touch input.',
    doesNotProve: [
      ...EMULATION_LIMITATIONS,
      'Not a physical tablet, iPad, Android, or touch screen-reader check.',
    ],
  },
  {
    project: 'tablet-landscape',
    suite: 'phase-1-current-build',
    hostOperatingSystems: ['linux'],
    engine: 'chromium',
    channel: 'playwright-bundled',
    formFactor: 'tablet-landscape',
    viewport: { width: 1112, height: 834 },
    deviceScaleFactor: 1,
    inputMode: 'touch-emulated',
    hasTouch: true,
    isMobileEmulation: true,
    evidenceClass: 'emulated-viewport',
    ciLanes: ['pull-request'],
    runnerLabels: ['ubuntu-latest'],
    installTargets: ['chromium'],
    expectedRendererMode: PHASER_DEFAULT,
    claim:
      'Current production build passes the Phase 1 smoke suite in an emulated tablet-landscape viewport with emulated touch input.',
    doesNotProve: [
      ...EMULATION_LIMITATIONS,
      'Not a physical tablet, iPad, Android, or touch screen-reader check.',
    ],
  },
  {
    project: 'compat-chromium',
    suite: 'cross-engine-compatibility',
    hostOperatingSystems: ['linux', 'macos', 'windows'],
    engine: 'chromium',
    channel: 'playwright-bundled',
    formFactor: 'desktop',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    inputMode: 'pointer-keyboard',
    hasTouch: false,
    isMobileEmulation: false,
    evidenceClass: 'engine-automation',
    ciLanes: ['pull-request', 'scheduled-release'],
    runnerLabels: ['ubuntu-latest', 'macos-latest', 'windows-latest'],
    installTargets: ['chromium'],
    expectedRendererMode: PHASER_DEFAULT,
    claim:
      'The single recorded production web artifact loads and runs the synthetic core flow in the Playwright-bundled Chromium engine on the recorded host.',
    doesNotProve: [
      ...EMULATION_LIMITATIONS,
      'Not branded Chrome, Edge, or Safari evidence.',
      'Not a graphics-driver, GPU, or high-refresh rendering certification.',
    ],
  },
  {
    project: 'compat-firefox',
    suite: 'cross-engine-compatibility',
    hostOperatingSystems: ['linux', 'macos', 'windows'],
    engine: 'firefox',
    channel: 'playwright-bundled',
    formFactor: 'desktop',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    inputMode: 'pointer-keyboard',
    hasTouch: false,
    isMobileEmulation: false,
    evidenceClass: 'engine-automation',
    ciLanes: ['pull-request', 'scheduled-release'],
    runnerLabels: ['ubuntu-latest', 'macos-latest', 'windows-latest'],
    installTargets: ['firefox'],
    expectedRendererMode: PHASER_DEFAULT,
    claim:
      'The single recorded production web artifact loads and runs the synthetic core flow in the Playwright-bundled Firefox engine on the recorded host.',
    doesNotProve: [
      ...EMULATION_LIMITATIONS,
      'Not branded Firefox release or extension-profile evidence.',
    ],
  },
  {
    project: 'compat-webkit',
    suite: 'cross-engine-compatibility',
    hostOperatingSystems: ['macos'],
    engine: 'webkit',
    channel: 'playwright-bundled',
    formFactor: 'desktop',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    inputMode: 'pointer-keyboard',
    hasTouch: false,
    isMobileEmulation: false,
    evidenceClass: 'engine-automation',
    ciLanes: ['pull-request', 'scheduled-release'],
    runnerLabels: ['macos-latest'],
    installTargets: ['webkit'],
    expectedRendererMode: PHASER_DEFAULT,
    claim:
      'The single recorded production web artifact loads and runs the synthetic core flow in the Playwright-bundled WebKit engine on a macOS runner.',
    doesNotProve: [
      ...EMULATION_LIMITATIONS,
      'WebKit engine evidence only; this is not a Safari version, iOS, or App Store certification claim.',
      'A Playwright WebKit build is not the Safari that ships with a specific macOS or iOS release.',
    ],
  },
  {
    project: 'compat-edge',
    suite: 'cross-engine-compatibility',
    hostOperatingSystems: ['windows'],
    engine: 'chromium',
    channel: 'microsoft-edge-stable',
    channelOption: 'msedge',
    formFactor: 'desktop',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    inputMode: 'pointer-keyboard',
    hasTouch: false,
    isMobileEmulation: false,
    evidenceClass: 'branded-channel-automation',
    ciLanes: ['pull-request', 'scheduled-release'],
    runnerLabels: ['windows-latest'],
    installTargets: ['msedge'],
    expectedRendererMode: PHASER_DEFAULT,
    claim:
      'The single recorded production web artifact loads and runs the synthetic core flow in the installed Microsoft Edge stable channel on a Windows runner.',
    doesNotProve: [
      ...EMULATION_LIMITATIONS,
      'Not evidence for other Edge channels, Edge on other hosts, or every Chromium-based browser.',
    ],
  },
] satisfies readonly SupportMatrixEntry[]);

/** Project names that must keep running the Phase 1 current-build suite. */
export const PHASE_1_CURRENT_BUILD_PROJECTS = Object.freeze([
  'desktop-chromium',
  'chromebook',
  'tablet',
  'tablet-landscape',
] as const);

export type Phase1CurrentBuildProject = (typeof PHASE_1_CURRENT_BUILD_PROJECTS)[number];

/** Project names owned by the Phase 1A cross-engine compatibility suite. */
export const COMPATIBILITY_PROJECTS = Object.freeze([
  'compat-chromium',
  'compat-firefox',
  'compat-webkit',
  'compat-edge',
] as const);

export type CompatibilityProject = (typeof COMPATIBILITY_PROJECTS)[number];

export const CURRENT_BUILD_TEST_FILE = 'currentBuild.spec.ts';
export const COMPATIBILITY_TEST_FILE = 'compatibility.spec.ts';

export interface PhysicalDeviceGate {
  readonly id: string;
  readonly requirement: string;
  readonly targetPhase: string;
  /** Manual checks are never satisfied by viewport, engine, or channel lanes. */
  readonly automated: false;
  readonly reason: string;
}

/**
 * Physical-device gates. Phase 1A defines them; Phase 21 (accessibility and
 * responsive audit) and Phase 23 (cutover) must complete them before any
 * device, touch, or screen-reader support claim is made.
 */
export const PHYSICAL_DEVICE_GATES: readonly PhysicalDeviceGate[] = Object.freeze([
  {
    id: 'physical-chromebook-screen-reader',
    requirement:
      'One physical Chromebook completes Welcome to Village to Dungeon and back with ChromeVox enabled.',
    targetPhase: 'Phase 21',
    automated: false,
    reason: 'Chromium viewport emulation cannot prove ChromeVox output or ChromeOS hardware behavior.',
  },
  {
    id: 'physical-macos-safari',
    requirement:
      'One physical macOS Safari check completes the same core flow on the released production artifact.',
    targetPhase: 'Phase 21',
    automated: false,
    reason: 'Playwright WebKit is engine evidence, not a Safari release or macOS version claim.',
  },
  {
    id: 'physical-touch-platform-screen-reader',
    requirement:
      'One physical iPad or Android tablet completes a core learning action with a screen reader active.',
    targetPhase: 'Phase 21',
    automated: false,
    reason: 'Emulated touch does not prove mobile browser accessibility or touch-target behavior on real hardware.',
  },
  {
    id: 'physical-windows-desktop-browser',
    requirement:
      'One physical Windows desktop browser completes the core flow, including a file-picker or download action where the flow requires one.',
    targetPhase: 'Phase 21',
    automated: false,
    reason: 'A Windows runner verifies the recorded artifact but not a user-installed desktop browser profile.',
  },
  {
    id: 'physical-linux-desktop-browser',
    requirement:
      'One physical Linux desktop browser completes the core flow on a distribution the maintainer supports.',
    targetPhase: 'Phase 21',
    automated: false,
    reason: 'A Linux runner is not a per-distribution desktop certification.',
  },
]);

/**
 * Claim boundary recorded with every automated compatibility result. These are
 * the statements the Phase 1A lanes never support on their own.
 */
export const SUPPORT_CLAIM_BOUNDARY: readonly string[] = Object.freeze([
  'Automated lanes cover the recorded production web artifact only; they do not certify every operating-system version, distribution, device, or browser patch.',
  'Viewport and touch emulation is form-factor evidence, not physical-device, ChromeOS, or operating-system certification.',
  'Playwright WebKit lanes are WebKit engine evidence, not Safari release or iOS certification.',
  'Edge channel lanes are branded-browser evidence for the installed Edge channel on the recorded Windows host only.',
  'A passing compatibility lane is not an accessibility, performance, offline, or data-product certification.',
  'Electron installers, signing, and desktop packaging remain deferred and are not part of this web evidence.',
]);

const TOUCH_FORM_FACTORS: readonly FormFactor[] = ['tablet-portrait', 'tablet-landscape'];

export function isCompatibilityProject(project: string): project is CompatibilityProject {
  return (COMPATIBILITY_PROJECTS as readonly string[]).includes(project);
}

export function isPhase1CurrentBuildProject(project: string): project is Phase1CurrentBuildProject {
  return (PHASE_1_CURRENT_BUILD_PROJECTS as readonly string[]).includes(project);
}

export function supportEntryForProject(project: string): SupportMatrixEntry {
  const entry = SUPPORT_MATRIX.find((candidate) => candidate.project === project);
  if (!entry) {
    // Project names come from configuration, never from user input. Throwing
    // keeps an undeclared project from silently producing unqualified evidence.
    throw new Error(`Unknown support-matrix project: ${project}`);
  }
  return entry;
}

export function compatibilityEntries(): readonly SupportMatrixEntry[] {
  return SUPPORT_MATRIX.filter((entry) => entry.suite === 'cross-engine-compatibility');
}

/**
 * Structural rules for the matrix. Returns human-readable problems so the
 * compatibility suite and unit checks fail loudly instead of recording an
 * unqualified or contradictory support claim.
 */
export function validateSupportMatrix(
  matrix: readonly SupportMatrixEntry[] = SUPPORT_MATRIX,
): readonly string[] {
  const problems: string[] = [];
  const seenProjects = new Set<string>();

  for (const entry of matrix) {
    const label = entry.project || '<unnamed>';

    if (!/^[a-z0-9-]+$/.test(entry.project)) {
      problems.push(`${label}: project names must be lowercase kebab-case.`);
    }
    if (seenProjects.has(entry.project)) {
      problems.push(`${label}: duplicate project name in the support matrix.`);
    }
    seenProjects.add(entry.project);

    if (entry.hostOperatingSystems.length === 0) {
      problems.push(`${label}: at least one approved host operating system is required.`);
    }
    for (const host of entry.hostOperatingSystems) {
      if (!HOST_OPERATING_SYSTEMS.includes(host)) {
        problems.push(`${label}: unknown host operating system "${host}".`);
      }
    }

    if (entry.channel === 'microsoft-edge-stable') {
      if (entry.engine !== 'chromium') {
        problems.push(`${label}: the Microsoft Edge channel must be recorded as the chromium engine.`);
      }
      if (entry.channelOption !== 'msedge') {
        problems.push(`${label}: the Microsoft Edge channel must set the msedge Playwright channel.`);
      }
      if (!entry.installTargets.includes('msedge')) {
        problems.push(`${label}: the Microsoft Edge channel must install the msedge browser.`);
      }
      if (entry.evidenceClass !== 'branded-channel-automation') {
        problems.push(`${label}: the Microsoft Edge channel must be branded-channel evidence.`);
      }
    } else {
      if (entry.channelOption !== undefined) {
        problems.push(`${label}: a Playwright-bundled engine must not set a branded channel option.`);
      }
      if (
        entry.evidenceClass !== 'emulated-viewport' &&
        entry.evidenceClass !== 'engine-automation'
      ) {
        problems.push(
          `${label}: a Playwright-bundled engine must be emulated-viewport or engine-automation evidence.`,
        );
      }
      if (!entry.installTargets.includes(entry.engine)) {
        problems.push(`${label}: install targets must include the "${entry.engine}" engine build.`);
      }
    }

    if (entry.evidenceClass === 'physical-device-manual') {
      problems.push(
        `${label}: physical-device evidence is manual and must not be declared as a Playwright project.`,
      );
    }

    if (TOUCH_FORM_FACTORS.includes(entry.formFactor) !== entry.hasTouch) {
      problems.push(`${label}: tablet form factors must enable emulated touch input.`);
    }
    if (TOUCH_FORM_FACTORS.includes(entry.formFactor) && entry.inputMode !== 'touch-emulated') {
      problems.push(`${label}: tablet form factors must record touch-emulated input.`);
    }
    if (!TOUCH_FORM_FACTORS.includes(entry.formFactor) && entry.inputMode === 'touch-emulated') {
      problems.push(`${label}: only tablet form factors may declare touch-emulated input.`);
    }
    if (entry.isMobileEmulation && entry.engine !== 'chromium') {
      problems.push(`${label}: mobile emulation is only supported by the chromium engine.`);
    }

    if (entry.viewport.width <= 0 || entry.viewport.height <= 0) {
      problems.push(`${label}: viewport dimensions must be positive.`);
    }
    if (entry.deviceScaleFactor <= 0) {
      problems.push(`${label}: the device scale factor must be positive.`);
    }

    if (entry.ciLanes.length === 0) {
      problems.push(`${label}: at least one allowed CI lane is required.`);
    }
    if (entry.ciLanes.includes('scheduled-release') && entry.runnerLabels.length === 0) {
      problems.push(`${label}: scheduled-release lanes require a GitHub-hosted runner label.`);
    }

    if (entry.claim.trim().length === 0) {
      problems.push(`${label}: a bounded claim statement is required.`);
    }
    if (entry.doesNotProve.length === 0) {
      problems.push(`${label}: an explicit does-not-prove list is required for every lane.`);
    }
    if (entry.expectedRendererMode !== 'phaser' && entry.expectedRendererMode !== 'pixi') {
      problems.push(`${label}: the expected renderer mode must be phaser or pixi.`);
    }
  }

  for (const project of PHASE_1_CURRENT_BUILD_PROJECTS) {
    const entry = matrix.find((candidate) => candidate.project === project);
    if (!entry) {
      problems.push(`${project}: the verified Phase 1 viewport project must be preserved.`);
      continue;
    }
    if (entry.suite !== 'phase-1-current-build') {
      problems.push(`${project}: the Phase 1 project must stay in the current-build suite.`);
    }
  }

  for (const project of COMPATIBILITY_PROJECTS) {
    const entry = matrix.find((candidate) => candidate.project === project);
    if (!entry) {
      problems.push(`${project}: a named compatibility project is required.`);
      continue;
    }
    if (entry.suite !== 'cross-engine-compatibility') {
      problems.push(`${project}: the compatibility project must stay in the compatibility suite.`);
    }
    if (isPhase1CurrentBuildProject(entry.project)) {
      problems.push(`${project}: compatibility and current-build projects must not overlap.`);
    }
  }

  return problems;
}
