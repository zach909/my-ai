/** Plain-text views of the world, for looking at a run in a terminal. */
import { GLYPH, M } from './materials.mjs';

const TAGS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Top-down map: the highest block in each column, agents as letters. */
export function renderTop(sim, maxCols = 64) {
  const w = sim.world;
  const step = Math.max(1, Math.ceil(w.nx / maxCols));
  const who = new Map();
  for (const a of sim.agents.values()) {
    if (a.alive) who.set(`${Math.floor(w.cell(a.x) / step)},${Math.floor(w.cell(a.z) / step)}`, TAGS[(a.id - 1) % 26]);
  }
  const rows = [];
  for (let iz = 0; iz < w.nz; iz += step) {
    let row = '';
    for (let ix = 0; ix < w.nx; ix += step) {
      const tag = who.get(`${Math.floor(ix / step)},${Math.floor(iz / step)}`);
      if (tag) { row += tag; continue; }
      let m = M.AIR;
      for (let iy = w.ny - 1; iy >= 0; iy--) {
        m = w.mat[w.idx(ix, iy, iz)];
        if (m !== M.AIR) break;
      }
      row += GLYPH[m];
    }
    rows.push(row);
  }
  return rows.join('\n');
}

/** Side view: a slice of the world at z = iz, x across, y up. */
export function renderSide(sim, iz, maxCols = 64) {
  const w = sim.world;
  const step = Math.max(1, Math.ceil(w.nx / maxCols));
  const rows = [];
  for (let iy = w.ny - 1; iy >= 0; iy -= step) {
    let row = '';
    for (let ix = 0; ix < w.nx; ix += step) row += GLYPH[w.mat[w.idx(ix, iy, iz)]];
    rows.push(row);
  }
  return rows.join('\n');
}
