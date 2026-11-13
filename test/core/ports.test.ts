import { describe, it, expect } from 'vitest';
import {
  ALL_PORTS, ZIP_LOOP_PORTS, PORT_COUNT, portByNumber, portOfNeuron, portLabel, bitPort, sendPort, portsOfDoorway,
  PortTracker, QUESTIONING_PORT, EFFORT_PORT, QUESTION_PORT,
} from '../../models && skills/core/ports.js';
import { zipLoopIdsFor } from '../../models && skills/core/onebrain.js';
import { ZIP_FOLDERS } from '../../models && skills/core/zip-halt.js';

describe('ports', () => {
  it('numbers every neuron and input 1 to 9, inputs before outputs for the Zip Loop', () => {
    expect(PORT_COUNT).toBe(9);
    expect(ALL_PORTS.map(p => p.port)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(ZIP_LOOP_PORTS.map(p => p.label)).toEqual(['bit 0 in', 'bit 1 in', 'send in', 'bit 0 out', 'bit 1 out', 'send out']);
    expect(ZIP_LOOP_PORTS.slice(0, 3).every(p => p.side === 'in')).toBe(true);
    expect(ZIP_LOOP_PORTS.slice(3).every(p => p.side === 'out')).toBe(true);
    expect(portByNumber(10)).toBeUndefined();
    expect(portLabel(3)).toBe('Port 3 (send in)');
  });

  it('matches the live Zip Loop neuron ids', () => {
    const ids = zipLoopIdsFor({ getNeuronCount: () => 6 });
    expect(portByNumber(1)?.neuron).toBe(ids.bit0In);
    expect(portByNumber(2)?.neuron).toBe(ids.bit1In);
    expect(portByNumber(3)?.neuron).toBe(ids.toggleIn);
    expect(portByNumber(4)?.neuron).toBe(ids.bit0Out);
    expect(portByNumber(5)?.neuron).toBe(ids.bit1Out);
    expect(portByNumber(6)?.neuron).toBe(ids.toggleOut);
    expect(portOfNeuron(ids.bit1Out)?.port).toBe(5);
    expect(portOfNeuron(99)).toBeUndefined();
  });

  it('puts questioning on 7, effort on 8 and the questions dial on 9, in the folders the archive uses', () => {
    expect(portByNumber(QUESTIONING_PORT)?.folder).toBe(ZIP_FOLDERS.neurons);
    expect(portByNumber(EFFORT_PORT)?.folder).toBe(ZIP_FOLDERS.effort);
    expect(portByNumber(QUESTION_PORT)?.folder).toBe(ZIP_FOLDERS.questions);
  });

  it('lays a doorway\'s neurons (bit0In, bit1In, bit0Out, bit1Out, toggleIn, toggleOut) onto ports 1-6', () => {
    const p = portsOfDoorway([10, 11, 12, 13, 14, 15]);
    expect(p.map(x => [x.port, x.neuron])).toEqual([[1, 10], [2, 11], [3, 14], [4, 12], [5, 13], [6, 15]]);
    expect(portsOfDoorway([1, 2])).toEqual([]);
  });

  it('counts bits per port', () => {
    expect(bitPort('in', 0)).toBe(1); expect(bitPort('in', 1)).toBe(2);
    expect(bitPort('out', 0)).toBe(4); expect(bitPort('out', 1)).toBe(5);
    expect(sendPort('in')).toBe(3); expect(sendPort('out')).toBe(6);
    let t = 100;
    const tracker = new PortTracker(() => t++);
    tracker.recordBytes('in', new Uint8Array([0b10110000, 0xff]));
    const c = (n: number) => tracker.get(n)!.count;
    expect(c(2)).toBe(3 + 8);       // ones
    expect(c(1)).toBe(16 - 11);     // zeros
    expect(c(3)).toBe(16);          // every bit ticks send in
    expect(c(4) + c(5) + c(6)).toBe(0);
    expect(tracker.get(1)?.lastAt).not.toBeNull();
    expect(tracker.get(4)?.lastAt).toBeNull();
    tracker.record(99); tracker.record(7, 0); tracker.record(7, 1.5);
    expect(c(7)).toBe(0);
    tracker.record(7);
    expect(c(7)).toBe(1);
  });
});
