// Placement rules (old items/*.ts) on the furnished-room fixture: door + window + floor items.

import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { fromDesign, toDesign } from "./design";
import { findOpenings } from "./openings";
import { fitsInRoom, hitWall, placeNew, placeOnWall, rotateToward, settle, surfaceAt } from "./placement";
import { findRooms, roomKey } from "./rooms";
import { buildEdges, nearestSide, wallSides } from "./walls";

const legacy = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/furnished-room.design.json"), "utf8"));
const design = fromDesign(legacy);
const edges = buildEdges(design, findRooms(design));
const sides = wallSides(edges);
const rooms = edges.rooms.map((r) => r.map((e) => e.interiorStart));
const [door, window_, sofa] = design.items;
// r69 model boxes (the fixture's y positions are half their heights).
const DOOR = { x: 97.07, y: 221.58000044, z: 8 };
const WINDOW = { x: 123.1, y: 170.5, z: 14.7 };
const SOFA = { x: 217.2, y: 85.09019848, z: 94.4 };
const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 2);

test("a door re-placed where the old engine left it stays put and faces into the room", () => {
  const edge = nearestSide(sides, { x: door.position.x, y: door.position.z })!;
  const p = placeOnWall(door, DOOR, edge, design.walls[edge.wall], door.position);
  near(p.position.x, door.position.x);
  near(p.position.y, door.position.y); // floor-bound: half its height + 0.01
  near(p.position.z, door.position.z); // in-wall: thickness/2 − 0.5 behind the interior side
  near(Math.cos(p.rotation.y), Math.cos(door.rotation.y));
  near(Math.sin(p.rotation.y), Math.sin(door.rotation.y));
});

test("a window slides along its wall: clamped 1 cm inside the side's ends and the wall's height", () => {
  const edge = nearestSide(sides, { x: window_.position.x, y: window_.position.z })!;
  const wall = design.walls[edge.wall];
  const p = placeOnWall(window_, WINDOW, edge, wall, { x: 600, y: 999, z: 9999 });
  near(p.position.x, window_.position.x); // stays in the wall
  near(p.position.y, wall.height - WINDOW.y / 2 - 1);
  near(Math.max(edge.interiorStart.y, edge.interiorEnd.y) - p.position.z, WINDOW.x / 2 + 1);
  near(p.rotation.y, window_.rotation.y);
});

test("a ray from the room's middle hits the facing wall side, not the one behind it", () => {
  const hit = hitWall({ x: 438, y: 100, z: 55 }, { x: 1, y: 0, z: 0 }, sides, design.walls)!;
  near(hit.point.x, 672.211 - 5);
  expect(hit.edge.wall).toBe(findOpenings(design, edges).find((o) => o.item === 1)!.wall);
  expect(hitWall({ x: 438, y: 100, z: 55 }, { x: 0, y: 1, z: 0 }, sides, design.walls)).toBeNull();
});

test("floor items must stay inside a room without crossing a wall", () => {
  expect(fitsInRoom(sofa, SOFA, sofa.position, rooms)).toBe(true);
  expect(fitsInRoom(sofa, SOFA, { ...sofa.position, x: 2000 }, rooms)).toBe(false);
  expect(fitsInRoom(sofa, SOFA, { ...sofa.position, z: 270 }, rooms)).toBe(false); // back through the wall
});

test("the rotate arrow snaps to right angles within π/16", () => {
  const c = { x: 0, y: 0, z: 0 };
  near(rotateToward(c, { x: 1, y: 0, z: 0.1 }), Math.PI / 2);
  near(rotateToward(c, { x: 1, y: 0, z: 1 }), Math.PI / 4);
  near(Math.abs(rotateToward(c, { x: 0.05, y: 0, z: -1 })), Math.PI);
});

test("settle: a resized floor item rests on the floor, a door pulled into the room goes back to its wall", () => {
  const big = { ...sofa, scale: { x: 1, y: 2, z: 1 } };
  near(settle(big, SOFA, design, sides).position!.y, SOFA.y);
  const loose = { ...door, position: { ...door.position, z: door.position.z - 80 } };
  near(settle(loose, DOOR, design, sides).position!.z, door.position.z);
});

test("an edited design round-trips through the wire format and keeps its door on the same wall", () => {
  const edge = nearestSide(sides, { x: door.position.x, y: door.position.z })!;
  const moved = placeOnWall(door, DOOR, edge, design.walls[edge.wall], { ...door.position, x: 450 });
  const edited = { ...design, items: design.items.map((it, i) => (i === 0 ? { ...it, ...moved } : it)) };
  const back = fromDesign(toDesign(edited));
  expect(back).toEqual(edited);
  expect(toDesign(edited).items[0]).toMatchObject({ xpos: moved.position.x, rotation: moved.rotation.y, product_id: "closed-door", variant_id: "default" });
  expect(findOpenings(back, edges)[0]).toEqual(findOpenings(design, edges)[0]);
});

test("a new floor item sits at the plan's bbox centre, on the floor; a new door in the side nearest the origin", () => {
  const xs = design.corners.map((c) => c.x);
  const ys = design.corners.map((c) => c.y);
  const fresh = { ...sofa, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
  const p = placeNew(fresh, SOFA, design, sides);
  expect(p.position).toEqual({ x: (Math.min(...xs) + Math.max(...xs)) / 2, y: SOFA.y / 2, z: (Math.min(...ys) + Math.max(...ys)) / 2 });

  const d = placeNew({ ...fresh, type: door.type }, DOOR, design, sides);
  const edge = nearestSide(sides, { x: 0, y: 0 })!;
  const mid = { x: (edge.interiorStart.x + edge.interiorEnd.x) / 2, y: (edge.interiorStart.y + edge.interiorEnd.y) / 2 };
  expect(nearestSide(sides, { x: d.position.x, y: d.position.z })).toBe(edge);
  near(d.position.y, DOOR.y / 2 + 0.01); // in-wall-floor: on the floor
  near(Math.hypot(d.position.x - mid.x, d.position.z - mid.y), design.walls[edge.wall].thickness / 2 - 0.5); // centred, in the wall
});

test("a click on no item picks the wall side seen from inside first, then the floor under it", () => {
  const floors = edges.rooms.map((r, i) => ({ key: roomKey(findRooms(design)[i]), poly: r.map((e) => e.interiorStart) }));
  const e = sides[0];
  const mid = { x: (e.interiorStart.x + e.interiorEnd.x) / 2, z: (e.interiorStart.y + e.interiorEnd.y) / 2 };
  const c = rooms[0].reduce((a, p) => ({ x: a.x + p.x / rooms[0].length, y: a.y + p.y / rooms[0].length }), { x: 0, y: 0 });
  // From the room's middle at eye height, look at the side's middle: that wall side.
  const from = { x: c.x, y: 150, z: c.y };
  const toward = { x: mid.x - c.x, y: 0, z: mid.z - c.y };
  expect(surfaceAt(from, toward, sides, design.walls, floors)).toEqual({ kind: "wall", wall: e.wall, front: e.front });
  // Straight down from above the middle: the floor.
  expect(surfaceAt({ x: c.x, y: 500, z: c.y }, { x: 0, y: -1, z: 0 }, sides, design.walls, floors)).toEqual({ kind: "floor", room: floors[0].key });
  // Straight up: nothing.
  expect(surfaceAt(from, { x: 0, y: 1, z: 0 }, sides, design.walls, floors)).toBeNull();
});
