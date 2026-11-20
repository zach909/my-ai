/**
 * The elements of the world: what each kind of voxel is and how it behaves.
 *
 * `phase` decides the physics: SOLID stays put, POWDER falls and piles,
 * LIQUID flows, GAS is empty space (fire is a gas that burns), PLANT is
 * walk-through. Numbers are in SI units (kg per cubic metre).
 *
 * "Units" of an item are cubic metres of that material, so one voxel always
 * holds (voxel edge)^3 units. That is what keeps wealth the same at any
 * resolution: a coarse world has fewer, bigger voxels, a fine one has more,
 * smaller ones, and a hill holds the same amount of stone either way.
 */

export const M = Object.freeze({
  AIR: 0, BEDROCK: 1, STONE: 2, DIRT: 3, GRASS: 4, SAND: 5, GRAVEL: 6, WATER: 7,
  LAVA: 8, WOOD: 9, LEAVES: 10, ORE: 11, PLANKS: 12, FIRE: 13, BUSH_BARE: 14, BUSH_RIPE: 15,
});

export const PHASE = Object.freeze({ GAS: 0, SOLID: 1, POWDER: 2, LIQUID: 3, PLANT: 4 });

const { GAS, SOLID, POWDER, LIQUID, PLANT } = PHASE;

// [id, name, phase, density kg/m3, flammability 0..1, burn ticks, bodies collide, minable, drops item, glyph]
const DEFS = [
  [M.AIR, 'air', GAS, 1.2, 0, 0, 0, 0, null, ' '],
  [M.BEDROCK, 'bedrock', SOLID, 3000, 0, 0, 1, 0, null, '#'],
  [M.STONE, 'stone', SOLID, 2600, 0, 0, 1, 1, 'stone', '%'],
  [M.DIRT, 'dirt', SOLID, 1500, 0, 0, 1, 1, 'dirt', 'd'],
  [M.GRASS, 'grass', SOLID, 1400, 0.1, 30, 1, 1, 'dirt', '"'],
  [M.SAND, 'sand', POWDER, 1600, 0, 0, 1, 1, 'sand', '.'],
  [M.GRAVEL, 'gravel', POWDER, 1800, 0, 0, 1, 1, 'gravel', ':'],
  [M.WATER, 'water', LIQUID, 1000, 0, 0, 0, 1, 'water', '~'],
  [M.LAVA, 'lava', LIQUID, 2800, 0, 0, 0, 0, null, '^'],
  [M.WOOD, 'wood', SOLID, 600, 0.25, 120, 1, 1, 'wood', 'T'],
  [M.LEAVES, 'leaves', SOLID, 200, 0.8, 40, 1, 1, null, 'o'],
  [M.ORE, 'ore', SOLID, 4500, 0, 0, 1, 1, 'ore', '*'],
  [M.PLANKS, 'planks', SOLID, 650, 0.3, 100, 1, 1, 'planks', '='],
  [M.FIRE, 'fire', GAS, 0.3, 0, 0, 0, 0, null, 'F'],
  [M.BUSH_BARE, 'bush', PLANT, 300, 0.6, 50, 0, 1, 'seed', 'b'],
  [M.BUSH_RIPE, 'ripe bush', PLANT, 300, 0.6, 50, 0, 1, 'seed', 'B'],
];

const N = DEFS.length;
export const MATERIAL_COUNT = N;
export const MATERIAL_NAMES = DEFS.map((d) => d[1]);
export const GLYPH = DEFS.map((d) => d[9]);
export const PHASE_OF = new Uint8Array(N);
export const DENSITY = new Float32Array(N);
export const FLAM = new Float32Array(N);
export const BURN = new Uint8Array(N);
export const BODY_SOLID = new Uint8Array(N);
export const MINABLE = new Uint8Array(N);
/** Voxels that need physics when something next to them changes. */
export const DYNAMIC = new Uint8Array(N);
/** Voxels that count as "something somebody built" for ownership and build reward. */
export const STRUCT = new Uint8Array(N);
export const MATERIAL_ITEM = new Array(N).fill(null);

for (const [id, , phase, density, flam, burn, body, minable, item] of DEFS) {
  PHASE_OF[id] = phase;
  DENSITY[id] = density;
  FLAM[id] = flam;
  BURN[id] = burn;
  BODY_SOLID[id] = body;
  MINABLE[id] = minable;
  MATERIAL_ITEM[id] = item;
  DYNAMIC[id] = phase === POWDER || phase === LIQUID || id === M.FIRE ? 1 : 0;
  STRUCT[id] = id === M.AIR || id === M.FIRE || id === M.BEDROCK || phase === LIQUID ? 0 : 1;
}

export const ITEMS = ['wood', 'planks', 'stone', 'dirt', 'sand', 'gravel', 'ore', 'water', 'berries', 'seed'];
export const ITEM_ID = Object.fromEntries(ITEMS.map((n, i) => [n, i]));
/** What one unit of an item is worth, in the same points as health ("harm points"). */
export const ITEM_VALUE = {
  wood: 8, planks: 12, stone: 5, dirt: 1, sand: 1, gravel: 1, ore: 20, water: 0.5, berries: 12, seed: 15,
};
/** Hunger points one unit of food fills. */
export const NUTRITION = { berries: 40 };
/** Which material an item becomes when placed ("seed" is handled by planting). */
export const ITEM_PLACES = {
  wood: M.WOOD, planks: M.PLANKS, stone: M.STONE, dirt: M.DIRT, sand: M.SAND, gravel: M.GRAVEL, water: M.WATER, ore: M.ORE,
};
