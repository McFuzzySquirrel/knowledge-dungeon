import '@testing-library/jest-dom';

// Mock Phaser module globally — Phaser's Canvas/WebGL initialization
// requires a real browser environment that jsdom doesn't provide.
vi.mock('phaser', () => {
  const Game = vi.fn().mockImplementation(() => ({
    destroy: vi.fn(),
    canvas: null,
    events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  }));
  return {
    default: {
      Game,
      Scene: class {},
      Geom: { Line: class {} },
      Math: { Vector2: class {} },
    },
  };
});

// Mock canvas context in case any code accesses it directly
HTMLCanvasElement.prototype.getContext = function () {
  return {
    fillStyle: '',
    fillRect: () => {},
    createImageData: () => ({ data: new Uint8ClampedArray(4) }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData: () => {},
    measureText: () => ({ width: 0 }),
    drawImage: () => {},
    scale: () => {},
    translate: () => {},
    rotate: () => {},
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    fill: () => {},
    clip: () => {},
    arc: () => {},
    rect: () => {},
    clearRect: () => {},
  } as unknown as CanvasRenderingContext2D;
};

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
