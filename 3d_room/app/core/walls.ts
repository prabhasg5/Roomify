// Wall half-edges: each wall side's interior/exterior edge, mitred at the corners it shares with
// its neighbours in a room. Math from the old model/half_edge.ts + room.ts updateWalls().

import type { Design, Point } from "./types";

export interface HalfEdge {
  wall: number;
  /** Front runs wall start → end, back runs end → start. */
  front: boolean;
  interiorStart: Point;
  interiorEnd: Point;
  exteriorStart: Point;
  exteriorEnd: Point;
}

export interface Edges {
  /** Each room's own edges, in room-corner order. Interior polygon = their interiorStart. */
  rooms: HalfEdge[][];
  /** The edge on each side of each wall. A later room overwrites an earlier one's side. */
  walls: { front: HalfEdge | null; back: HalfEdge | null }[];
}

/** CCW angle in [0, 2π) from (x1, y1) to (x2, y2). Old Utils.angle2pi. */
export function angle2pi(x1: number, y1: number, x2: number, y2: number): number {
  const t = -Math.atan2(x1 * y2 - y1 * x2, x1 * x2 + y1 * y2);
  return t < 0 ? t + 2 * Math.PI : t;
}

interface Link {
  wall: number;
  front: boolean;
  prev?: Link;
  next?: Link;
}

export function buildEdges(design: Design, rooms: string[][]): Edges {
  const pos = new Map(design.corners.map((c) => [c.id, c]));
  const start = (e: Link) => pos.get(e.front ? design.walls[e.wall].start : design.walls[e.wall].end)!;
  const end = (e: Link) => pos.get(e.front ? design.walls[e.wall].end : design.walls[e.wall].start)!;

  // First wall a→b in wall order (old Corner.wallTo / wallFrom).
  const wallAB = new Map<string, number>();
  design.walls.forEach((w, i) => {
    const k = w.start + ">" + w.end;
    if (!wallAB.has(k)) wallAB.set(k, i);
  });

  const roomLinks = rooms.map((room) => {
    const links = room.map((a, i): Link => {
      const b = room[(i + 1) % room.length];
      const to = wallAB.get(a + ">" + b);
      const from = wallAB.get(b + ">" + a);
      if (to !== undefined) return { wall: to, front: true };
      if (from !== undefined) return { wall: from, front: false };
      throw new Error(`room corners ${a} and ${b} aren't joined by a wall`);
    });
    links.forEach((l, i) => {
      l.next = links[(i + 1) % links.length];
      l.next.prev = l;
    });
    return links;
  });

  // Offset from a corner to the mitred edge corner between v1 and v2 (old halfAngleVector).
  // A missing neighbour is treated as a straight continuation.
  function halfAngle(offset: number, v1: Link | undefined, v2: Link | undefined): Point {
    const v1s = v1 ? start(v1) : { x: 2 * start(v2!).x - end(v2!).x, y: 2 * start(v2!).y - end(v2!).y };
    const v1e = v1 ? end(v1) : start(v2!);
    const v2s = v2 ? start(v2) : end(v1!);
    const v2e = v2 ? end(v2) : { x: 2 * end(v1!).x - start(v1!).x, y: 2 * end(v1!).y - start(v1!).y };

    const theta = angle2pi(v1s.x - v1e.x, v1s.y - v1e.y, v2e.x - v1e.x, v2e.y - v1e.y);
    const cs = Math.cos(theta / 2);
    const sn = Math.sin(theta / 2);
    const dx = v2e.x - v2s.x;
    const dy = v2e.y - v2s.y;
    const vx = dx * cs - dy * sn;
    const vy = dx * sn + dy * cs;
    const scalar = offset / sn / Math.hypot(vx, vy);
    return { x: vx * scalar, y: vy * scalar };
  }

  function toEdge(e: Link): HalfEdge {
    const offset = design.walls[e.wall].thickness / 2;
    const s = start(e);
    const t = end(e);
    const hs = halfAngle(offset, e.prev, e);
    const he = halfAngle(offset, e, e.next);
    return {
      wall: e.wall,
      front: e.front,
      interiorStart: { x: s.x + hs.x, y: s.y + hs.y },
      interiorEnd: { x: t.x + he.x, y: t.y + he.y },
      exteriorStart: { x: s.x - hs.x, y: s.y - hs.y },
      exteriorEnd: { x: t.x - he.x, y: t.y - he.y },
    };
  }

  const edgeRooms = roomLinks.map((links) => links.map(toEdge));
  const walls: Edges["walls"] = design.walls.map(() => ({ front: null, back: null }));
  for (const edge of edgeRooms.flat()) walls[edge.wall][edge.front ? "front" : "back"] = edge;
  // Walls in no room get both sides, unmitred (old assignOrphanEdges).
  walls.forEach((w, i) => {
    if (w.front || w.back) return;
    w.front = toEdge({ wall: i, front: true });
    w.back = toEdge({ wall: i, front: false });
  });
  return { rooms: edgeRooms, walls };
}

/** Every wall side, in wall order (old floorplan.wallEdges()). */
export const wallSides = (edges: Edges): HalfEdge[] => edges.walls.flatMap((w) => [w.front, w.back]).filter((e) => e !== null);

/** The side whose interior edge is nearest to p in plan (old WallItem.closestWallEdge). */
export function nearestSide(sides: HalfEdge[], p: Point): HalfEdge | undefined {
  let best: HalfEdge | undefined;
  let min = Infinity;
  for (const e of sides) {
    const d = segmentDistance(p, e.interiorStart, e.interiorEnd);
    if (d < min) {
      min = d;
      best = e;
    }
  }
  return best;
}

function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
