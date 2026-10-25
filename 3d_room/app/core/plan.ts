// 2D plan edits: draw, drag, merge, split and delete corners and walls. Rules from the old
// floorplanner/floorplanner.ts and model/corner.ts, wall.ts, floorplan.ts; where this differs on
// purpose, MODERNIZATION_CONTEXT.md step 6 says why. Every edit is pure: Design in, Design out.

import { DEFAULT_WALL_HEIGHT, DEFAULT_WALL_THICKNESS, defaultWallTexture } from "./design";
import { isWallItem } from "./placement";
import { findRooms, roomKey } from "./rooms";
import type { Design, Point, Wall } from "./types";
import { closestOnSegment, nearestSide, segmentDistance, wallSides, type Edges } from "./walls";

/** A dragged or drawn corner lines up with a neighbour this close on x or y (cm, old snapTolerance). */
export const SNAP_TOLERANCE = 25;
/** A corner this close to another corner or a wall merges into it (cm, old cornerTolerance). */
export const MERGE_TOLERANCE = 20;

/** A new corner id in the old Utils.guid() format. */
export function guid(): string {
  const s4 = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
  return `${s4()}${s4()}-${s4()}-${s4()}-${s4()}-${s4()}${s4()}${s4()}`;
}

/** Corners joined to `id` by a wall: ends of walls starting there, then starts of walls ending there (old adjacentCorners). */
export function neighbours(design: Design, id: string): string[] {
  return [...design.walls.filter((w) => w.start === id).map((w) => w.end), ...design.walls.filter((w) => w.end === id).map((w) => w.start)];
}

/** Old Corner.snapToAxis: take any of `others`' x or y that is within SNAP_TOLERANCE, later ones winning. */
export function snapToAxis(p: Point, others: Point[]): Point {
  let { x, y } = p;
  for (const o of others) {
    if (Math.abs(o.x - x) < SNAP_TOLERANCE) x = o.x;
    if (Math.abs(o.y - y) < SNAP_TOLERANCE) y = o.y;
  }
  return { x, y };
}

const positions = (design: Design) => new Map(design.corners.map((c) => [c.id, { x: c.x, y: c.y }]));

/** Where a corner dragged to `p` goes: snapped to its neighbours. */
export function dragCorner(design: Design, id: string, p: Point): Record<string, Point> {
  const pos = positions(design);
  return { [id]: snapToAxis(p, neighbours(design, id).map((n) => pos.get(n)!)) };
}

/** Where a wall's corners go when it is dragged by `d` from where it was: start snaps, then end. */
export function dragWall(design: Design, index: number, d: Point): Record<string, Point> {
  const { start, end } = design.walls[index];
  const pos = positions(design);
  const s0 = pos.get(start)!;
  const e0 = pos.get(end)!;
  pos.set(start, { x: s0.x + d.x, y: s0.y + d.y });
  pos.set(end, { x: e0.x + d.x, y: e0.y + d.y });
  pos.set(start, snapToAxis(pos.get(start)!, neighbours(design, start).map((n) => pos.get(n)!)));
  pos.set(end, snapToAxis(pos.get(end)!, neighbours(design, end).map((n) => pos.get(n)!)));
  return { [start]: pos.get(start)!, [end]: pos.get(end)! };
}

/** Puts corners where a drag left them, then merges each into whatever it landed on. */
export function moveCorners(design: Design, moves: Record<string, Point>): Design {
  let d: Design = { ...design, corners: design.corners.map((c) => (moves[c.id] ? { ...c, ...moves[c.id] } : c)) };
  for (const id of Object.keys(moves)) {
    if (d.corners.some((c) => c.id === id)) d = merge(d, id).design;
  }
  return tidy(d);
}

/**
 * Old Corner.mergeWithIntersected. A corner within MERGE_TOLERANCE absorbs `id` (and keeps its own
 * id and place); else a wall within it that `id` isn't on is split at `id`'s projection onto it.
 * @returns the corner that is left, and whether anything merged.
 */
export function merge(design: Design, id: string): { design: Design; id: string; merged: boolean } {
  const c = design.corners.find((o) => o.id === id)!;
  const other = design.corners.find((o) => o.id !== id && Math.hypot(o.x - c.x, o.y - c.y) < MERGE_TOLERANCE);
  if (other) {
    const walls = design.walls.map((w) => ({ ...w, start: w.start === id ? other.id : w.start, end: w.end === id ? other.id : w.end }));
    return {
      design: { ...design, corners: design.corners.filter((o) => o !== c), walls: dedupe(walls, other.id) },
      id: other.id,
      merged: true,
    };
  }
  const pos = positions(design);
  const i = design.walls.findIndex((w) => w.start !== id && w.end !== id && segmentDistance(c, pos.get(w.start)!, pos.get(w.end)!) < MERGE_TOLERANCE);
  if (i < 0) return { design, id, merged: false };
  const wall = design.walls[i];
  const p = closestOnSegment(c, pos.get(wall.start)!, pos.get(wall.end)!);
  const walls = [...design.walls];
  walls[i] = { ...wall, end: id };
  walls.push({ ...wall, start: id, textures: structuredClone(wall.textures) });
  // A wall drawn along the wall it then lands on would now be doubled (old kept both).
  return { design: { ...design, corners: design.corners.map((o) => (o === c ? { ...o, ...p } : o)), walls: dedupe(walls, id) }, id, merged: true };
}

/** Drops zero-length walls at `id`, and any later wall joining the same two corners as an earlier one. */
function dedupe(walls: Wall[], id: string): Wall[] {
  const seen = new Set<string>();
  return walls.filter((w) => {
    if (w.start !== id && w.end !== id) return true;
    if (w.start === w.end) return false;
    const other = w.start === id ? w.end : w.start;
    if (seen.has(other)) return false;
    seen.add(other);
    return true;
  });
}

/**
 * A Draw-mode click at `p`: a new corner, a wall to it from `last`, then a merge.
 * @returns the corner to draw on from, and `done` when a merge after the first corner ends drawing.
 */
export function drawCorner(design: Design, last: string | null, p: Point): { design: Design; id: string; done: boolean } {
  const id = guid();
  const walls = last
    ? [...design.walls, { start: last, end: id, height: DEFAULT_WALL_HEIGHT, thickness: DEFAULT_WALL_THICKNESS, textures: { front: defaultWallTexture(), back: defaultWallTexture() } }]
    : design.walls;
  const m = merge({ ...design, corners: [...design.corners, { id, ...p }], walls }, id);
  return { design: tidy(m.design), id: m.id, done: m.merged && last !== null };
}

/** Deletes walls, the wall items hanging on them, and the corners they leave with no wall. */
export function deleteWalls(design: Design, indices: number[], edges: Edges): Design {
  const doomed = new Set(indices);
  // A wall item hangs on the side nearest to it, as when the old app loaded it.
  const sides = wallSides(edges);
  const items = design.items.filter((it) => !(isWallItem(it) && doomed.has(nearestSide(sides, { x: it.position.x, y: it.position.z })?.wall ?? -1)));
  const walls = design.walls.filter((_, i) => !doomed.has(i));
  const used = new Set(walls.flatMap((w) => [w.start, w.end]));
  const touched = new Set(indices.flatMap((i) => [design.walls[i].start, design.walls[i].end]));
  return tidy({ ...design, items, walls, corners: design.corners.filter((c) => used.has(c.id) || !touched.has(c.id)) });
}

/** Deletes a corner and every wall on it (old Corner.removeAll). */
export function deleteCorner(design: Design, id: string, edges: Edges): Design {
  const indices = design.walls.flatMap((w, i) => (w.start === id || w.end === id ? [i] : []));
  const d = deleteWalls(design, indices, edges);
  return { ...d, corners: d.corners.filter((c) => c.id !== id) };
}

/** Drops floor textures of rooms that no longer exist (old updateFloorTextures). */
function tidy(design: Design): Design {
  const keys = new Set(findRooms(design).map(roomKey));
  const floorTextures = Object.fromEntries(Object.entries(design.floorTextures).filter(([k]) => keys.has(k)));
  return { ...design, floorTextures };
}

/** A wall's dimension label: its front side's interior length, else its back's, at that side's midpoint. */
export function wallLabel(edges: Edges, index: number): { at: Point; length: number } {
  const e = (edges.walls[index].front ?? edges.walls[index].back)!;
  return {
    at: { x: (e.interiorStart.x + e.interiorEnd.x) / 2, y: (e.interiorStart.y + e.interiorEnd.y) / 2 },
    length: Math.hypot(e.interiorEnd.x - e.interiorStart.x, e.interiorEnd.y - e.interiorStart.y),
  };
}

/**
 * Old Dimensioning.cmToMeasure in its only configured unit (inches), with the carry fixed: it
 * rounded the inches after taking whole feet, so 83.6" read 6'12". Round once, then split.
 */
export function cmToMeasure(cm: number): string {
  const inches = Math.round(cm * 0.3937);
  return `${Math.floor(inches / 12)}'${inches % 12}"`;
}
