// Room detection: the tightest CCW cycles of the wall graph. Algorithm from the old
// model/floorplan.ts findRooms(), with adjacency precomputed and no corner-count guard.

import type { Design, Point } from "./types";
import { angle2pi } from "./walls";

/** Each room as its corner ids, CCW, in the old engine's order. */
export function findRooms(design: Design): string[][] {
  const pos = new Map(design.corners.map((c) => [c.id, c]));
  // Old Corner.adjacentCorners() order: walls starting at the corner, then walls ending there.
  const starts = new Map<string, string[]>(design.corners.map((c) => [c.id, []]));
  const ends = new Map<string, string[]>(design.corners.map((c) => [c.id, []]));
  for (const w of design.walls) {
    starts.get(w.start)!.push(w.end);
    ends.get(w.end)!.push(w.start);
  }
  const adj = new Map(design.corners.map((c) => [c.id, [...starts.get(c.id)!, ...ends.get(c.id)!]]));

  const theta = (prev: Point, cur: Point, next: Point) =>
    angle2pi(prev.x - cur.x, prev.y - cur.y, next.x - cur.x, next.y - cur.y);

  // DFS from first→second back to first, trying the smallest turn first.
  function tightestCycle(first: string, second: string): string[] {
    const stack: { corner: string; prev: string[] }[] = [];
    let next: { corner: string; prev: string[] } | undefined = { corner: second, prev: [first] };
    const visited = new Set([first]);
    while (next) {
      const cur = next.corner;
      visited.add(cur);
      if (cur === first && cur !== second) return next.prev;

      const toVisit = adj.get(cur)!.filter((n) => !visited.has(n) || (n === first && cur !== second));
      const prev = [...next.prev, cur];
      if (toVisit.length > 1) {
        const p = pos.get(next.prev[next.prev.length - 1])!;
        const c = pos.get(cur)!;
        toVisit.sort((a, b) => theta(p, c, pos.get(b)!) - theta(p, c, pos.get(a)!));
      }
      for (const n of toVisit) stack.push({ corner: n, prev });
      next = stack.pop();
    }
    return [];
  }

  const rooms: string[][] = [];
  const seen = new Set<string>();
  for (const first of design.corners) {
    for (const second of adj.get(first.id)!) {
      const loop = tightestCycle(first.id, second);
      if (!loop.length) continue;
      // Same cycle from another start = duplicate. Key: rotation starting at the smallest id.
      let m = 0;
      loop.forEach((id, i) => { if (id < loop[m]) m = i; });
      const key = [...loop.slice(m), ...loop.slice(0, m)].join("-");
      if (seen.has(key)) continue;
      seen.add(key);
      if (!isClockwise(loop.map((id) => pos.get(id)!))) rooms.push(loop);
    }
  }
  return rooms;
}

/** Old Utils.isClockwise (a zero-area loop counts as clockwise). */
export function isClockwise(points: Point[]): boolean {
  let sum = 0;
  points.forEach((p, i) => {
    const q = points[(i + 1) % points.length];
    sum += (q.x - p.x) * (q.y + p.y);
  });
  return sum >= 0;
}
