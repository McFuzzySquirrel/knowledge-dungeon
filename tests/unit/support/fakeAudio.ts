/**
 * A fake `AudioContext` for the audio unit tests.
 *
 * ## Why this exists rather than a `vi.fn()` per call site
 *
 * The audio tests need to assert things a mock of the *manager's* methods cannot
 * reach: that no context is constructed before a gesture, that a volume change is a
 * gain assignment on a live node rather than a restart, that mute silences a track
 * that is already playing, and that dispose disconnects every node. All four are
 * claims about the audio graph, so the graph has to be observable.
 *
 * jsdom has no `AudioContext` - deliberately; it is a DOM implementation, not an
 * audio one. So the tests inject a context, and this module is that context. It
 * records every node it creates, every parameter assignment, and every scheduled
 * start/stop, which turns "the volume control reached the graph" into an assertion
 * about a recorded value rather than a hope.
 *
 * ## What it deliberately does not model
 *
 * No clock progression and no DSP. `currentTime` is a field the test advances by
 * hand when a test needs a schedule to have happened. Modelling an audio clock
 * properly would mean modelling sample-accurate scheduling, and every test that
 * depended on it would be asserting on the fake rather than on the service.
 */
export interface FakeAudioParam {
  value: number;
  readonly events: Array<{ kind: string; value: number; time: number }>;
  setValueAtTime(value: number, time: number): void;
  linearRampToValueAtTime(value: number, time: number): void;
  exponentialRampToValueAtTime(value: number, time: number): void;
  setTargetAtTime(value: number, startTime: number, timeConstant: number): void;
  cancelScheduledValues(time: number): void;
}

export interface FakeAudioNode {
  readonly kind: 'oscillator' | 'gain' | 'bufferSource';
  connect(target: FakeAudioNode | { connect(): void }): void;
  disconnect(): void;
  /** Mutable, because the fake is what records whether a release actually happened. */
  connected: boolean;
  disconnected: boolean;
}

export interface FakeOscillatorNode extends FakeAudioNode {
  type: string;
  frequency: FakeAudioParam;
  detune: FakeAudioParam;
  onended: (() => void) | null;
  started: boolean;
  stopped: boolean;
  start(time?: number): void;
  stop(time?: number): void;
}

export interface FakeGainNode extends FakeAudioNode {
  gain: FakeAudioParam;
}

export interface FakeBufferSourceNode extends FakeAudioNode {
  buffer: unknown;
  loop: boolean;
  onended: (() => void) | null;
  started: boolean;
  stopped: boolean;
  start(time?: number): void;
  stop(time?: number): void;
}

/** One recorded connection, for asserting that a release actually disconnected. */
export interface RecordedConnection {
  readonly from: FakeAudioNode;
  readonly to: FakeAudioNode;
}

export class FakeAudioContext {
  /** Every node this context created, in creation order. */
  readonly nodes: FakeAudioNode[] = [];
  readonly destination = { connect(): void {}, disconnect(): void {} };
  readonly oscillators: FakeOscillatorNode[] = [];
  readonly gains: FakeGainNode[] = [];
  readonly bufferSources: FakeBufferSourceNode[] = [];
  /** Connections that have not been disconnected. */
  readonly liveConnections: RecordedConnection[] = [];
  currentTime = 0;
  sampleRate = 44100;
  state: 'suspended' | 'running' | 'closed' = 'running';
  closed = 0;
  resumeCalls = 0;
  resumeResult: 'resolve' | 'reject' = 'resolve';
  /** Bytes `decodeAudioData` is handed. Null means "unsupported decode". */
  decodeResult: { buffer: unknown } | null = { buffer: { duration: 1 } };

  private makeParam(): FakeAudioParam {
    const param: FakeAudioParam = {
      value: 0,
      events: [],
      setValueAtTime(value, time) {
        param.value = value;
        param.events.push({ kind: 'set', value, time });
      },
      linearRampToValueAtTime(value, time) {
        param.value = value;
        param.events.push({ kind: 'linear', value, time });
      },
      exponentialRampToValueAtTime(value, time) {
        // Mirrors the real platform's rejection of a zero or negative target,
        // which is the constraint the procedural recipes work around.
        if (!(value > 0)) throw new Error('exponentialRamp cannot reach zero');
        param.value = value;
        param.events.push({ kind: 'exponential', value, time });
      },
      setTargetAtTime(value, startTime, timeConstant) {
        param.value = value;
        param.events.push({ kind: 'target', value, time: startTime + timeConstant });
      },
      cancelScheduledValues(time) {
        param.events.push({ kind: 'cancel', value: param.value, time });
      },
    };
    return param;
  }

  createGain(): FakeGainNode {
    const ledger = this.liveConnections;
    const node: FakeGainNode = {
      kind: 'gain',
      gain: this.makeParam(),
      connected: false,
      disconnected: false,
      connect(target) {
        node.connected = true;
        ledger.push({ from: node, to: target as FakeAudioNode });
      },
      disconnect() {
        node.disconnected = true;
        for (let index = ledger.length - 1; index >= 0; index -= 1) {
          if (ledger[index]?.from === node) ledger.splice(index, 1);
        }
      },
    };
    this.nodes.push(node);
    this.gains.push(node);
    return node;
  }

  createOscillator(): FakeOscillatorNode {
    // The ledger is captured rather than read through `this`: the node methods below
    // are object-literal functions, so their `this` is the node, not the context.
    const ledger = this.liveConnections;
    const node: FakeOscillatorNode = {
      kind: 'oscillator',
      type: 'sine',
      frequency: this.makeParam(),
      detune: this.makeParam(),
      onended: null,
      connected: false,
      disconnected: false,
      started: false,
      stopped: false,
      start() {
        if (node.started) throw new Error('oscillator already started');
        node.started = true;
      },
      stop() {
        if (node.stopped) throw new Error('cannot stop an oscillator twice');
        node.stopped = true;
      },
      connect(target) {
        node.connected = true;
        ledger.push({ from: node, to: target as FakeAudioNode });
      },
      disconnect() {
        node.disconnected = true;
        for (let index = ledger.length - 1; index >= 0; index -= 1) {
          if (ledger[index]?.from === node) ledger.splice(index, 1);
        }
      },
    };
    this.nodes.push(node);
    this.oscillators.push(node);
    return node;
  }

  createBufferSource(): FakeBufferSourceNode {
    // Same reason as `createOscillator`: the connect/disconnect closures need the
    // context's connection ledger, and `this` inside a node method is the node.
    const ledger = this.liveConnections;
    const node: FakeBufferSourceNode = {
      kind: 'bufferSource',
      buffer: null,
      loop: false,
      onended: null,
      connected: false,
      disconnected: false,
      started: false,
      stopped: false,
      start() {
        if (node.started) throw new Error('buffer source already started');
        node.started = true;
      },
      stop() {
        if (node.stopped) throw new Error('cannot stop a buffer source twice');
        node.stopped = true;
      },
      connect(target) {
        node.connected = true;
        ledger.push({ from: node, to: target as FakeAudioNode });
      },
      disconnect() {
        node.disconnected = true;
        for (let index = ledger.length - 1; index >= 0; index -= 1) {
          if (ledger[index]?.from === node) ledger.splice(index, 1);
        }
      },
    };
    this.nodes.push(node);
    this.bufferSources.push(node);
    return node;
  }

  async decodeAudioData(_bytes: ArrayBuffer): Promise<unknown> {
    if (this.decodeResult === null) throw new Error('decodeAudioData is not available');
    return this.decodeResult.buffer;
  }

  resume(): Promise<void> {
    this.resumeCalls += 1;
    this.state = 'running';
    return this.resumeResult === 'resolve' ? Promise.resolve() : Promise.reject(new Error('refused'));
  }

  close(): Promise<void> {
    this.closed += 1;
    this.state = 'closed';
    return Promise.resolve();
  }
}

/**
 * A minimal `AudioContext`-shaped view of a fake, for the graph factory.
 *
 * `createAudioGraph` types its argument as the platform `AudioContext`, which is
 * correct for production and unhelpful for a test: casting once here keeps every
 * test's cast in one place rather than in each test body.
 */
export function asAudioContext(context: FakeAudioContext): AudioContext {
  return context as unknown as AudioContext;
}
