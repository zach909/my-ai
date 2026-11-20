/**
 * Weight islands: find the chunks of a network that can be switched off.
 *
 * Take the weights and imagine each one is only a 0 or a 1: a connection is
 * there, or it is not. Most of a trained network's strong connections run
 * between neurons that work together, so once the weak ones are rounded down
 * to 0 the network falls apart into groups of neurons that are wired to each
 * other and to nothing outside. Each group is an island. An island nobody
 * needs for this message can be switched off and the rest of the network does
 * not notice, which is a mixture of experts that makes itself instead of being
 * designed.
 *
 * What this file does, all of it plain arithmetic written here:
 *   1. binarize()          the 0/1 view of a set of weights, at a threshold.
 *   2. partitionIslands()  picks the threshold itself, then finds the islands
 *                          (connected components, union-find) and says how
 *                          clean the split is.
 *   3. describeIslands() / scoreIslands() / planIslands()
 *                          which islands this message needs, and which can run
 *                          or sleep given how much processor to spend.
 *   4. applyIslandLabels() gives each neuron its island's name as a group label.
 *
 * It never changes a weight. The 0/1 view is a COPY made for looking at the
 * network; the real weights are only read. Labelling a neuron with a group
 * changes no wiring either (see OneBrain.setNeuronGroup): a neuron on a
 * sleeping island holds its state and keeps every connection it had.
 *
 * An honest limit: a network wired all-to-all with random weights has no
 * islands, because nothing in it is clustered. The split then comes out with
 * almost none of the weight inside the islands (`insideMass` low) and
 * `partition.ok` is false, and callers must run the whole network. Islands only
 * exist where training has made some connections far stronger than others.
 *
 * Cost: sorting the edges, then one pass of union-find over them,
 * O(E log E). The edge list of a dense mesh is N*N, so this is a job for the
 * background, not for each message; plan against a partition made earlier.
 *
 * Pure functions, no I/O, no library.
 */

export interface WeightEdge {
  from: number;
  to: number;
  weight: number;
}

/** What a mesh node looks like to this file: an id and its outgoing weights (target id to weight). */
export interface NodeLike {
  id: number;
  connections: Map<number, number>;
}

export interface Island {
  /** "island-1", "island-2", ... biggest first; ties go to the island with the lowest neuron id. Stable for the same input. */
  id: string;
  /** Neuron ids, ascending. */
  neurons: number[];
  size: number;
  /** Connections that are 1 in the binary view and run inside this island. */
  links: number;
}

export interface Partition {
  /** True when the split is clean enough to gate on. When false, run the whole network. */
  ok: boolean;
  /** Plain-language account of why it is or is not ok. */
  reason: string;
  islands: Island[];
  /** Neurons in components too small to count as an island. They are treated as core: always on. */
  dust: number[];
  /** A weight counts as 1 when its size is at least this. 0 when there was nothing to split. */
  threshold: number;
  /** Fraction of all connections that are 1 at that threshold. */
  keepFraction: number;
  /** Share of all weight (by size) that lies inside an island. Near 1: clean islands. Near 1/islands: no real structure. */
  insideMass: number;
  nodeCount: number;
  edgeCount: number;
}

export interface PartitionOptions {
  /** A component smaller than this is dust, not an island. At least 2. Default 3. */
  minIslandSize?: number;
  /** The least number of islands that makes a split worth having. Default 2. */
  wantIslands?: number;
  /** The biggest island may hold at most this share of the neurons; a bigger one is not a chunk, it is the network. Default 0.6. */
  maxShare?: number;
  /** The least `insideMass` for the split to count as clean. Default 0.6. */
  minInsideMass?: number;
}

export const DEFAULT_MIN_ISLAND_SIZE = 3;
export const DEFAULT_WANT_ISLANDS = 2;
export const DEFAULT_MAX_SHARE = 0.6;
export const DEFAULT_MIN_INSIDE_MASS = 0.6;

/* ----------------------------------------------------------------- reading */

/** Every connection of every node, as a flat list. Self-connections and non-numbers are left out. */
export function edgesFromNodes(nodes: Iterable<NodeLike>): WeightEdge[] {
  const out: WeightEdge[] = [];
  for (const n of nodes) {
    for (const [to, weight] of n.connections) {
      if (to !== n.id && Number.isFinite(weight)) out.push({ from: n.id, to, weight });
    }
  }
  return out;
}

/**
 * The 0/1 view: the connections that are 1, as [from, to] pairs. A connection is 1 when the size of its weight
 * (sign ignored: a strong negative link still joins two neurons) is at least `threshold`, and a weight of exactly 0
 * is never a connection. Everything else is 0 and is simply not listed. The input is not changed.
 */
export function binarize(edges: readonly WeightEdge[], threshold: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const e of edges) {
    const size = Math.abs(e.weight);
    if (size > 0 && size >= threshold) out.push([e.from, e.to]);
  }
  return out;
}

/* -------------------------------------------------------------- union-find */

class Sets {
  private readonly parent: Int32Array;
  private readonly size: Int32Array;
  /** The biggest set so far. Only ever grows as sets are joined. */
  largest = 1;

  constructor(n: number) {
    this.parent = new Int32Array(n);
    this.size = new Int32Array(n).fill(1);
    for (let i = 0; i < n; i++) this.parent[i] = i;
    if (n === 0) this.largest = 0;
  }

  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[x] !== root) { const next = this.parent[x]; this.parent[x] = root; x = next; }
    return root;
  }

  sizeOf(root: number): number { return this.size[root]; }

  /** Join the sets of a and b. Returns the two sizes joined, or null when they were already one set. */
  join(a: number, b: number): [number, number] | null {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return null;
    if (this.size[ra] < this.size[rb]) { const t = ra; ra = rb; rb = t; }
    const sizes: [number, number] = [this.size[ra], this.size[rb]];
    this.parent[rb] = ra;
    this.size[ra] += this.size[rb];
    if (this.size[ra] > this.largest) this.largest = this.size[ra];
    return sizes;
  }
}

/* --------------------------------------------------------------- partition */

interface Prepared { a: number; b: number; w: number }

/** Strongest first; equal sizes by ids so the result never depends on the order the edges arrived in. */
function strongestFirst(x: Prepared, y: Prepared): number {
  return y.w - x.w || x.a - y.a || x.b - y.b;
}

function emptyPartition(nodeCount: number, edgeCount: number, reason: string): Partition {
  return { ok: false, reason, islands: [], dust: [], threshold: 0, keepFraction: 0, insideMass: 0, nodeCount, edgeCount };
}

/**
 * Choose the 0/1 threshold and find the islands.
 *
 * Raising the threshold only ever removes connections, so islands only ever split, never join. That makes the search
 * one pass: add connections strongest first, and after each group of equal strength note whether the split is useful
 * (at least `wantIslands` real islands, none holding more than `maxShare` of the neurons). Of the useful points it
 * takes the one just above the steepest fall in link strength. Then it measures how much of all the weight stayed
 * inside islands: that, not the count, says whether the islands are real.
 */
export function partitionIslands(nodeIds: readonly number[], edges: readonly WeightEdge[], options: PartitionOptions = {}): Partition {
  const minSize = Math.max(2, Math.floor(options.minIslandSize ?? DEFAULT_MIN_ISLAND_SIZE));
  const want = Math.max(1, Math.floor(options.wantIslands ?? DEFAULT_WANT_ISLANDS));
  const maxShare = Math.min(1, Math.max(0.05, options.maxShare ?? DEFAULT_MAX_SHARE));
  const minInside = Math.min(1, Math.max(0, options.minInsideMass ?? DEFAULT_MIN_INSIDE_MASS));

  const ids = Array.from(new Set(nodeIds)).sort((x, y) => x - y);
  const n = ids.length;
  const index = new Map<number, number>();
  ids.forEach((id, i) => index.set(id, i));

  const list: Prepared[] = [];
  for (const e of edges) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    const w = Math.abs(e.weight);
    if (a === undefined || b === undefined || a === b || !(w > 0) || !Number.isFinite(w)) continue;
    // One undirected link per pair of neurons, whichever way the arrows point; the strongest of the two counts.
    list.push(a < b ? { a, b, w } : { a: b, b: a, w });
  }
  list.sort((x, y) => x.a - y.a || x.b - y.b || y.w - x.w);
  const links: Prepared[] = [];
  for (const e of list) {
    const last = links[links.length - 1];
    if (last && last.a === e.a && last.b === e.b) last.w = Math.max(last.w, e.w);
    else links.push({ ...e });
  }
  links.sort(strongestFirst);

  if (n < minSize * want) return emptyPartition(n, links.length, `only ${n} neurons: too few to split into ${want} islands of ${minSize}`);
  if (links.length === 0) return emptyPartition(n, 0, 'no connections to split on');

  const cap = Math.max(minSize, Math.floor(maxShare * n));
  const sets = new Sets(n);
  let big = 0; // sets with at least minSize neurons
  let bestEnd = -1;
  let bestThreshold = 0;
  let bestDrop = -1;
  let i = 0;
  while (i < links.length) {
    const w = links[i].w;
    let j = i;
    while (j < links.length && links[j].w === w) {
      const joined = sets.join(links[j].a, links[j].b);
      if (joined) {
        const before = (joined[0] >= minSize ? 1 : 0) + (joined[1] >= minSize ? 1 : 0);
        big += (joined[0] + joined[1] >= minSize ? 1 : 0) - before;
      }
      j++;
    }
    if (sets.largest > cap) break; // growing only gets bigger from here
    if (big >= want) {
      // Where to cut: where the weights fall off a cliff. Cutting just above a big drop keeps the strong links that
      // make a chunk and leaves out the weak ones that only tie chunks together. Cutting as low as the size cap
      // allows would glue neighbouring chunks into one. Past the last link the weights fall to nothing: a drop of 1.
      const drop = j < links.length ? 1 - links[j].w / w : 1;
      if (drop >= bestDrop) { bestDrop = drop; bestEnd = j; bestThreshold = w; }
    }
    i = j;
  }
  if (bestEnd < 0) {
    return emptyPartition(n, links.length, `no threshold splits it into ${want} or more islands of ${minSize}+ neurons with none above ${Math.round(maxShare * 100)}% of the network`);
  }

  // Rebuild at the chosen threshold and read the islands off.
  const at = new Sets(n);
  for (let k = 0; k < bestEnd; k++) at.join(links[k].a, links[k].b);
  const byRoot = new Map<number, number[]>();
  for (let k = 0; k < n; k++) {
    const root = at.find(k);
    const members = byRoot.get(root);
    if (members) members.push(ids[k]); else byRoot.set(root, [ids[k]]);
  }
  const groups = Array.from(byRoot.values());
  const real = groups.filter(g => g.length >= minSize).sort((x, y) => y.length - x.length || x[0] - y[0]);
  const dust = groups.filter(g => g.length < minSize).flat().sort((x, y) => x - y);

  const islandOfRoot = new Map<number, number>();
  real.forEach((members, k) => { for (const id of members) islandOfRoot.set(at.find(index.get(id)!), k); });
  const linkCount = new Array<number>(real.length).fill(0);
  for (let k = 0; k < bestEnd; k++) {
    const k2 = islandOfRoot.get(at.find(links[k].a));
    if (k2 !== undefined) linkCount[k2]++;
  }
  let inside = 0;
  let total = 0;
  for (const e of links) {
    total += e.w;
    const ia = islandOfRoot.get(at.find(e.a));
    if (ia !== undefined && ia === islandOfRoot.get(at.find(e.b))) inside += e.w;
  }
  const insideMass = total > 0 ? inside / total : 0;

  const islands: Island[] = real.map((members, k) => ({ id: `island-${k + 1}`, neurons: members, size: members.length, links: linkCount[k] }));
  const clean = insideMass >= minInside;
  return {
    ok: clean,
    reason: clean
      ? `${islands.length} islands, ${Math.round(insideMass * 100)}% of the weight inside them`
      : `the ${islands.length} islands hold only ${Math.round(insideMass * 100)}% of the weight (need ${Math.round(minInside * 100)}%): no real structure, run the whole network`,
    islands,
    dust,
    threshold: bestThreshold,
    keepFraction: bestEnd / links.length,
    insideMass,
    nodeCount: n,
    edgeCount: links.length,
  };
}

/** Read the weights straight off a mesh's nodes and split them. The nodes are only read. */
export function partitionNodes(nodes: Iterable<NodeLike>, options: PartitionOptions = {}): Partition {
  const list = Array.from(nodes);
  return partitionIslands(list.map(n => n.id), edgesFromNodes(list), options);
}

/* ------------------------------------------------------------------ labels */

/** neuron id to the name of the island it is on. Dust is not listed: it has no island, so it stays core. */
export function islandLabels(partition: Partition): Map<number, string> {
  const out = new Map<number, string>();
  if (!partition.ok) return out;
  for (const island of partition.islands) for (const id of island.neurons) out.set(id, island.id);
  return out;
}

/** The part of OneBrain that this needs: a way to label a neuron. Labelling changes no wiring. */
export interface GroupLabeller {
  setNeuronGroup(id: number, group: string): boolean;
}

/** Give each neuron its island's name as a group label. Returns how many neurons were labelled. Nothing is labelled when the split is not ok. */
export function applyIslandLabels(target: GroupLabeller, partition: Partition): number {
  let n = 0;
  for (const [id, group] of islandLabels(partition)) if (target.setNeuronGroup(id, group)) n++;
  return n;
}

/* --------------------------------------------------------------- the plan */

/** An island together with the skill regions (group labels) its neurons also carry: what it is FOR. */
export interface IslandInfo extends Island {
  /** group label to how many of this island's neurons carry it. */
  groups: Record<string, number>;
}

export function describeIslands(partition: Partition, groupsOf: (neuronId: number) => readonly string[]): IslandInfo[] {
  if (!partition.ok) return [];
  return partition.islands.map(island => {
    const groups: Record<string, number> = {};
    for (const id of island.neurons) for (const g of groupsOf(id)) groups[g] = (groups[g] ?? 0) + 1;
    return { ...island, groups };
  });
}

export interface IslandScore {
  id: string;
  /** The best score among the skill regions this island carries; 0 for an island carrying none (nothing says what it is for). */
  relevance: number;
  size: number;
}

/** How much each island is about this message, given a score for each skill region (net-skill-router's `score`). */
export function scoreIslands(infos: readonly IslandInfo[], regionScore: (group: string) => number): IslandScore[] {
  return infos.map(info => {
    let best = 0;
    for (const g of Object.keys(info.groups)) {
      const s = regionScore(g);
      if (Number.isFinite(s) && s > best) best = s;
    }
    return { id: info.id, relevance: best, size: info.size };
  });
}

export interface IslandPlan {
  /** Island ids that compute. These become the tick's `activeGroups`. */
  run: string[];
  /** Island ids that hold still this tick. */
  off: string[];
  total: number;
  runNeurons: number;
  totalNeurons: number;
  /** True when nothing is switched off. */
  ranAll: boolean;
  reason: string;
}

/** Below this an island is not about the message at all. The same bar net-skill-router.ts uses for a region. */
export const MIN_RELEVANCE = 0.08;

export interface PlanOptions {
  /** How much of the processor to spend, 0 to 1: the share of islands that may run. */
  share: number;
  /** Instant: only the one most relevant island. */
  instant?: boolean;
  minRelevance?: number;
}

/**
 * Which islands run.
 *
 * Every island that is about the message runs, whatever the budget, because switching off the right chunk is worse
 * than wasting a little compute. The budget (`share` of all the islands) then adds more, most relevant first and then
 * biggest, so a high share brings in background context and a share of 1 is all of them. If nothing is recognised as
 * relevant, everything runs: with no idea what is needed, gating is a guess. Instant is the one exception to "every
 * relevant island": it keeps just the best one.
 */
export function planIslands(infos: readonly IslandInfo[], scores: readonly IslandScore[], options: PlanOptions): IslandPlan {
  const total = infos.length;
  const totalNeurons = infos.reduce((n, i) => n + i.size, 0);
  const all = (reason: string): IslandPlan => ({ run: infos.map(i => i.id), off: [], total, runNeurons: totalNeurons, totalNeurons, ranAll: true, reason });
  if (total === 0) return { run: [], off: [], total: 0, runNeurons: 0, totalNeurons: 0, ranAll: true, reason: 'no clear islands: the whole network runs' };

  const share = Math.min(1, Math.max(0, Number.isFinite(options.share) ? options.share : 1));
  if (share >= 1 && !options.instant) return all('full processor: every island runs');

  const bar = options.minRelevance ?? MIN_RELEVANCE;
  const byRelevance = [...scores].sort((a, b) => b.relevance - a.relevance || b.size - a.size || a.id.localeCompare(b.id));
  let required = byRelevance.filter(s => s.relevance >= bar);
  if (required.length === 0) return all('nothing recognised as relevant: every island runs, because gating without knowing what is needed is a guess');
  if (options.instant) required = required.slice(0, 1);

  const wanted = options.instant ? 1 : Math.max(1, Math.min(total, Math.ceil(share * total)));
  const chosen = new Set(required.map(s => s.id));
  if (!options.instant) {
    for (const s of byRelevance) {
      if (chosen.size >= wanted) break;
      chosen.add(s.id);
    }
  }
  const run = infos.filter(i => chosen.has(i.id)).map(i => i.id);
  const off = infos.filter(i => !chosen.has(i.id)).map(i => i.id);
  const runNeurons = infos.filter(i => chosen.has(i.id)).reduce((n, i) => n + i.size, 0);
  return {
    run,
    off,
    total,
    runNeurons,
    totalNeurons,
    ranAll: off.length === 0,
    reason: options.instant
      ? 'instant: only the most relevant island runs'
      : `${run.length} of ${total} islands run (${required.length} relevant, budget ${wanted})`,
  };
}
