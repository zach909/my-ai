/**
 * Ports: one number for every neuron that carries something in or out of the mesh.
 *
 * The Zip Loop talks through six neurons. Each of them is a PORT, numbered 1 to 6, inputs first and then outputs:
 *
 *   Port 1  bit 0 in      (the neuron that stands for a 0 going in)
 *   Port 2  bit 1 in      (the neuron that stands for a 1 going in)
 *   Port 3  send in       (the send / ramp neuron going in: one tick per bit)
 *   Port 4  bit 0 out
 *   Port 5  bit 1 out
 *   Port 6  send out
 *
 * Two more inputs ride the Zip Loop beside the prompt, each in its own archive folder, and each gets a port too:
 *
 *   Port 7  questioning in  (the confidence dial, core/neurons.ts, folder neurons/)
 *   Port 8  effort in       (the effort dial, core/effort.ts, folder effort/)
 *
 * That is every port. A port number never changes, so logs, the UI and the docs can all say "port 5" and mean the
 * same thing. A port is a name for a neuron or an input; it does not move any signal itself.
 *
 * The neuron ids are the mesh's own and stay where they are (see ZIP_LOOP_DEFAULT_IDS / zipLoopIdsFor in
 * onebrain.ts). A doorway (core/doorways.ts) is the same six ports on six fresh neurons, so its ports are numbered
 * 1 to 6 the same way and `portsOfDoorway` maps its neuron ids onto them.
 *
 * Pure data and counting: no I/O, nothing from outside the repo.
 */

export type PortSide = 'in' | 'out';
export type PortKind = 'bit0' | 'bit1' | 'send' | 'questioning' | 'effort';

export interface PortSpec {
  /** The port's number, 1 to 8. Fixed. */
  port: number;
  /** "Port 3". */
  name: string;
  kind: PortKind;
  side: PortSide;
  /** What it is, in a few words: "send in". */
  label: string;
  /** The mesh neuron id in the live Zip Loop. Only the six bit/send ports have one; the dial ports ride a folder. */
  neuron?: number;
  /** The Zip Loop archive folder the port's input arrives in, for the dial ports. */
  folder?: string;
}

/** The order a doorway's six neurons are made in (see doorways.ts): bit0In, bit1In, bit0Out, bit1Out, toggleIn, toggleOut. */
export const DOORWAY_NEURON_ORDER = ['bit0In', 'bit1In', 'bit0Out', 'bit1Out', 'toggleIn', 'toggleOut'] as const;

const spec = (port: number, kind: PortKind, side: PortSide, label: string, extra: { neuron?: number; folder?: string } = {}): PortSpec =>
  Object.freeze({ port, name: `Port ${port}`, kind, side, label, ...extra });

/** Ports 1-6: the Zip Loop's own neurons, inputs then outputs. The neuron ids are the live mesh's (onebrain.ts). */
export const ZIP_LOOP_PORTS: readonly PortSpec[] = Object.freeze([
  spec(1, 'bit0', 'in', 'bit 0 in', { neuron: 0 }),
  spec(2, 'bit1', 'in', 'bit 1 in', { neuron: 1 }),
  spec(3, 'send', 'in', 'send in', { neuron: 4 }),
  spec(4, 'bit0', 'out', 'bit 0 out', { neuron: 2 }),
  spec(5, 'bit1', 'out', 'bit 1 out', { neuron: 3 }),
  spec(6, 'send', 'out', 'send out', { neuron: 5 }),
]);

export const QUESTIONING_PORT = 7;
export const EFFORT_PORT = 8;

/** Ports 7 and 8: the two dials that ride the Zip Loop in their own folders. Their folders match ZIP_FOLDERS in zip-halt.ts. */
export const DIAL_PORTS: readonly PortSpec[] = Object.freeze([
  spec(QUESTIONING_PORT, 'questioning', 'in', 'questioning in', { folder: 'neurons/' }),
  spec(EFFORT_PORT, 'effort', 'in', 'effort in', { folder: 'effort/' }),
]);

/** Every port there is. */
export const ALL_PORTS: readonly PortSpec[] = Object.freeze([...ZIP_LOOP_PORTS, ...DIAL_PORTS]);

export const PORT_COUNT = ALL_PORTS.length;

/** The port with this number, or undefined. */
export function portByNumber(port: number): PortSpec | undefined {
  return ALL_PORTS.find(p => p.port === port);
}

/** The Zip Loop port a live-mesh neuron id belongs to, or undefined (a neuron that is not one of the six). */
export function portOfNeuron(neuron: number): PortSpec | undefined {
  return ZIP_LOOP_PORTS.find(p => p.neuron === neuron);
}

/** "Port 3 (send in)"; "Port ? (unknown)" for a number that is not a port. */
export function portLabel(port: number): string {
  const p = portByNumber(port);
  return p ? `${p.name} (${p.label})` : `Port ${port} (unknown)`;
}

/**
 * The port a bit goes through. Going in a 0 is Port 1 and a 1 is Port 2; coming out a 0 is Port 4 and a 1 is Port 5.
 * Every bit, either value, also ticks the send port on that side (3 in, 6 out).
 */
export function bitPort(side: PortSide, bit: 0 | 1): number {
  return side === 'in' ? (bit === 0 ? 1 : 2) : (bit === 0 ? 4 : 5);
}
export function sendPort(side: PortSide): number {
  return side === 'in' ? 3 : 6;
}

/** A doorway's six neuron ids (in DOORWAY_NEURON_ORDER) laid out against ports 1-6. */
export function portsOfDoorway(neurons: readonly number[]): Array<PortSpec & { neuron: number }> {
  if (neurons.length !== DOORWAY_NEURON_ORDER.length) return [];
  // The doorway's neuron order is bit0In, bit1In, bit0Out, bit1Out, toggleIn, toggleOut: ports 1, 2, 4, 5, 3, 6.
  const portForSlot = [1, 2, 4, 5, 3, 6];
  return portForSlot.map((port, slot) => ({ ...(portByNumber(port) as PortSpec), neuron: neurons[slot] }))
    .sort((a, b) => a.port - b.port);
}

export interface PortActivity {
  port: number;
  name: string;
  label: string;
  /** Bits that have gone through it (for the dial ports: times a value was sent). */
  count: number;
  /** Epoch ms of the last one, or null if none yet. */
  lastAt: number | null;
}

/**
 * Keeps track of what has gone through each port. Counting only: it never decides anything and holds no data
 * from the traffic, just how many and when.
 */
export class PortTracker {
  private readonly counts = new Map<number, { count: number; lastAt: number | null }>();

  constructor(private readonly now: () => number = Date.now) {
    for (const p of ALL_PORTS) this.counts.set(p.port, { count: 0, lastAt: null });
  }

  /** Note `n` more things through `port`. Ignores a number that is not a port and a count that is not a positive whole number. */
  record(port: number, n = 1): void {
    const c = this.counts.get(port);
    if (!c || !Number.isInteger(n) || n <= 0) return;
    c.count += n;
    c.lastAt = this.now();
  }

  /** Note raw bytes going in or out: every 0 bit on that side's bit-0 port, every 1 bit on its bit-1 port, every bit on its send port. */
  recordBytes(side: PortSide, bytes: Uint8Array): void {
    let ones = 0;
    for (const b of bytes) { let v = b; while (v) { ones += v & 1; v >>= 1; } }
    const total = bytes.length * 8;
    this.record(bitPort(side, 0), total - ones);
    this.record(bitPort(side, 1), ones);
    this.record(sendPort(side), total);
  }

  /** Every port with its count, in port order. */
  snapshot(): PortActivity[] {
    return ALL_PORTS.map(p => {
      const c = this.counts.get(p.port)!;
      return { port: p.port, name: p.name, label: p.label, count: c.count, lastAt: c.lastAt };
    });
  }

  get(port: number): PortActivity | undefined {
    return this.snapshot().find(p => p.port === port);
  }
}
