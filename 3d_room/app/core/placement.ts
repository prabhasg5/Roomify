// Where an item may go when it is moved, rotated or resized. Rules from the old items/*.ts:
// floor items stay inside a room (floor_item.ts), wall items slide along one wall side
// (wall_item.ts boundMove/changeWallEdge), the rotate arrow snaps to right angles (item.ts rotate).
// Item-on-item collision is commented out in the old engine, so there is none here either.

import { cutsWall } from "./openings";
import { ItemType, type Design, type PlacedItem, type Point, type Vec3, type Wall } from "./types";
import { nearestSide, type HalfEdge } from "./walls";

/** Floor (1) and on-floor (8) items: dragged on the floor, rotated with the arrow. */
export const isFloorItem = (item: PlacedItem) => item.type === ItemType.Floor || item.type === ItemType.OnFloor;
/** Wall (2), in-wall (3), in-wall-floor (7) and wall-floor (9) items: dragged along a wall side. */
export const isWallItem = (item: PlacedItem) =>
  item.type === ItemType.Wall || cutsWall(item) || item.type === ItemType.WallFloor;
const boundToFloor = (item: PlacedItem) => item.type === ItemType.InWallFloor || item.type === ItemType.WallFloor;

/** A side's frame (old half_edge.ts interiorTransform): u along interiorStart → End, n into the room. */
function frame(e: HalfEdge) {
  const dx = e.interiorEnd.x - e.interiorStart.x;
  const dy = e.interiorEnd.y - e.interiorStart.y;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  const o = e.interiorStart;
  return {
    len,
    /** Interior normal in world (x, z). */
    nx: -uy,
    nz: ux,
    toLocal: (p: Vec3) => ({ u: (p.x - o.x) * ux + (p.z - o.y) * uy, n: -(p.x - o.x) * uy + (p.z - o.y) * ux }),
    toWorld: (u: number, n: number) => ({ x: o.x + u * ux - n * uy, z: o.y + u * uy + n * ux }),
  };
}

/**
 * A wall item moved to `target` on side `edge`: faces into the room, kept 1 cm inside the side's
 * ends and the wall's height, flush with the side (or, for doors/windows, in the wall's middle).
 * @param size the model's bounding-box size before the item's scale.
 */
export function placeOnWall(item: PlacedItem, size: Vec3, edge: HalfEdge, wall: Wall, target: Vec3): Pick<PlacedItem, "position" | "rotation"> {
  const TOL = 1;
  const f = frame(edge);
  const sx = size.x * item.scale.x;
  const sy = size.y * item.scale.y;
  let { u } = f.toLocal(target);
  if (u < sx / 2 + TOL) u = sx / 2 + TOL;
  else if (u > f.len - sx / 2 - TOL) u = f.len - sx / 2 - TOL;
  let y = target.y;
  if (boundToFloor(item)) y = sy / 2 + 0.01;
  else if (y < sy / 2 + TOL) y = sy / 2 + TOL;
  else if (y > wall.height - sy / 2 - TOL) y = wall.height - sy / 2 - TOL;
  // In-wall: the old "fudge factor so it saves to the right wall". On-wall: its back on the side.
  const n = cutsWall(item) ? -wall.thickness / 2 + 0.5 : (size.z * item.scale.z) / 2;
  const { x, z } = f.toWorld(u, n);
  return { position: { x, y, z }, rotation: { ...item.rotation, y: Math.atan2(f.nx, f.nz) } };
}

/** The nearest wall side a ray hits from its interior (old wallEdgePlanes() + filterByNormals). */
export function hitWall(origin: Vec3, dir: Vec3, sides: HalfEdge[], walls: Wall[]): { edge: HalfEdge; point: Vec3 } | null {
  let best: { edge: HalfEdge; point: Vec3 } | null = null;
  let tMin = Infinity;
  for (const e of sides) {
    const f = frame(e);
    const denom = f.nx * dir.x + f.nz * dir.z;
    if (denom >= 0) continue; // seen from behind
    const t = ((e.interiorStart.x - origin.x) * f.nx + (e.interiorStart.y - origin.z) * f.nz) / denom;
    if (t <= 0 || t >= tMin) continue;
    const point = { x: origin.x + t * dir.x, y: origin.y + t * dir.y, z: origin.z + t * dir.z };
    const { u } = f.toLocal(point);
    if (u < 0 || u > f.len || point.y < 0 || point.y > walls[e.wall].height) continue;
    tMin = t;
    best = { edge: e, point };
  }
  return best;
}

/** The item's footprint corners in plan at `at` (old Item.getCorners). */
export function footprint(item: PlacedItem, size: Vec3, at: Vec3): Point[] {
  const hx = (size.x * item.scale.x) / 2;
  const hz = (size.z * item.scale.z) / 2;
  const c = Math.cos(item.rotation.y);
  const s = Math.sin(item.rotation.y);
  return [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]].map(([x, z]) => ({ x: at.x + x * c + z * s, y: at.z - x * s + z * c }));
}

/** Old FloorItem.isValidPosition: centre inside a room, footprint crossing none of its edges. */
export function fitsInRoom(item: PlacedItem, size: Vec3, at: Vec3, rooms: Point[][]): boolean {
  const corners = footprint(item, size, at);
  return rooms.some((room) => pointInPolygon({ x: at.x, y: at.z }, room) && !polygonsCross(corners, room));
}

/** The rotate arrow: yaw that points the item's +z at p, snapped to a right angle within π/16. */
export function rotateToward(center: Vec3, p: Vec3): number {
  const a = Math.atan2(p.x - center.x, p.z - center.z);
  for (let i = -4; i <= 4; i++) if (Math.abs(a - (i * Math.PI) / 2) < Math.PI / 16) return (i * Math.PI) / 2;
  return a;
}

/**
 * Re-seat an item after its size changed (resize, variant swap) or after a free gizmo move:
 * floor items rest on the floor (old FloorItem.resized), wall items go back onto the nearest side.
 */
export function settle(item: PlacedItem, size: Vec3, design: Design, sides: HalfEdge[]): Partial<PlacedItem> {
  if (isFloorItem(item)) return { position: { ...item.position, y: (size.y * item.scale.y) / 2 } };
  const edge = nearestSide(sides, { x: item.position.x, y: item.position.z });
  return edge ? placeOnWall(item, size, edge, design.walls[edge.wall], item.position) : {};
}

// Even-odd ray cast. (The old Utils.pointInPolygon always cast from (0, 0), wrong for rooms around it.)
function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Old Utils.polygonPolygonIntersect: any edge of one crosses any edge of the other. */
function polygonsCross(a: Point[], b: Point[]): boolean {
  const ccw = (p: Point, q: Point, r: Point) => (r.y - p.y) * (q.x - p.x) > (q.y - p.y) * (r.x - p.x);
  const cross = (p1: Point, p2: Point, p3: Point, p4: Point) =>
    ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4);
  return a.some((p, i) => b.some((q, j) => cross(p, a[(i + 1) % a.length], q, b[(j + 1) % b.length])));
}
