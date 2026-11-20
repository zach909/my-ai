/**
 * Bodies: anything with a size that moves through the voxel grid (an agent,
 * a falling block). A body is an upright box: x and z are its centre, y is
 * its feet, `hw` is half its width, `h` its height, and `vx vy vz` are in
 * metres per second.
 *
 * Movement is swept in small sub-steps, one axis at a time, so a fast body
 * can never skip through a voxel. The grid can be coarse or fine: collision
 * always tests the real box against whatever voxels are there, which is what
 * makes low resolution feel blocky and high resolution smooth.
 */

const EPS = 1e-6;

/** Does a box at (x, y, z) overlap any voxel that bodies cannot enter? */
export function collides(world, x, y, z, hw, h) {
  const r = world.res;
  const x0 = Math.floor((x - hw) * r + 1e-7), x1 = Math.ceil((x + hw) * r - 1e-7) - 1;
  const y0 = Math.floor(y * r + 1e-7), y1 = Math.ceil((y + h) * r - 1e-7) - 1;
  const z0 = Math.floor((z - hw) * r + 1e-7), z1 = Math.ceil((z + hw) * r - 1e-7) - 1;
  for (let iy = y0; iy <= y1; iy++)
    for (let iz = z0; iz <= z1; iz++)
      for (let ix = x0; ix <= x1; ix++) if (world.isBodySolid(ix, iy, iz)) return true;
  return false;
}

/** Visit every voxel a box overlaps: fn(ix, iy, iz). */
export function forCells(world, x, y, z, hw, h, fn) {
  const r = world.res;
  const x0 = Math.floor((x - hw) * r + 1e-7), x1 = Math.ceil((x + hw) * r - 1e-7) - 1;
  const y0 = Math.floor(y * r + 1e-7), y1 = Math.ceil((y + h) * r - 1e-7) - 1;
  const z0 = Math.floor((z - hw) * r + 1e-7), z1 = Math.ceil((z + hw) * r - 1e-7) - 1;
  for (let iy = y0; iy <= y1; iy++)
    for (let iz = z0; iz <= z1; iz++)
      for (let ix = x0; ix <= x1; ix++) fn(ix, iy, iz);
}

export function overlaps(a, b) {
  return (
    Math.abs(a.x - b.x) < a.hw + b.hw &&
    Math.abs(a.z - b.z) < a.hw + b.hw &&
    a.y < b.y + b.h &&
    b.y < a.y + a.h
  );
}

/**
 * Move one axis by d metres. Returns true if something was in the way.
 * `canStep` lets a walker climb a small ledge instead of stopping at it.
 */
function stepAxis(world, b, axis, d, canStep) {
  if (d === 0) return false;
  const nx = axis === 'x' ? b.x + d : b.x;
  const ny = axis === 'y' ? b.y + d : b.y;
  const nz = axis === 'z' ? b.z + d : b.z;
  if (!collides(world, nx, ny, nz, b.hw, b.h)) {
    b.x = nx; b.y = ny; b.z = nz;
    return false;
  }
  const r = world.res;
  if (axis !== 'y' && canStep && b.step) {
    const su = world.stepHeight;
    if (!collides(world, nx, b.y + su, nz, b.hw, b.h) && !collides(world, b.x, b.y + su, b.z, b.hw, b.h)) {
      b.x = nx; b.z = nz; b.y += su;
      // settle back down onto the ledge so it does not hover
      stepAxis(world, b, 'y', -su, false);
      return false;
    }
  }
  if (axis === 'x') {
    b.x = d > 0 ? Math.floor((b.x + b.hw + d) * r) / r - b.hw - EPS : (Math.floor((b.x - b.hw + d) * r) + 1) / r + b.hw + EPS;
    b.vx = 0;
  } else if (axis === 'z') {
    b.z = d > 0 ? Math.floor((b.z + b.hw + d) * r) / r - b.hw - EPS : (Math.floor((b.z - b.hw + d) * r) + 1) / r + b.hw + EPS;
    b.vz = 0;
  } else if (d > 0) {
    b.y = Math.floor((b.y + b.h + d) * r) / r - b.h - EPS;
    b.vy = 0;
  } else {
    b.y = (Math.floor((b.y + d) * r) + 1) / r + EPS;
    if (b.vy < 0) {
      b.impact = Math.max(b.impact || 0, -b.vy);
      b.vy = 0;
    }
    b.onGround = true;
  }
  return true;
}

/** Integrate a body's position from its velocity over dt seconds. */
export function moveBody(world, b, dt) {
  const canStep = !!b.onGround;
  b.onGround = false;
  b.impact = 0;
  const speed = Math.max(Math.abs(b.vx), Math.abs(b.vy), Math.abs(b.vz));
  const maxStep = Math.min(world.vs * 0.5, 0.25);
  const n = Math.min(48, Math.max(1, Math.ceil((speed * dt) / maxStep)));
  const sdt = dt / n;
  for (let k = 0; k < n; k++) {
    stepAxis(world, b, 'x', b.vx * sdt, canStep || b.onGround);
    stepAxis(world, b, 'z', b.vz * sdt, canStep || b.onGround);
    stepAxis(world, b, 'y', b.vy * sdt, false);
  }
}
