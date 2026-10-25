// 2D plan edits (old floorplanner rules) on the default and furnished room fixtures.

import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { fromDesign, toDesign } from "./design";
import { cmToMeasure, deleteCorner, deleteWalls, dragCorner, dragWall, drawCorner, merge, moveCorners, snapToAxis, wallLabel } from "./plan";
import { findRooms } from "./rooms";
import type { Design } from "./types";
import { buildEdges } from "./walls";

const read = (name: string) => fromDesign(JSON.parse(fs.readFileSync(path.join(__dirname, `../fixtures/${name}.design.json`), "utf8")));
const room = read("default-room");
const furnished = read("furnished-room");
const edgesOf = (d: Design) => buildEdges(d, findRooms(d));
const at = (d: Design, id: string) => d.corners.find((c) => c.id === id)!;
// default-room: a 467.36 × 467.36 square, walls 71d4→f90d (left), f90d→da02 (top, y=289.052),
// da02→4e3d (right, x=672.211), 4e3d→71d4 (bottom).
const [TL, TR, BR, BL] = ["f90da5e3-9e0e-eba7-173d-eb0b071e838e", "da026c08-d76a-a944-8e7b-096b752da9ed", "4e3d65cb-54c0-0681-28bf-bddcc7bdb571", "71d4f128-ae80-3d58-9bd2-711c6ce6cdf2"];
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("cmToMeasure carries 12 inches into a foot", () => {
  expect(cmToMeasure(212.35)).toBe(`7'0"`); // 83.6": the old one said 6'12"
  expect(cmToMeasure(0)).toBe(`0'0"`);
  expect(cmToMeasure(30.48)).toBe(`1'0"`);
  expect(cmToMeasure(467.36)).toBe(`15'4"`);
  expect(cmToMeasure(209)).toBe(`6'10"`); // same as old wherever old didn't overflow
});

test("snapToAxis takes a neighbour's x or y within 25 cm, later neighbours winning", () => {
  expect(snapToAxis({ x: 110, y: 50 }, [{ x: 100, y: 0 }])).toEqual({ x: 100, y: 50 });
  expect(snapToAxis({ x: 110, y: 50 }, [{ x: 100, y: 0 }, { x: 120, y: 40 }])).toEqual({ x: 120, y: 40 });
  expect(snapToAxis({ x: 130, y: 50 }, [{ x: 100, y: 0 }])).toEqual({ x: 130, y: 50 });
});

test("dragging a corner snaps it to its neighbours and keeps its id", () => {
  const moves = dragCorner(room, TL, { x: 215, y: 400 });
  expect(moves[TL]).toEqual({ x: at(room, BL).x, y: 400 }); // x lines up with BL below it
  const d = moveCorners(room, moves);
  expect(d.corners.map((c) => c.id)).toEqual(room.corners.map((c) => c.id));
  expect(findRooms(d)).toHaveLength(1);
});

test("dragging a wall moves both corners; start snaps, then end", () => {
  const top = room.walls.findIndex((w) => w.start === TL && w.end === TR);
  const moves = dragWall(room, top, { x: 10, y: 100 });
  // x is pulled back to the side walls' corners (within 25 cm); y moves freely.
  expect(moves[TL]).toEqual({ x: at(room, BL).x, y: 389.052 });
  expect(moves[TR]).toEqual({ x: at(room, BR).x, y: 389.052 });
  // Past 25 cm it lets go.
  expect(dragWall(room, top, { x: 30, y: 0 })[TL].x).toBeCloseTo(at(room, TL).x + 30);
});

test("a corner dropped within 20 cm of another merges into it; the one already there keeps its id", () => {
  const d = moveCorners(room, { [TL]: { x: at(room, TR).x - 15, y: at(room, TR).y + 5 } });
  expect(d.corners.map((c) => c.id)).toEqual([TR, BR, BL]);
  expect(at(d, TR)).toEqual(at(room, TR));
  // The top wall collapsed to zero length and went; the left wall now runs BL → TR.
  expect(d.walls.map((w) => `${w.start}>${w.end}`)).toEqual([`${BL}>${TR}`, `${TR}>${BR}`, `${BR}>${BL}`]);
  expect(findRooms(d)).toHaveLength(1); // a triangle
});

test("merging drops a duplicate wall whichever way it runs", () => {
  // A second wall BL→TR beside a diagonal TR→BL: merging a corner onto TR leaves two between TR and BL.
  const extra = { ...room.walls[0], start: TR, end: BL };
  const stray = { id: "s", x: 0, y: 0 };
  const d0: Design = { ...room, corners: [...room.corners, stray], walls: [...room.walls, extra, { ...room.walls[0], start: BL, end: "s" }] };
  const d = merge({ ...d0, corners: d0.corners.map((c) => (c.id === "s" ? { ...c, x: at(room, TR).x + 5, y: at(room, TR).y } : c)) }, "s").design;
  const between = d.walls.filter((w) => [w.start, w.end].sort().join() === [TR, BL].sort().join());
  expect(between).toHaveLength(1);
});

test("a corner dropped on a wall splits it there; the new half copies its textures", () => {
  const custom = { url: "rooms/textures/light_brick.jpg", stretch: false, scale: 100 };
  const d0: Design = { ...room, walls: room.walls.map((w) => (w.start === TL ? { ...w, textures: { front: custom, back: custom } } : w)) };
  const a = drawCorner(d0, null, { x: 400, y: 280 }); // 9 cm below the top wall
  expect(a.done).toBe(false); // the first corner may merge without ending the drawing
  expect(at(a.design, a.id)).toEqual({ id: a.id, x: 400, y: 289.052 });
  expect(a.design.walls).toHaveLength(5);
  expect(a.design.walls[1]).toMatchObject({ start: TL, end: a.id });
  expect(a.design.walls[4]).toMatchObject({ start: a.id, end: TR, textures: { front: custom } });
  expect(findRooms(a.design)[0]).toHaveLength(5);
});

test("drawing a room: clicks add corners and walls, a click on an existing corner closes it and ends drawing", () => {
  let d: Design = { corners: [], walls: [], floorTextures: {}, items: [] };
  let last: string | null = null;
  const ids: string[] = [];
  for (const p of [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 200 }, { x: 0, y: 200 }]) {
    const r = drawCorner(d, last, p);
    expect(r.done).toBe(false);
    d = r.design;
    last = r.id;
    ids.push(r.id);
  }
  const r = drawCorner(d, last, { x: 8, y: -6 }); // within 20 cm of the first
  expect(r.done).toBe(true);
  expect(r.id).toBe(ids[0]);
  d = r.design;
  expect(d.corners.map((c) => c.id)).toEqual(ids);
  ids.forEach((id) => expect(id).toMatch(GUID));
  expect(d.walls.map((w) => [w.start, w.end])).toEqual(ids.map((id, i) => [id, ids[(i + 1) % 4]]));
  expect(d.walls[0]).toMatchObject({ height: 250, thickness: 10, textures: { front: { url: "rooms/textures/wallmap.png" } } });
  expect(findRooms(d)).toHaveLength(1);
});

test("a wall drawn along the wall it started on, landing on it, isn't doubled", () => {
  const a = drawCorner(room, null, { x: 672.211, y: 0 }); // splits the right wall
  const b = drawCorner(a.design, a.id, { x: 672.211, y: 150 }); // lands on its lower half
  expect(b.done).toBe(true);
  const pairs = b.design.walls.map((w) => [w.start, w.end].sort().join());
  expect(new Set(pairs).size).toBe(pairs.length);
  expect(b.design.walls).toHaveLength(6);
  expect(findRooms(b.design)).toHaveLength(1);
});

test("a second click on the last corner ends drawing without a wall", () => {
  const a = drawCorner(room, null, { x: 1000, y: 1000 });
  const b = drawCorner(a.design, a.id, { x: 1005, y: 1000 });
  expect(b.done).toBe(true);
  expect(b.design.walls).toEqual(room.walls);
});

test("deleting a wall deletes the wall items on it, keeps floor items, and only the corners it orphaned", () => {
  const top = furnished.walls.findIndex((w) => w.start === TL && w.end === TR); // the door's wall
  const lone = { id: "lone", x: -500, y: -500 };
  const d0 = { ...furnished, corners: [...furnished.corners, lone] };
  const d = deleteWalls(d0, [top], edgesOf(d0));
  expect(d.walls).toHaveLength(3);
  expect(d.items.map((it) => it.name)).toEqual(furnished.items.slice(1).map((it) => it.name)); // door gone, window kept
  expect(d.corners).toHaveLength(5); // TL/TR still have walls; the lone corner was never the wall's
  expect(findRooms(d)).toHaveLength(0);

  const right = d.walls.findIndex((w) => w.start === TR);
  const d2 = deleteWalls(d, [right], edgesOf(d));
  expect(d2.items.some((it) => it.name === "Window")).toBe(false);
  expect(d2.corners.map((c) => c.id)).toEqual([TL, BR, BL, "lone"]); // TR lost its last wall
});

test("deleting a corner deletes all its walls and itself", () => {
  const d = deleteCorner(furnished, TL, edgesOf(furnished));
  expect(d.corners.map((c) => c.id)).toEqual([TR, BR, BL]);
  expect(d.walls.map((w) => `${w.start}>${w.end}`)).toEqual([`${TR}>${BR}`, `${BR}>${BL}`]);
  expect(d.items.some((it) => it.name === "Closed Door")).toBe(false);
  expect(d.items.some((it) => it.name === "Window")).toBe(true);
});

test("floor textures of rooms that no longer exist are dropped", () => {
  const key = [TL, TR, BR, BL].sort().join(",");
  const d0 = { ...room, floorTextures: { [key]: { url: "rooms/textures/light_fine_wood.jpg", scale: 300 } } };
  expect(moveCorners(d0, { [TL]: { x: 100, y: 300 } }).floorTextures).toEqual(d0.floorTextures);
  expect(deleteWalls(d0, [0], edgesOf(d0)).floorTextures).toEqual({});
});

test("labels read the front side's interior length", () => {
  const edges = edgesOf(room);
  const l = wallLabel(edges, 1);
  expect(l.length).toBeCloseTo(467.36 - 10, 2); // interior: less a thickness
  expect(cmToMeasure(l.length)).toBe(`15'0"`);
});

test("an edited design still writes the legacy shape", () => {
  const d = drawCorner(room, null, { x: 400, y: 280 }).design;
  const legacy = toDesign(d);
  expect(Object.keys(legacy.floorplan.corners)).toHaveLength(5);
  expect(fromDesign(legacy)).toEqual(d);
});
