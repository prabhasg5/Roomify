// Doors and windows: which wall each one cuts, and the hole it cuts in a wall side.
// Math from the old items/wall_item.ts closestWallEdge() and three/edge.ts makeWall().

import { ItemType, type Design, type Opening, type PlacedItem, type Point, type Rect, type Vec3 } from "./types";
import type { Edges } from "./walls";

export const cutsWall = (item: PlacedItem) => item.type === ItemType.InWall || item.type === ItemType.InWallFloor;

/** Each in-wall item's wall: the one whose interior edge is nearest in plan. */
export function findOpenings(design: Design, edges: Edges): Opening[] {
  const all = edges.walls.flatMap((w) => [w.front, w.back]).filter((e) => e !== null);
  const openings: Opening[] = [];
  design.items.forEach((item, i) => {
    if (!cutsWall(item)) return;
    let best: (typeof all)[number] | undefined;
    let min = Infinity;
    for (const e of all) {
      const d = segmentDistance({ x: item.position.x, y: item.position.z }, e.interiorStart, e.interiorEnd);
      if (d < min) {
        min = d;
        best = e;
      }
    }
    if (best) openings.push({ item: i, wall: best.wall });
  });
  return openings;
}

/**
 * The hole an item cuts in one wall side running start → end, in that side's frame:
 * x = distance along the side from start, y = height above the floor.
 * @param size the model's bounding-box size, before the item's scale.
 */
export function holeRect(item: PlacedItem, size: Vec3, start: Point, end: Point): Rect {
  const len = Math.hypot(end.x - start.x, end.y - start.y);
  const u = ((item.position.x - start.x) * (end.x - start.x) + (item.position.z - start.y) * (end.y - start.y)) / len;
  const hx = (size.x * item.scale.x) / 2;
  const hy = (size.y * item.scale.y) / 2;
  const y = item.position.y;
  return { min: { x: u - hx, y: y - hy }, max: { x: u + hx, y: y + hy } };
}

function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
