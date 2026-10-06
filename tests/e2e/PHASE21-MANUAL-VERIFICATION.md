# Phase 21 discharge kit: the five manual gates

**Who this is for.** Someone with a Chromebook, a tablet, a Mac, a Windows box, or a Linux laptop, who
has never seen this codebase, and who wants to discharge one of Phase 21's five manual accessibility
gates and record the result in a form this repository can check.

**What this is not.** It is not an accessibility audit, and completing it does not make a conformance
claim. It is the mechanism for turning five outstanding items into evidence someone else can read.

**Why it is written down at all.** Phase 21's automated suite runs in a Linux container with no
Chromebook, no tablet, no touch hardware, no ChromeVox, no TalkBack, no VoiceOver, no released Safari,
and no installed Edge. Every one of those is a fact about where the automation runs, not about the
product. `npm run test:a11y` therefore ends `COVERAGE: INCOMPLETE` and exits `3`, and that is correct:
five gates in `PHYSICAL_DEVICE_GATES` cannot be discharged from here. This document is how they get
discharged elsewhere.

---

## 0. Before you start

### What to run

The evidence must describe the **production artifact**, not a dev server. A `vite dev` server ships no
bundle, defers nothing the way the built artifact defers it, and an accessibility result from it is a
result about a different program.

```bash
npm ci                       # if you have not already
npm run build:web            # writes dist/
npm run record:web-artifact  # writes artifacts/web-artifact-manifest.json
```

Then serve `dist/` on a **real origin** - a laptop's LAN address or `file://` both change behaviour that
matters here (service-worker scope, Web Share availability, some focus behaviour), so use an ordinary
local HTTP server:

```bash
npx vite preview --host 127.0.0.1 --port 43173 --strictPort
```

Write the URL and the artifact identity into the record's `evidence.artifactRef`. The
`artifacts/web-artifact-manifest.json` tree hash is the value that says *which* build was observed.

### What to record

You will fill in `tests/e2e/manual-verification-record.json`. **Do not put learner data in it.** There is
no field for a subject name, a note body, an attachment, a statistic or a preference, and the validator
rejects unknown keys - so the file will refuse to accept them. Use the application with the tutorial's
own sample subject; you do not need a learner's real work to observe any of this.

### What counts as a pass, in one sentence

**The step's own pass criterion holds, and you can say what you observed.** "It seemed fine" is not an
observation. "The dialog announced `Settings`, and Tab cycled inside it for eleven stops without ever
reaching the page behind" is.

### The result file

```bash
npm run check:manual-verification
```

prints one line per gate and exits `0` when the record is valid, `1` when it is not, with every problem
listed. It is the same validator the test suite uses, so a record that passes here passes in CI.

---

## Gate 1 — Physical Chromebook (with ChromeVox)

**Gate id:** `physical-chromebook-screen-reader`
**Phase requirement, verbatim:** *"One physical Chromebook completes Welcome to Village to Dungeon and
back with ChromeVox enabled."*
**What it cannot prove without you:** Chromium viewport emulation cannot produce ChromeVox speech
output, and a 1366x768 window is not a ChromeOS device.

| | |
| --- | --- |
| **Device** | A Chromebook - any model. Not a Linux container pretending to be one. |
| **Screen reader** | ChromeVox, on by default with <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Shift</kbd>. Verify with <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>?</kbd> |
| **Evidence class** | `physical-device-manual` |

### Steps

| id | do | observe | pass | a failure is |
| --- | --- | --- | --- | --- |
| `cb-01` | Load the artifact over its real origin; wait for the **Knowledge Dungeon** heading. | What ChromeVox says on arrival. | The Welcome screen is announced without the page being clicked first. | Nothing announced until you touch the trackpad. |
| `cb-02` | From the top of the document, press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>→</kbd> repeatedly. Never touch the trackpad. | The announcement at each stop. | Every stop announces a **control** with a name that makes sense spoken aloud. | A stop announcing only a glyph ("button", "star") or nothing. |
| `cb-03` | Reach the village, activate the launcher spoken as **Settings**, then <kbd>Tab</kbd> through it. | The dialog's announcement; where focus goes; where it refuses to go. | The dialog names itself; Tab stays inside; first control has focus on open. | Focus escaping to the page behind, an unnamed dialog, or focus starting on a destructive action. |
| `cb-04` | Inside Settings, with the pointer nowhere near the screen, use the arrow keys to move between appearance choices. | What is spoken on each press; where the tab stop goes. | Each press names the option **and** says whether it is selected; the group is one tab stop. | Four separate tab stops, no spoken selected state, or selection shown only in colour. |
| `cb-05` | <kbd>Tab</kbd> to the **Nearby** list, activate a row, then <kbd>Esc</kbd>. | Whether the action fires; where focus lands afterwards. | The action fires and focus returns to the opener, nothing behind it. | Focus on the document body, or left inside a HUD control. |
| `cb-06` | Complete Welcome → Village → room → back with the keyboard alone. | Every step. | Every step reachable with <kbd>Tab</kbd>, arrows, <kbd>Enter</kbd>, <kbd>Space</kbd>, <kbd>Esc</kbd>. | Any step that needs a pointer. |

### Record

```json
{
  "gateId": "physical-chromebook-screen-reader",
  "verdict": "discharged",
  "evidenceClass": "physical-device-manual",
  "evidence": {
    "device": "chromebook",
    "deviceModel": "Pixelbook Go",
    "operatingSystem": "ChromeOS 126.0.6478.17",
    "browser": "Chrome 126.0.6478.85",
    "assistiveTechnology": "ChromeVox",
    "assistiveTechnologyVersion": "2024.05",
    "operator": "your name or handle",
    "performedOn": "2026-10-06",
    "artifactRef": "artifacts/web-artifact-manifest.json"
  },
  "notDerivedFrom": [],
  "observations": [
    { "stepId": "cb-02", "note": "Fourteen stops, all named controls.", "outcome": "met" }
  ],
  "note": ""
}
```

---

## Gate 2 — Physical tablet (touch, with a screen reader)

**Gate id:** `physical-touch-platform-screen-reader`
**Phase requirement:** *"One physical iPad or Android tablet completes a core learning action with a
screen reader active."*
**What it cannot prove without you:** emulated touch does not produce a touch screen reader, and a tap
emulator does not reproduce platform gestures.

| | |
| --- | --- |
| **Device** | An iPad or an Android tablet. |
| **Screen reader** | VoiceOver (iPadOS) or TalkBack (Android). |
| **Evidence class** | `physical-device-manual` |

### **The drawer is the thing to get right on this gate**

On a tablet the village status panel is **not a side panel**. `useVillageSurfaceMode` returns `sheet`
for a coarse or hoverless pointer, and `VillageHud` then renders **only a toggle button** and
**unmounts the entire column** - which means:

- the **Nearby** action list (`data-village-nearby="true"`) does not exist until the drawer is opened;
- the **Settings** launcher does not exist until the drawer is opened;
- the Data, Stats and Create launchers do not exist either.

So a tablet learner who cannot find the drawer toggle cannot reach Settings, the nearby actions, or
Data Center at all. This is the single most likely real defect this gate exists to catch, and it is why
`touch-02` exists as its own step rather than as an aside. **Open the drawer, then check everything.**

### Steps

| id | do | observe | pass | a failure is |
| --- | --- | --- | --- | --- |
| `touch-01` | Turn the screen reader on, load the artifact, reach the village. | Whether every step is reachable without a gesture the screen reader cannot make. | The whole route is screen-reader operable. | A multi-finger gesture, a long-press-only action, or hover. |
| `touch-02` | **Open the HUD drawer**: swipe to the toggle, double-tap to activate. | The toggle's announcement; what appears afterwards. | The toggle names itself **and** states collapsed or expanded; a region named "Village status and controls" appears. | The toggle is unnamed, or its contents are unreachable while it is announced as collapsed. |
| `touch-03` | Swipe through the **Nearby** list with the drawer open; activate a row. | Each row's announcement; the result. | Each row names a verb and a target ("Talk to…", "Interact with…"); the result is announced; the empty state is spoken. | Rows with no target, or an empty list announced as nothing. |
| `touch-04` | Open the **share card dialog**; swipe the card-type group, the preview, the close control. | Names and states of each. | The dialog names itself; the card-type group announces a selected state; the preview has a description; close is named and reachable. | An unnamed dialog, or the card-type group announced as a flat list with no selection. |
| `touch-05` | Complete **one core learning action** end to end with the screen reader active. | The action and its announced outcome. | It completes and the outcome is announced. | Any step needing hover, right-click, or a precision drag. |
| `touch-06` | Screen reader **off**. Tap the same surfaces. Measure the drawer toggle, the nearby rows, and the fishing controls. | Target sizes in CSS pixels. | Every interactive target ≥ 44×44 CSS px; no precision gesture. | Anything below 44×44 CSS px, or an action reachable only by long press. |

**On measuring 44 CSS pixels.** The browser's own zoom changes CSS pixels, so measure at 100% zoom. Use
the browser's element inspector, or a screenshot ruler, and measure the **tappable** area - which for a
button with a 44×44 style minimum is the whole button, not just its glyph.

### Record

Set `"device"` to `"ios-tablet"` or `"android-tablet"`, and
`"assistiveTechnology"` to `"VoiceOver"` or `"TalkBack"`. Put at least one observation on `touch-02`;
that is the step that would catch an unreachable Settings launcher.

---

## Gate 3 — Real macOS Safari

**Gate id:** `physical-macos-safari`
**Phase requirement:** *"One physical macOS Safari check completes the same core flow on the released
production artifact."*
**What it cannot prove without you:** Playwright's WebKit is an engine build. It is not the Safari that
ships with a macOS release, and `compat-webkit` is macOS-only and cannot run from this container at
all.

| | |
| --- | --- |
| **Device** | A Mac. |
| **Browser** | The **released** Safari - Safari.app from `/Applications`, not a technology preview, not a bundled WebKit. |
| **Evidence class** | `physical-device-manual` |

| id | do | observe | pass | a failure is |
| --- | --- | --- | --- | --- |
| `safari-01` | Open the artifact in released Safari. | It loads and reaches the village. | Yes. | A claim resting on a Playwright WebKit build. |
| `safari-02` | Welcome → Village → room → back. | Console errors and behaviour. | The flow completes; no console error breaks the product. | Any step failing only in Safari. |
| `safari-03` | Open Settings and the share dialog; dismiss each with <kbd>Esc</kbd> and with its close control. | Dismissal and focus. | Both dismiss; focus returns to the opener; focus never lands behind. | <kbd>Esc</kbd> ignored, or focus on the body. |
| `safari-04` | Turn VoiceOver on; walk Welcome and the village HUD. | Announcements. | Controls announced with names; the dialog announces its name. | Unnamed controls, or an unnamed "dialog". |

Set `"device"` to `"macos-laptop"`.

---

## Gate 4 — Real Windows desktop browser

**Gate id:** `physical-windows-desktop-browser`
**Phase requirement:** *"One physical Windows desktop browser completes the core flow, including a
file-picker or download action where the flow requires one."*
**What it cannot prove without you:** a Windows CI runner verifies the recorded artifact, not a
user-installed browser profile with the extensions, fonts and settings a learner actually has.
`compat-edge` is Windows-only and cannot run here.

| | |
| --- | --- |
| **Device** | A Windows laptop or desktop. |
| **Browser** | The installed desktop browser - Edge or Chrome, as installed, with its default profile. |
| **Evidence class** | `physical-device-manual` |

| id | do | observe | pass | a failure is |
| --- | --- | --- | --- | --- |
| `win-01` | Open the artifact in the installed browser. | It loads and reaches the village. | Yes. | Substituting a Playwright Chromium build for the installed browser. |
| `win-02` | Complete the core flow **including a file-picker or download**: the Data Center export, or the share-card download. | The picker or download; whether the outcome is announced or shown in words. | It completes, and the outcome is announced or shown. | A silent download, or a picker with no accessible description. |
| `win-03` | Open Settings and the Data Center; dismiss each with <kbd>Esc</kbd>. | Dismissal and focus. | Both dismiss and restore focus to the opener. | <kbd>Esc</kbd> ignored, or focus lost to the body. |

Set `"device"` to `"windows-laptop"`.

---

## Gate 5 — Real Linux desktop browser

**Gate id:** `physical-linux-desktop-browser`
**Phase requirement:** *"One physical Linux desktop browser completes the core flow on a distribution
the maintainer supports."*
**What it cannot prove without you:** the compatibility lanes here run in a container on one Ubuntu
image. A container is not a distribution certification, and this container is not a desktop.

| | |
| --- | --- |
| **Device** | A Linux laptop or desktop on a distribution the project supports. |
| **Evidence class** | `physical-device-manual` |

| id | do | observe | pass | a failure is |
| --- | --- | --- | --- | --- |
| `linux-01` | Open the artifact in the installed browser. | It loads and reaches the village. | Yes. | Claiming per-distribution coverage from a CI runner. |
| `linux-02` | Complete the core flow, including a download action. | The flow and the download. | It completes and the download is operable. | A step that only fails outside the container. |

Set `"device"` to `"linux-laptop"`.

---

## Appendix A — the keyboard-only learning path

Fourteen steps, in order, covering the **complete** path:
Welcome → Village → Creator → Scribe → Archaeologist → Statistics → Fishing → Data Center → Settings →
share dialog, then the same path at 200% zoom and at 320 CSS pixels.

Reload the artifact. Put the mouse down - ideally out of reach - and use only <kbd>Tab</kbd>,
<kbd>Shift</kbd>+<kbd>Tab</kbd>, arrows, <kbd>Enter</kbd>, <kbd>Space</kbd> and <kbd>Esc</kbd>. At each
step, note the announced name and whether it worked. A step passes when the named control is reached by
<kbd>Tab</kbd> and the outcome happens on <kbd>Enter</kbd>/<kbd>Space</kbd>, with no pointer use
anywhere in the path.

| id | do | pass |
| --- | --- | --- |
| `kb-01` | Load the artifact; <kbd>Tab</kbd> to the first control. | A control with a spoken name, not a skip link leading nowhere. |
| `kb-02` | Move between the four Welcome tabs (**Create / Load**, **Player Setup**, **Guide**, **Data**) with arrows, then <kbd>Tab</kbd> out. | Arrows move; <kbd>Tab</kbd> leaves the group; the selected tab announces as selected. |
| `kb-03` | Create or load a subject through the Welcome form; submit with <kbd>Enter</kbd>. | Every field reachable and labelled; submission works; the result is announced. |
| `kb-04` | Start the tutorial and reach the village by keyboard. | Every step a labelled control; no canvas click required. |
| `kb-05` | In the village, walk with arrows or <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>. | Movement works; position change is reflected in an announced or visible status. |
| `kb-06` | <kbd>Tab</kbd> to **Nearby**; activate a row with <kbd>Enter</kbd>. | Reachable; rows name a verb and a target; the result is announced. |
| `kb-07` | Enter a room, move to **Creator**, use the topic tools. | Opens from a labelled control; regions announced as regions; a next-action recommendation moves focus where it says; a topic can be added. |
| `kb-08` | Switch to **Scribe**, submit a note; switch to **Archaeologist**, rate a room. | Each switch is labelled; each workspace announces its phase in words; progress is not colour-only. |
| `kb-09` | Open **Statistics**, read a total, <kbd>Esc</kbd> to close. | Named dialog; text content, not an image; focus returns to the opener. |
| `kb-10` | Fish: enter the pond, charge, hook, keep - keyboard only. | Every control reachable; charge responds to <kbd>Space</kbd>/<kbd>Enter</kbd>; the bite window is announced; the catch is announced. |
| `kb-11` | Open the **Data Center**, walk its tabs, <kbd>Esc</kbd> to dismiss. | One tab stop with arrow movement; each panel associated with its tab. |
| `kb-12` | Open **Settings**, move within its groups with arrows, <kbd>Esc</kbd> to dismiss. | Each group one tab stop; arrows move and select; focus returns to the opener. |
| `kb-13` | Open the **share card dialog**, change card type with arrows, dismiss. | Named dialog; card-type group announces selection; focus returns to the opener. |
| `kb-14` | Repeat the whole path at **200% zoom** and at a **320 CSS-pixel** window. | Nothing clipped; no control unreachable; no horizontal scrolling to reach a control. |

---

## Appendix B — the three worlds' DOM mirrors

Each world is a PixiJS canvas, and each has a DOM mirror carrying the same actions. The mirror is the
accessibility route for the canvas, so it must work **on its own**: a mirror that only functions while
the canvas is visible proves nothing for a learner who cannot see the canvas.

| id | do | pass |
| --- | --- | --- |
| `mirror-village-01` | Walk the character next to a building or villager with the keyboard; <kbd>Tab</kbd> to **Nearby**. | The list is in a named region; rows name a verb and a target; the list updates as you move. |
| `mirror-village-02` | Activate a **Nearby** row with <kbd>Enter</kbd>; compare against pressing <kbd>E</kbd> on the canvas. | Both routes produce the same visible and announced result. |
| `mirror-dungeon-01` | Enter a dungeon; <kbd>Tab</kbd> to the **Dungeon actions** group. | The group names itself; controls have names and descriptions; an unavailable action is disabled, not focusable-and-inert. |
| `mirror-dungeon-02` | Activate a dungeon action from the mirror; watch the canvas. | The world changes and the per-control status line updates in words. |
| `mirror-fishing-01` | Enter the pond; <kbd>Tab</kbd> the fishing controls and the **Walk along the shore** group. | Charge, hook and continue all reachable; the two walk controls are separate buttons, not one four-way pad. |
| `mirror-fishing-02` | Charge and release with <kbd>Space</kbd>; hook with <kbd>Enter</kbd> in the bite window. | The meter is announced as a value in words; the bite window is announced; the catch is announced. |

---

## Appendix C — the evidence class, and what the record will not let you claim

Every entry in the record carries `evidenceClass: "physical-device-manual"`. That is the **only** value
the validator accepts, and that restriction is the mechanism:

- `emulated-viewport` describes a Playwright viewport. `tests/e2e/support-matrix.ts` says so in its own
  claim strings.
- `engine-automation` describes a Playwright-bundled browser engine.
- `branded-channel-automation` describes an installed branded channel.
- `physical-device-manual` describes **a person on real hardware**. `support-matrix.test.ts` asserts no
  matrix entry claims it; `infraA11ySuite.test.ts` asserts no audit cell claims it; and
  `manualVerificationRecord.test.ts` asserts no record entry can claim anything else.

Three further rules, all enforced rather than documented:

1. **A discharge requires a complete attestation.** Device, model, OS version, browser version,
   assistive technology and its version, operator, date, and the recorded artifact. Any one missing and
   the record is invalid - so a half-finished run cannot read as a completed one.
2. **`notDerivedFrom` may not name a matrix project.** All eight - `desktop-chromium`, `chromebook`,
   `tablet`, `tablet-landscape`, `compat-chromium`, `compat-firefox`, `compat-webkit`, `compat-edge` -
   are rejected. This is what makes *"the `tablet` Playwright project passed, therefore the tablet gate
   is discharged"* an error rather than a sentence. If a Playwright run informed your observation, the
   observation is automated evidence and belongs in `npm run test:a11y`'s report, not in this file.
3. **Unknown keys are rejected.** There is no field to file a subject name or a note into.

### What a fully discharged record still does not establish

- It is **not** a WCAG conformance claim and **not** an audit.
- It is **not** a claim about any browser, device, or operating-system version nobody tested. One
  iPad model is not iPadOS.
- It is **not** an operating-system or distribution certification. `compat-webkit` and `compat-edge`
  remain `host-not-approved` on this host, and a manual Safari check does not make the automated
  WebKit cell runnable on Linux.
- It does **not** discharge the *automated* matrix requirement. Plan section 10.4's "at least one
  Chromium and one non-Chromium lane for each supported OS family" needs a macOS runner and a Windows
  runner, which is a different task with a different host.

---

## Appendix D — the one-line verdict table

`npm run check:manual-verification` prints this, one line per gate:

```
== Phase 21 manual verification record ==
record: tests/e2e/manual-verification-record.json    evidence class: physical-device-manual

GATE VERDICTS (0/5 discharged):
  UNVERIFIED  physical-chromebook-screen-reader      physical-device-manual  no device recorded
  UNVERIFIED  physical-macos-safari                  physical-device-manual  no device recorded
  UNVERIFIED  physical-touch-platform-screen-reader  physical-device-manual  no device recorded
  UNVERIFIED  physical-windows-desktop-browser       physical-device-manual  no device recorded
  UNVERIFIED  physical-linux-desktop-browser         physical-device-manual  no device recorded
```

`UNVERIFIED` is the default and is an **absence, not a pass**. The phase cannot be closed until all five
read `DISCHARGED`.