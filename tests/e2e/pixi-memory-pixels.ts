/**
 * Reading the world's own pixels, so "reduced motion means no movement" is a
 * geometric claim rather than a guess.
 *
 * ## Why this module exists
 *
 * The first version of this lane's reduced-motion test compared two screenshots for
 * byte equality and asserted that they were identical under reduced motion. That
 * assertion is wrong, and the browser proved it on the first run: lighting the
 * lantern *tints* it - `embers % 2` picks a different colour - and a tint is a
 * state change, not motion. `createTestWorld` says so in its own docstring: "the
 * count still increments and the lantern still changes colour - the state change is
 * information - while the lantern's size does not change at all, because a size
 * change is motion." A byte-equality test cannot tell those two apart, and it would
 * have reported a correct world as broken.
 *
 * So the measurement here is *area*, not identity. Both runs press the same control
 * on the same world, and the two differ in exactly one respect: with motion enabled
 * the lantern is scaled up by `motion.travelPx('large')` before it is tinted, so the
 * region that changes is a strictly larger disc. Under reduced motion the travel is
 * zero and the changed region is the lantern at its base size. That is a statement
 * about the drawn geometry, measured from the compositor, in a real engine.
 *
 * ## Why a PNG decoder at all
 *
 * Because the alternative is a proxy. `gl.readPixels` on the world's own context is
 * only meaningful inside a frame, the scene's `lanternRadius` is a property of a
 * closure the page cannot reach, and `canvas.toDataURL()` on a WebGL canvas returns
 * an empty image unless the renderer was created with `preserveDrawingBuffer` - which
 * would be a change to the product to make a test easier. A compositor screenshot is
 * what the learner sees, and decoding it is 8-bit PNG un-filtering: no dependency, no
 * product change, and a decoder whose failure mode is "zero changed pixels", which
 * the lane's own control below cannot mistake for a result.
 *
 * Everything here is pure: bytes in, numbers out. It imports nothing.
 */

/** A decoded 8-bit PNG. `channels` is 1 (grey), 2 (grey+alpha), 3 (RGB) or 4 (RGBA). */
export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  /** Row-major, `channels` bytes per pixel. */
  readonly data: Uint8Array;
}

/** Where and how much two images of the same size differ. */
export interface ChangedRegion {
  readonly sameSize: boolean;
  /** Pixels whose bytes differ at all. */
  readonly changedPixels: number;
  /** Left/top/right/bottom of the changed pixels, inclusive; `0` when nothing changed. */
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  /** The bounding box's area in pixels. `0` when nothing changed. */
  readonly boundingBoxArea: number;
}

export interface DecodeFailure {
  readonly code: string;
  readonly message: string;
}

export type DecodeResult =
  | { readonly ok: true; readonly image: DecodedImage }
  | { readonly ok: false; readonly failure: DecodeFailure };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The number of samples per pixel for each 8-bit PNG colour type. */
const CHANNELS_BY_COLOUR_TYPE: Readonly<Record<number, number>> = {
  0: 1,
  2: 3,
  4: 2,
  6: 4,
};

/**
 * Decodes an 8-bit, non-interlaced PNG.
 *
 * Every rejection is a bounded code and a sentence, never a byte offset into
 * somebody's screenshot, and interlaced or 16-bit input is refused rather than
 * approximated - a wrong answer here would make the reduced-motion comparison
 * meaningless rather than merely wrong.
 */
export function decodePng(bytes: Uint8Array): DecodeResult {
  if (bytes.length < 8 || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    return { ok: false, failure: { code: 'not-a-png', message: 'The screenshot is not a PNG.' } };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = -1;
  let interlace = 0;
  const idat: number[] = [];

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4] ?? 0,
      bytes[offset + 5] ?? 0,
      bytes[offset + 6] ?? 0,
      bytes[offset + 7] ?? 0,
    );
    const dataStart = offset + 8;
    if (dataStart + length + 4 > bytes.length) {
      return {
        ok: false,
        failure: { code: 'truncated-chunk', message: `The PNG's ${type} chunk is truncated.` },
      };
    }
    if (type === 'IHDR') {
      if (length < 13) {
        return { ok: false, failure: { code: 'bad-header', message: 'The PNG header is too short.' } };
      }
      width = view.getUint32(dataStart);
      height = view.getUint32(dataStart + 4);
      bitDepth = bytes[dataStart + 8] ?? 0;
      colourType = bytes[dataStart + 9] ?? -1;
      interlace = bytes[dataStart + 12] ?? 0;
    } else if (type === 'IDAT') {
      for (let index = 0; index < length; index += 1) idat.push(bytes[dataStart + index] ?? 0);
    } else if (type === 'IEND') {
      break;
    }
    offset = dataStart + length + 4;
  }

  if (width <= 0 || height <= 0) {
    return { ok: false, failure: { code: 'no-header', message: 'The PNG declares no size.' } };
  }
  if (bitDepth !== 8) {
    return {
      ok: false,
      failure: { code: 'unsupported-bit-depth', message: `Only 8-bit PNGs are decoded; this one is ${bitDepth}-bit.` },
    };
  }
  if (interlace !== 0) {
    return { ok: false, failure: { code: 'interlaced', message: 'An interlaced PNG is refused rather than approximated.' } };
  }
  const channels = CHANNELS_BY_COLOUR_TYPE[colourType];
  if (channels === undefined) {
    return {
      ok: false,
      failure: { code: 'unsupported-colour-type', message: `PNG colour type ${colourType} is not decoded.` },
    };
  }

  let raw: Uint8Array;
  try {
    // Node's zlib, reached without importing it: the caller supplies the inflate
    // function, so this module stays dependency-free and the test supplies the real
    // one. A missing or throwing inflate is a bounded failure, not a stack trace.
    raw = inflate(Uint8Array.from(idat));
  } catch {
    return {
      ok: false,
      failure: { code: 'inflate-failed', message: 'The PNG image data could not be inflated.' },
    };
  }

  const stride = width * channels;
  if (raw.length < (stride + 1) * height) {
    return {
      ok: false,
      failure: { code: 'short-image-data', message: 'The PNG image data is shorter than its declared size.' },
    };
  }

  const out = new Uint8Array(stride * height);
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)] ?? 0;
    const lineStart = row * (stride + 1) + 1;
    for (let index = 0; index < stride; index += 1) {
      const value = raw[lineStart + index] ?? 0;
      const left = index >= channels ? (out[row * stride + index - channels] ?? 0) : 0;
      const up = row > 0 ? (out[(row - 1) * stride + index] ?? 0) : 0;
      const upLeft = row > 0 && index >= channels ? (out[(row - 1) * stride + index - channels] ?? 0) : 0;
      let restored: number;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + left;
          break;
        case 2:
          restored = value + up;
          break;
        case 3:
          restored = value + Math.floor((left + up) / 2);
          break;
        case 4:
          restored = value + paeth(left, up, upLeft);
          break;
        default:
          return {
            ok: false,
            failure: { code: 'unknown-filter', message: `PNG filter type ${filter} is not decoded.` },
          };
      }
      out[row * stride + index] = restored & 0xff;
    }
  }

  return { ok: true, image: { width, height, channels, data: out } };
}

/** The PNG Paeth predictor, named so the arithmetic above reads as the spec's. */
function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const dl = Math.abs(estimate - left);
  const du = Math.abs(estimate - up);
  const dul = Math.abs(estimate - upLeft);
  if (dl <= du && dl <= dul) return left;
  return du <= dul ? up : upLeft;
}

/**
 * The inflate implementation this module uses.
 *
 * Assigned by {@link setPngInflater} rather than imported, so the module has no
 * dependency and no Node import in it, and so a test can say what it is measuring.
 * An unset inflater is a bounded failure rather than a thrown `TypeError`.
 */
let inflate: (data: Uint8Array) => Uint8Array = () => {
  throw new Error('no inflater installed');
};

export function setPngInflater(implementation: (data: Uint8Array) => Uint8Array): void {
  inflate = implementation;
}

/** Where two same-sized images differ. */
export function changedRegion(before: DecodedImage, after: DecodedImage): ChangedRegion {
  if (before.width !== after.width || before.height !== after.height) {
    return {
      sameSize: false,
      changedPixels: 0,
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      boundingBoxArea: 0,
    };
  }
  const { width, height, channels, data } = before;
  let changedPixels = 0;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * channels;
      let differs = false;
      for (let channel = 0; channel < channels; channel += 1) {
        if (data[at + channel] !== after.data[at + channel]) {
          differs = true;
          break;
        }
      }
      if (!differs) continue;
      changedPixels += 1;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (changedPixels === 0) {
    return { sameSize: true, changedPixels: 0, left: 0, top: 0, right: 0, bottom: 0, boundingBoxArea: 0 };
  }
  return {
    sameSize: true,
    changedPixels,
    left,
    top,
    right,
    bottom,
    boundingBoxArea: (right - left + 1) * (bottom - top + 1),
  };
}

/* -------------------------------------------------------------------------- */
/* The reduced-motion verdict                                                  */
/* -------------------------------------------------------------------------- */

export interface MotionMeasurement {
  /** Which media-query value this reading was taken under. */
  readonly reducedMotion: boolean;
  /** Whether the two screenshots are byte-identical. */
  readonly identical: boolean;
  readonly changedPixels: number;
  /** The bounding box of the changed pixels; the geometry the verdict compares. */
  readonly boundingBoxArea: number;
  /** `false` when the screenshot could not be decoded, so the numbers are absent. */
  readonly decoded: boolean;
}

export interface MotionVerdictInput {
  readonly withMotion: MotionMeasurement;
  readonly withReducedMotion: MotionMeasurement;
  readonly control: 'idle-world-is-pixel-stable' | 'idle-world-is-not-pixel-stable';
}

export interface MotionVerdictFinding {
  readonly code: string;
  readonly message: string;
}

/**
 * Decides whether reduced motion made the world's *movement* zero.
 *
 * The rule, and the reason it is not a byte-equality rule: a state change the world
 * makes on purpose - the lantern's tint - is information and must stay visible, so
 * "the pictures are identical" is the wrong test and would fail a correct world.
 * What reduced motion removes is *displacement*, so what is compared is the area the
 * change covers: with motion the lantern is scaled up before it is tinted, so its
 * changed region is a strictly larger disc.
 */
export function evaluateMotion(input: MotionVerdictInput): MotionVerdictFinding[] {
  const findings: MotionVerdictFinding[] = [];
  const { withMotion, withReducedMotion, control } = input;

  if (!withMotion.decoded || !withReducedMotion.decoded) {
    findings.push({
      code: 'screenshot-undecodable',
      message:
        'A screenshot could not be decoded, so the changed region is unmeasured rather than zero. A broken ' +
        'decoder and a still world produce the same bytes here, which is why the control below is asserted first.',
    });
    return findings;
  }

  // The control. A world that never changed anything would satisfy the reduced-motion
  // finding for the wrong reason, so the motion-enabled run has to change something.
  if (control !== 'idle-world-is-pixel-stable') {
    findings.push({
      code: 'idle-world-not-stable',
      message:
        'Two consecutive screenshots of an idle world differ, so this comparison would measure the harness ' +
        "rather than the world. The world host's surface is still being resized; see the idle-surface test.",
    });
    return findings;
  }

  if (!withMotion.identical && withMotion.changedPixels < 1) {
    findings.push({
      code: 'motion-run-unmeasured',
      message: 'The motion-enabled screenshots are not identical yet no pixel differs, which cannot both be true.',
    });
    return findings;
  }

  if (withMotion.changedPixels < withReducedMotion.changedPixels) {
    findings.push({
      code: 'reduced-motion-not-shrinking-the-change',
      message:
        `With prefers-reduced-motion: reduce, the lantern's change covered ${withReducedMotion.changedPixels} pixel(s), ` +
        `which is not smaller than the ${withMotion.changedPixels} pixel(s) it covered with motion enabled. Reduced ` +
        'motion is supposed to remove the displacement, not the state change, so the reduced run must cover ' +
        'strictly less of the canvas.',
    });
    return findings;
  }

  if (withReducedMotion.changedPixels < 1) {
    findings.push({
      code: 'reduced-motion-froze-the-world',
      message:
        'Under reduced motion nothing on the canvas changed at all, so the action stopped being visible rather ' +
        'than stopping its movement. The state change is information and has to stay on the canvas.',
    });
  }

  return findings;
}
