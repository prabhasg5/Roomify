// The 3D scene and its item interaction. Looks are matched to the old r69 engine (three/edge.ts,
// floor.ts, lights.ts, skybox.ts, main.ts centerCamera); interaction to three/controller.ts,
// three/hud.ts, items/*.ts and example.js's TransformGizmo.

import { OrbitControls, TransformControls, useGLTF, useTexture } from "@react-three/drei";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Component, Suspense, useEffect, useMemo, useRef, type ReactNode } from "react";
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { cutsWall, findOpenings, holeRect } from "./core/openings";
import { fitsInRoom, hitWall, isFloorItem, isWallItem, placeOnWall, rotateToward, settle, surfaceAt } from "./core/placement";
import { findRooms, roomKey } from "./core/rooms";
import type { Design, Opening, PlacedItem, Point, Rect, Surface, Vec3, Wall } from "./core/types";
import { buildEdges, nearestSide, wallSides, type Edges, type HalfEdge } from "./core/walls";
import { resolveModel, useViewer, type GizmoMode } from "./store";

/** Derived from the design's walls: rebuilt when walls change, not on item edits. */
interface Plan {
  rooms: string[][];
  edges: Edges;
  sides: HalfEdge[];
  /** Each room's interior polygon. */
  floors: Point[][];
}

/** The item being dragged, as it is right now. Written per pointer move, read per frame, never React state. */
type Live = { index: number; item: PlacedItem } | null;

// The one gizmo on screen, so a click on its handles neither selects nor deselects through it.
let gizmo: { axis: string | null } | null = null;
export const gizmoHot = () => gizmo?.axis != null;

// The wall side or floor under a click that hit no item (set by SurfacePicker, which has the camera).
let picker: ((e: MouseEvent) => Surface | null) | null = null;
export const surfaceUnder = (e: MouseEvent) => picker?.(e) ?? null;

// The scene, for exportGlb (set by Scene). Its children tagged EXPORT are the room.
let stage: THREE.Scene | null = null;
const EXPORT = { export: true };

/** The room as binary glTF: floors, walls (cut-away sides included) and furniture, in metres. */
export async function exportGlb(): Promise<ArrayBuffer> {
  if (!stage) throw new Error("the 3D scene isn't ready");
  const root = new THREE.Group();
  root.name = "room";
  root.scale.setScalar(0.01); // the scene is in cm, glTF in metres
  for (const o of stage.children) if (o.userData.export) root.add(o.clone()); // shares geometry, textures
  root.traverse((o) => {
    delete o.userData.export;
    if (o instanceof THREE.Mesh) o.material = Array.isArray(o.material) ? o.material.map(forExport) : forExport(o.material);
  });
  return (await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: false })) as ArrayBuffer;
}

function forExport(m: THREE.Material): THREE.Material {
  // glTF has no Phong (the exporter would guess metalness 0.5): the floor exports matte.
  if (m instanceof THREE.MeshPhongMaterial) {
    return new THREE.MeshStandardMaterial({ name: m.name, map: m.map, color: m.color, side: m.side, metalness: 0, roughness: 1 });
  }
  // The hover/selection glow is the editor's, not the model's (paint() keeps it 0 otherwise).
  if (m instanceof THREE.MeshStandardMaterial && m.emissive.getHex() !== 0) {
    const c = m.clone();
    c.emissive.setHex(0);
    return c;
  }
  return m;
}

const DEFAULT_FLOOR = { url: "rooms/textures/hardwood.png", scale: 400 };
const fillerMat = new THREE.MeshBasicMaterial({ color: 0xdddddd, side: THREE.DoubleSide });
const sideMat = new THREE.MeshBasicMaterial({ color: 0xcccccc, side: THREE.DoubleSide });
const baseMat = new THREE.MeshBasicMaterial({ color: 0xdddddd, side: THREE.BackSide });

export function Scene() {
  const design = useViewer((s) => s.design);
  const models = useViewer((s) => s.models);
  const selected = useViewer((s) => s.selected);
  const mode = useViewer((s) => s.gizmo);
  const corners = design?.corners;
  const walls = design?.walls;
  const plan = useMemo((): Plan | null => {
    if (!corners || !walls) return null;
    const d = { corners, walls, floorTextures: {}, items: [] };
    const rooms = findRooms(d);
    const edges = buildEdges(d, rooms);
    return { rooms, edges, sides: wallSides(edges), floors: edges.rooms.map((r) => r.map((e) => e.interiorStart)) };
  }, [corners, walls]);
  const openings = useMemo(() => (design && plan ? findOpenings(design, plan.edges) : []), [design, plan]);
  const urls = useMemo(
    () => (design && models ? design.items.map((it) => resolveModel(it, models)) : []),
    [design, models],
  );
  // Per-frame wall visibility (old Edge.updateVisibility), shared with in-wall items.
  const wallVisible = useRef<boolean[]>([]);
  const live = useRef<Live>(null);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    stage = scene;
    return () => { stage = null; };
  }, [scene]);

  return (
    <>
      <Sky />
      {/* r69 lights had no 1/π in the BRDF; three ≥ r155 does, so scale to match. */}
      <hemisphereLight args={[0xffffff, 0x888888, 1.1 * Math.PI]} position={[0, 300, 0]} />
      <OrbitControls makeDefault />
      {design && plan && (
        <>
          <CenterCamera corners={design.corners} />
          <SurfacePicker plan={plan} walls={design.walls} />
          <Report what="floor/wall textures">
            <Suspense fallback={null}>
              {plan.edges.rooms.map((room, i) => (
                <Floor key={i} room={room} texture={design.floorTextures[roomKey(plan.rooms[i])] ?? DEFAULT_FLOOR} />
              ))}
              <Walls design={design} plan={plan} openings={openings} urls={urls} visible={wallVisible} live={live} />
            </Suspense>
          </Report>
          {/* After the catalogue: before it, every item would report "no catalogue GLB". */}
          {models && design.items.map((item, i) => {
            const opening = openings.find((o) => o.item === i);
            return (
              <Report key={`${i}:${urls[i]}`} what={`${item.name} (${urls[i] ?? "no model"})`}>
                {urls[i] ? (
                  <Suspense fallback={null}>
                    <Item
                      index={i} item={item} url={urls[i]} unit={models.units.get(urls[i]) ?? 1} design={design} plan={plan}
                      selected={selected === i} mode={mode} wall={opening?.wall} visible={wallVisible} live={live}
                    />
                  </Suspense>
                ) : (
                  <Throw message={`no catalogue GLB for ${item.productId}/${item.variantId} (model_url ${item.modelUrl})`} />
                )}
              </Report>
            );
          })}
        </>
      )}
    </>
  );
}

/**
 * Old centerCamera(): look at the plan's bbox centre from (0, d, d) above it, d = depth × 1.5.
 * Once per load (Scene is keyed by source), so 2D edits don't throw away the 3D camera.
 */
function CenterCamera({ corners }: { corners: Point[] }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  useEffect(() => {
    if (!controls || !corners.length) return;
    const xs = corners.map((c) => c.x);
    const zs = corners.map((c) => c.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const d = (Math.max(...zs) - Math.min(...zs)) * 1.5;
    controls.target.set(cx, 150, cz);
    camera.position.set(cx, 150 + d, cz + d);
    controls.update();
  }, [controls, camera]); // not corners: on load only
  return null;
}

function SurfacePicker({ plan, walls }: { plan: Plan; walls: Wall[] }) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    const ray = new THREE.Raycaster();
    const floors = plan.floors.map((poly, i) => ({ key: roomKey(plan.rooms[i]), poly }));
    picker = (e) => {
      const r = gl.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      return surfaceAt(ray.ray.origin, ray.ray.direction, plan.sides, walls, floors);
    };
    return () => { picker = null; };
  }, [plan, walls, camera, gl]);
  return null;
}

function Floor({ room, texture }: { room: HalfEdge[]; texture: { url: string; scale: number } }) {
  const map = useTexture(texture.url);
  const geometry = useMemo(() => {
    // As old floor.ts: shape in 1/scale units so the texture repeats every `scale` cm.
    const shape = new THREE.Shape(room.map((e) => new THREE.Vector2(e.interiorStart.x / texture.scale, e.interiorStart.y / texture.scale)));
    return new THREE.ShapeGeometry(shape);
  }, [room, texture.scale]);
  useMemo(() => {
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.colorSpace = THREE.SRGBColorSpace;
  }, [map]);
  return (
    <mesh geometry={geometry} rotation={[Math.PI / 2, 0, 0]} scale={texture.scale} name="floor" userData={EXPORT}>
      <meshPhongMaterial map={map} color={0xcccccc} specular={0x0a0a0a} side={THREE.DoubleSide} />
    </mesh>
  );
}

interface WallsProps {
  design: Design;
  plan: Plan;
  openings: Opening[];
  urls: (string | undefined)[];
  visible: { current: boolean[] };
  live: { current: Live };
}

function Walls({ design, plan, openings, urls, visible, live }: WallsProps) {
  const sizes = useViewer((s) => s.sizes);
  const list = plan.sides;
  const groups = useRef<(THREE.Group | null)[]>([]);
  const meshes = useRef<{ interior: THREE.Mesh; exterior: THREE.Mesh }[]>([]);
  const focus = useMemo(() => new THREE.Vector3(), []);
  // While a door or window is dragged, its old and new walls get rebuilt imperatively; the
  // geometry React gave each mesh is kept to put back when the drag ends.
  const swapped = useRef(new Map<THREE.Mesh, { own: THREE.BufferGeometry; live: THREE.BufferGeometry }>());
  const seen = useRef<{ live: Live; walls: Set<number> }>({ live: null, walls: new Set() });

  // The holes on one side: every opening on its wall, from each item's measured GLB size.
  const holesOn = (e: HalfEdge, start: Point, end: Point, items: PlacedItem[], wallOf: Map<number, number>) =>
    items.flatMap((it, j) => {
      const size = wallOf.get(j) === e.wall && urls[j] ? sizes[urls[j]!] : undefined;
      return size ? [holeRect(it, size, start, end)] : [];
    });
  const wallOf = useMemo(() => new Map(openings.map((o) => [o.item, o.wall])), [openings]);

  useFrame(({ camera }) => {
    const vis = visible.current;
    vis.length = design.walls.length;
    vis.fill(false);
    list.forEach((e, i) => {
      // Old Edge.updateVisibility: show a side only when the camera is on its interior side.
      focus.set((e.interiorStart.x + e.interiorEnd.x) / 2, 0, (e.interiorStart.y + e.interiorEnd.y) / 2);
      const dx = camera.position.x - focus.x;
      const dz = camera.position.z - focus.z;
      const on = -(e.interiorEnd.y - e.interiorStart.y) * dx + (e.interiorEnd.x - e.interiorStart.x) * dz >= 0;
      const g = groups.current[i];
      if (g) g.visible = on;
      if (on) vis[e.wall] = true;
    });

    const l = live.current;
    if (l === seen.current.live) return;
    seen.current.live = l;
    if (!l || !cutsWall(l.item)) {
      for (const [mesh, { own, live: geo }] of swapped.current) {
        if (mesh.geometry === geo) mesh.geometry = own; // React hasn't replaced it yet
        geo.dispose();
      }
      swapped.current.clear();
      seen.current.walls.clear();
      return;
    }
    const items = design.items.map((it, j) => (j === l.index ? l.item : it));
    const liveWallOf = new Map(wallOf);
    const now = nearestSide(list, { x: l.item.position.x, y: l.item.position.z })?.wall;
    if (now === undefined) liveWallOf.delete(l.index);
    else liveWallOf.set(l.index, now);
    // Rebuild the walls it was on, is on, and started on.
    const touched = new Set([...seen.current.walls, now, wallOf.get(l.index)]);
    seen.current.walls = new Set([now ?? -1]);
    list.forEach((e, i) => {
      const m = meshes.current[i];
      if (!m || !touched.has(e.wall)) return;
      const h = design.walls[e.wall].height;
      swap(m.interior, wallPlane(e.interiorStart, e.interiorEnd, h, holesOn(e, e.interiorStart, e.interiorEnd, items, liveWallOf)));
      swap(m.exterior, wallPlane(e.exteriorStart, e.exteriorEnd, h, holesOn(e, e.exteriorStart, e.exteriorEnd, items, liveWallOf)));
    });
  });
  const swap = (mesh: THREE.Mesh, geo: THREE.BufferGeometry) => {
    const prev = swapped.current.get(mesh);
    if (prev) prev.live.dispose();
    swapped.current.set(mesh, { own: prev?.own ?? mesh.geometry, live: geo });
    mesh.geometry = geo;
  };

  return list.map((e, i) => {
    const wall = design.walls[e.wall];
    return (
      <Edge
        key={`${e.wall}${e.front ? "f" : "b"}`}
        edge={e}
        wall={wall}
        interiorHoles={holesOn(e, e.interiorStart, e.interiorEnd, design.items, wallOf)}
        exteriorHoles={holesOn(e, e.exteriorStart, e.exteriorEnd, design.items, wallOf)}
        groupRef={(g) => { groups.current[i] = g; }}
        meshRef={(m) => { meshes.current[i] = m; }}
      />
    );
  });
}

interface EdgeProps {
  edge: HalfEdge;
  wall: Wall;
  interiorHoles: Rect[];
  exteriorHoles: Rect[];
  groupRef: (g: THREE.Group | null) => void;
  meshRef: (m: { interior: THREE.Mesh; exterior: THREE.Mesh }) => void;
}

/** One wall side, as old three/edge.ts: textured interior, filler exterior, top, ends, base. */
function Edge({ edge: e, wall, interiorHoles, exteriorHoles, groupRef, meshRef }: EdgeProps) {
  const tex = e.front ? wall.textures.front : wall.textures.back;
  const loaded = useTexture(tex.url);
  const map = useMemo(() => {
    loaded.colorSpace = THREE.SRGBColorSpace;
    if (tex.stretch) return loaded;
    const t = loaded.clone();
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(dist(e.interiorStart, e.interiorEnd) / tex.scale, wall.height / tex.scale);
    return t;
  }, [loaded, tex, e, wall.height]);

  const g = useMemo(() => ({
    interior: wallPlane(e.interiorStart, e.interiorEnd, wall.height, interiorHoles),
    exterior: wallPlane(e.exteriorStart, e.exteriorEnd, wall.height, exteriorHoles),
    cap: new THREE.ShapeGeometry(new THREE.Shape([e.exteriorStart, e.exteriorEnd, e.interiorEnd, e.interiorStart].map((p) => new THREE.Vector2(p.x, p.y)))),
    start: quad(e.interiorStart, e.exteriorStart, wall.height),
    end: quad(e.interiorEnd, e.exteriorEnd, wall.height),
    // By value: an item edit re-renders every wall, but only walls whose holes changed rebuild.
  }), [e, wall.height, JSON.stringify([interiorHoles, exteriorHoles])]);
  useEffect(() => () => Object.values(g).forEach((x) => x.dispose()), [g]);
  const interior = useRef<THREE.Mesh>(null!);
  const exterior = useRef<THREE.Mesh>(null!);
  useEffect(() => meshRef({ interior: interior.current, exterior: exterior.current }));

  return (
    <>
      <group ref={groupRef} name="wall" userData={EXPORT}>
        <mesh ref={interior} geometry={g.interior}>
          <meshBasicMaterial map={map} />
        </mesh>
        <mesh ref={exterior} geometry={g.exterior} material={fillerMat} />
        <mesh geometry={g.cap} material={fillerMat} rotation={[Math.PI / 2, 0, 0]} position={[0, wall.height, 0]} />
        <mesh geometry={g.start} material={sideMat} />
        <mesh geometry={g.end} material={sideMat} />
      </group>
      {/* The base is always drawn. */}
      <mesh geometry={g.cap} material={baseMat} rotation={[Math.PI / 2, 0, 0]} name="wall base" userData={EXPORT} />
    </>
  );
}

const dist = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

/** A vertical wall plane start → end with holes in its own frame (x along, y up); UVs 0..1. */
function wallPlane(start: Point, end: Point, height: number, holes: Rect[]) {
  const len = dist(start, end);
  const shape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(len, 0), new THREE.Vector2(len, height), new THREE.Vector2(0, height)]);
  for (const h of holes) {
    shape.holes.push(new THREE.Path([
      new THREE.Vector2(h.min.x, h.min.y), new THREE.Vector2(h.max.x, h.min.y),
      new THREE.Vector2(h.max.x, h.max.y), new THREE.Vector2(h.min.x, h.max.y),
    ]));
  }
  const geo = new THREE.ShapeGeometry(shape);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const ux = (end.x - start.x) / len;
  const uz = (end.y - start.y) / len;
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i);
    const v = pos.getY(i);
    uv.setXY(i, u / len, v / height);
    // Shape +z maps to (-uz, 0, ux): the side's interior normal, so FrontSide faces the room.
    pos.setXYZ(i, start.x + ux * u, v, start.y + uz * u);
  }
  geo.computeVertexNormals();
  return geo;
}

function quad(a: Point, b: Point, height: number) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute([a.x, 0, a.y, b.x, 0, b.y, b.x, height, b.y, a.x, height, a.y], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  return geo;
}

interface ItemProps {
  index: number;
  item: PlacedItem;
  url: string;
  /** cm per GLB unit (uploads are stored as uploaded, often in metres). */
  unit: number;
  design: Design;
  plan: Plan;
  selected: boolean;
  mode: GizmoMode;
  /** The wall an in-wall item cuts: it hides when both sides of that wall are hidden. */
  wall?: number;
  visible: { current: boolean[] };
  live: { current: Live };
}

const HOVER = 0x444444; // old item.ts emissiveColor
const ERROR = 0x990000; // old showError glow: the move was refused
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

/**
 * A GLB re-centred on its world bounding box, so `position` is the box centre (old item.ts).
 * Click selects; dragging moves it (floor items on the floor, wall items along a wall side); the
 * arrow rotates floor items; the gizmo moves/rotates/scales. The three.js object moves during a
 * drag; the store gets one updateItem on release.
 */
function Item({ index, item, url, unit, design, plan, selected, mode, wall, visible, live }: ItemProps) {
  const gltf = useGLTF(url);
  const { setSize, select, updateItem } = useViewer.getState();
  const get = useThree((s) => s.get);
  const ref = useRef<THREE.Group>(null!);
  const { object, size, materials } = useMemo(() => {
    const object = gltf.scene.clone(true);
    object.scale.multiplyScalar(unit);
    // Own materials, so highlighting one item doesn't light up every copy of the model.
    const materials: THREE.MeshStandardMaterial[] = [];
    object.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
      for (const m of [o.material].flat()) if ("emissive" in m) materials.push(m);
    });
    // precise: vertex-level, so rotated nodes (sofa-2's Z-up root) don't inflate the box.
    const box = new THREE.Box3().setFromObject(object, true);
    object.position.sub(box.getCenter(new THREE.Vector3()));
    const s = box.getSize(new THREE.Vector3());
    return { object, size: { x: s.x, y: s.y, z: s.z }, materials };
  }, [gltf.scene, unit]);
  useEffect(() => setSize(url, size), [url, size, setSize]);
  useEffect(() => () => materials.forEach((m) => m.dispose()), [materials]);

  const look = useRef({ hover: false, error: false });
  const paint = () => {
    const hex = look.current.error ? ERROR : look.current.hover || selected ? HOVER : 0;
    materials.forEach((m) => m.emissive.setHex(hex));
  };
  useEffect(paint);

  // What the pointer is doing to this item. "free": the arrow was clicked, not dragged, so the
  // item turns with the pointer until the next click (old ROTATING_FREE).
  const drag = useRef<{ kind: "move" | "rotate" | "free"; offset: THREE.Vector3; moved: boolean } | null>(null);
  const handleColor = useMemo(() => new THREE.MeshBasicMaterial({ color: 0xffffff }), []);
  const ray = useMemo(() => new THREE.Raycaster(), []);
  const at = useMemo(() => new THREE.Vector3(), []);

  /** Where the ray meets this item's drag surface: the floor, or for wall items a wall side. */
  const hit = (r: THREE.Ray) => {
    if (isWallItem(item) && drag.current?.kind === "move") {
      const w = hitWall(r.origin, r.direction, plan.sides, design.walls);
      return w && { edge: w.edge, point: new THREE.Vector3(w.point.x, w.point.y, w.point.z) };
    }
    return r.intersectPlane(floorPlane, at) ? { edge: null, point: at.clone() } : null;
  };

  const current = (): PlacedItem => {
    const g = ref.current;
    return {
      ...item,
      position: { x: g.position.x, y: g.position.y, z: g.position.z },
      rotation: { x: g.rotation.x, y: g.rotation.y, z: g.rotation.z },
      scale: { x: g.scale.x, y: g.scale.y, z: g.scale.z },
    };
  };
  const show = (p: Pick<PlacedItem, "position" | "rotation" | "scale">) => {
    ref.current.position.set(p.position.x, p.position.y, p.position.z);
    ref.current.rotation.set(p.rotation.x, p.rotation.y, p.rotation.z);
    ref.current.scale.set(p.scale.x, p.scale.y, p.scale.z);
  };
  const commit = (patch: Pick<PlacedItem, "position" | "rotation" | "scale">) => {
    show(patch); // React may see the same props as before and not re-apply them
    live.current = null;
    updateItem(index, patch);
  };

  const start = (kind: "move" | "rotate", e: ThreeEvent<PointerEvent>) => {
    const controls = get().controls as OrbitControlsImpl | null;
    if (controls) controls.enabled = false;
    drag.current = { kind, offset: new THREE.Vector3(), moved: false };
    const h = hit(e.ray);
    if (kind === "move" && h) drag.current.offset.copy(h.point).sub(ref.current.position);
    if (kind === "rotate") handleColor.color.set(0xf1c40f);
    document.body.style.cursor = kind === "move" ? "move" : "auto";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
  };
  const end = () => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === "rotate" && !d.moved) {
      d.kind = "free";
      // Capture phase, and swallowed: that click only ends the rotation, as in the old app.
      const stop = (ev: PointerEvent) => { ev.stopPropagation(); end(); };
      window.addEventListener("pointerdown", stop, { once: true, capture: true });
      return;
    }
    drag.current = null;
    window.removeEventListener("pointermove", move);
    const controls = get().controls as OrbitControlsImpl | null;
    if (controls) controls.enabled = true;
    handleColor.color.set(0xffffff);
    document.body.style.cursor = look.current.hover ? "pointer" : "auto";
    look.current.error = false; // old clickReleased hides the error glow
    paint();
    if (d.moved) commit(current());
    else live.current = null;
  };
  // Pointer events, not useFrame: a fast drag can start and end inside one frame.
  const move = (ev: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const { gl, camera } = get();
    const r = gl.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), camera);
    const h = hit(ray.ray);
    if (!h) return;
    d.moved = true;
    const g = ref.current;
    if (d.kind !== "move") {
      g.rotation.y = rotateToward(g.position, h.point);
    } else if (h.edge) {
      const target = h.point.sub(d.offset);
      const p = placeOnWall(item, size, h.edge, design.walls[h.edge.wall], target);
      show({ ...p, scale: item.scale });
    } else {
      const target = h.point.sub(d.offset);
      const ok = fitsInRoom(current(), size, target, plan.floors);
      if (ok) g.position.set(target.x, g.position.y, target.z); // keep it on the floor
      if (look.current.error === ok) {
        look.current.error = !ok;
        paint();
      }
    }
    live.current = { index, item: current() };
  };

  useFrame(() => {
    if (wall !== undefined && ref.current) ref.current.visible = visible.current[wall] ?? true;
  });

  const onDown = (e: ThreeEvent<PointerEvent>) => {
    // Right button / Alt go to the camera; hidden in-wall items and gizmo handles aren't hit.
    if (e.button !== 0 || e.altKey || !ref.current.visible || gizmoHot()) return;
    e.stopPropagation();
    select(index);
    if (!item.fixed) start("move", e);
  };

  // Gizmo (example.js TransformGizmo): floor items stay on the floor while it moves them; wall
  // items go back onto their nearest wall side when it lets go; doors move their hole live.
  const onGizmoChange = () => {
    const g = ref.current;
    if (isFloorItem(item)) g.position.y -= new THREE.Box3().setFromObject(g).min.y;
    live.current = { index, item: current() };
  };
  const onGizmoUp = () => {
    const now = current();
    commit(isWallItem(item) ? { ...now, ...settle(now, size, design, plan.sides) } : now);
  };
  const gizmoOn = selected && !item.fixed && (mode !== "rotate" || !isWallItem(item));

  const { position: p, rotation: r, scale: s } = item;
  return (
    <>
      <group
        ref={ref} name={item.name} userData={EXPORT} position={[p.x, p.y, p.z]} rotation={[r.x, r.y, r.z]} scale={[s.x, s.y, s.z]}
        onPointerDown={onDown}
        onPointerOver={(e) => {
          e.stopPropagation();
          look.current.hover = true;
          paint();
          if (!drag.current) document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          look.current.hover = false;
          paint();
          if (!drag.current) document.body.style.cursor = "auto";
        }}
      >
        <primitive object={object} />
      </group>
      {selected && !item.fixed && isFloorItem(item) && (
        <RotateHandle
          target={ref} material={handleColor} rotating={() => !!drag.current}
          radius={Math.max(size.x * s.x, size.z * s.z) / 2 + 1.4 + 20}
          onDown={(e) => {
            if (e.button !== 0 || e.altKey) return;
            e.stopPropagation();
            start("rotate", e);
          }}
        />
      )}
      {gizmoOn && (
        <TransformControls
          ref={(c) => { gizmo = c as unknown as typeof gizmo; }}
          object={ref} mode={mode} size={0.85}
          onObjectChange={onGizmoChange} onMouseUp={onGizmoUp}
        />
      )}
    </>
  );
}

const coneGeo = new THREE.CylinderGeometry(5, 0, 10);
const sphereGeo = new THREE.SphereGeometry(4, 16, 16);

/** Old hud.ts: a line + cone from the item's centre at y = 5, following its yaw. Drag the cone to rotate. */
function RotateHandle({ target, material, rotating, radius, onDown }: {
  target: { current: THREE.Group };
  material: THREE.MeshBasicMaterial;
  rotating: () => boolean;
  radius: number;
  onDown: (e: ThreeEvent<PointerEvent>) => void;
}) {
  const ref = useRef<THREE.Group>(null!);
  const line = useMemo(() => new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, radius)]),
    new THREE.LineBasicMaterial({ color: 0xffffff }),
  ), [radius]);
  useEffect(() => () => line.geometry.dispose(), [line]);
  useFrame(() => {
    const t = target.current;
    if (!t) return;
    ref.current.position.set(t.position.x, 5, t.position.z);
    ref.current.rotation.y = t.rotation.y;
    (line.material as THREE.LineBasicMaterial).color.copy(material.color);
  });
  return (
    <group
      ref={ref} onPointerDown={onDown}
      onPointerOver={() => { material.color.set(0xf1c40f); }}
      onPointerOut={() => { if (!rotating()) material.color.set(0xffffff); }}
    >
      <primitive object={line} />
      <mesh geometry={coneGeo} material={material} position={[0, 0, radius]} rotation={[-Math.PI / 2, 0, 0]} />
      <mesh geometry={sphereGeo} material={material} />
    </group>
  );
}

/** Old skybox.ts: a white → light grey gradient sphere. */
function Sky() {
  const uniforms = useMemo(() => ({
    topColor: { value: new THREE.Color(0xffffff) },
    bottomColor: { value: new THREE.Color(0xe9e9e9) },
    offset: { value: 500 },
  }), []);
  return (
    <mesh>
      <sphereGeometry args={[4000, 32, 15]} />
      <shaderMaterial
        side={THREE.BackSide}
        uniforms={uniforms}
        vertexShader={`varying vec3 vWorldPosition;
void main() {
  vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`}
        fragmentShader={`uniform vec3 topColor;
uniform vec3 bottomColor;
uniform float offset;
varying vec3 vWorldPosition;
void main() {
  float h = normalize(vWorldPosition + offset).y;
  gl_FragColor = vec4(mix(bottomColor, topColor, (h + 1.0) / 2.0), 1.0);
  #include <colorspace_fragment>
}`}
      />
    </mesh>
  );
}

/** Puts a failed load in the UI's error list (or onError) instead of hanging or blanking the canvas. */
export class Report extends Component<{ what: string; children: ReactNode; onError?: (message: string) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    (this.props.onError ?? useViewer.getState().addError)(`${this.props.what}: ${error.message}`);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function Throw({ message }: { message: string }): never {
  throw new Error(message);
}
