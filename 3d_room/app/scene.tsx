// The read-only 3D scene. Looks are matched to the old r69 engine (three/edge.ts, floor.ts,
// lights.ts, skybox.ts, main.ts centerCamera) so the two can be compared side by side.

import { OrbitControls, useGLTF, useTexture } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { Component, Suspense, useEffect, useMemo, useRef, type ReactNode } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { cutsWall, findOpenings, holeRect } from "./core/openings";
import { findRooms } from "./core/rooms";
import type { Design, Opening, PlacedItem, Point, Rect, Wall } from "./core/types";
import { buildEdges, type HalfEdge } from "./core/walls";
import { resolveModel, useViewer } from "./store";

const DEFAULT_FLOOR = { url: "rooms/textures/hardwood.png", scale: 400 };
const fillerMat = new THREE.MeshBasicMaterial({ color: 0xdddddd, side: THREE.DoubleSide });
const sideMat = new THREE.MeshBasicMaterial({ color: 0xcccccc, side: THREE.DoubleSide });
const baseMat = new THREE.MeshBasicMaterial({ color: 0xdddddd, side: THREE.BackSide });

export function Scene() {
  const design = useViewer((s) => s.design);
  const models = useViewer((s) => s.models);
  const plan = useMemo(() => {
    if (!design) return null;
    const rooms = findRooms(design);
    const edges = buildEdges(design, rooms);
    return { rooms, edges, openings: findOpenings(design, edges) };
  }, [design]);
  const urls = useMemo(
    () => (design && models ? design.items.map((it) => resolveModel(it, models)) : []),
    [design, models],
  );
  // Per-frame wall visibility (old Edge.updateVisibility), shared with in-wall items.
  const wallVisible = useRef<boolean[]>([]);

  return (
    <>
      <Sky />
      {/* r69 lights had no 1/π in the BRDF; three ≥ r155 does, so scale to match. */}
      <hemisphereLight args={[0xffffff, 0x888888, 1.1 * Math.PI]} position={[0, 300, 0]} />
      <OrbitControls makeDefault />
      {design && plan && (
        <>
          <CenterCamera design={design} />
          <Report what="floor/wall textures">
            <Suspense fallback={null}>
              {plan.edges.rooms.map((room, i) => (
                <Floor key={i} room={room} texture={design.floorTextures[[...plan.rooms[i]].sort().join(",")] ?? DEFAULT_FLOOR} />
              ))}
              <Walls design={design} edges={plan.edges.walls} openings={plan.openings} urls={urls} visible={wallVisible} />
            </Suspense>
          </Report>
          {design.items.map((item, i) => {
            const opening = plan.openings.find((o) => o.item === i);
            return (
              <Report key={`${i}:${urls[i]}`} what={`${item.name} (${urls[i] ?? "no model"})`}>
                {urls[i] ? (
                  <Suspense fallback={null}>
                    <Item item={item} url={urls[i]} wall={opening?.wall} visible={wallVisible} />
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

/** Old centerCamera(): look at the plan's bbox centre from (0, d, d) above it, d = depth × 1.5. */
function CenterCamera({ design }: { design: Design }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  useEffect(() => {
    if (!controls || !design.corners.length) return;
    const xs = design.corners.map((c) => c.x);
    const zs = design.corners.map((c) => c.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const d = (Math.max(...zs) - Math.min(...zs)) * 1.5;
    controls.target.set(cx, 150, cz);
    camera.position.set(cx, 150 + d, cz + d);
    controls.update();
  }, [design, controls, camera]);
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
    <mesh geometry={geometry} rotation={[Math.PI / 2, 0, 0]} scale={texture.scale}>
      <meshPhongMaterial map={map} color={0xcccccc} specular={0x0a0a0a} side={THREE.DoubleSide} />
    </mesh>
  );
}

interface WallsProps {
  design: Design;
  edges: { front: HalfEdge | null; back: HalfEdge | null }[];
  openings: Opening[];
  urls: (string | undefined)[];
  visible: { current: boolean[] };
}

function Walls({ design, edges, openings, urls, visible }: WallsProps) {
  const sizes = useViewer((s) => s.sizes);
  const list = useMemo(() => edges.flatMap((w) => [w.front, w.back]).filter((e) => e !== null), [edges]);
  const groups = useRef<(THREE.Group | null)[]>([]);
  const focus = useMemo(() => new THREE.Vector3(), []);

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
  });

  return list.map((e, i) => {
    const holes = (start: Point, end: Point) =>
      openings.flatMap((o) => {
        const size = o.wall === e.wall && urls[o.item] ? sizes[urls[o.item]!] : undefined;
        return size ? [holeRect(design.items[o.item], size, start, end)] : [];
      });
    const wall = design.walls[e.wall];
    return (
      <Edge
        key={`${e.wall}${e.front ? "f" : "b"}`}
        edge={e}
        wall={wall}
        interiorHoles={holes(e.interiorStart, e.interiorEnd)}
        exteriorHoles={holes(e.exteriorStart, e.exteriorEnd)}
        groupRef={(g) => { groups.current[i] = g; }}
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
}

/** One wall side, as old three/edge.ts: textured interior, filler exterior, top, ends, base. */
function Edge({ edge: e, wall, interiorHoles, exteriorHoles, groupRef }: EdgeProps) {
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
  }), [e, wall.height, interiorHoles, exteriorHoles]);
  useEffect(() => () => Object.values(g).forEach((x) => x.dispose()), [g]);

  return (
    <>
      <group ref={groupRef}>
        <mesh geometry={g.interior}>
          <meshBasicMaterial map={map} />
        </mesh>
        <mesh geometry={g.exterior} material={fillerMat} />
        <mesh geometry={g.cap} material={fillerMat} rotation={[Math.PI / 2, 0, 0]} position={[0, wall.height, 0]} />
        <mesh geometry={g.start} material={sideMat} />
        <mesh geometry={g.end} material={sideMat} />
      </group>
      {/* The base is always drawn. */}
      <mesh geometry={g.cap} material={baseMat} rotation={[Math.PI / 2, 0, 0]} />
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
  item: PlacedItem;
  url: string;
  /** The wall an in-wall item cuts: it hides when both sides of that wall are hidden. */
  wall?: number;
  visible: { current: boolean[] };
}

/** A GLB re-centred on its world bounding box, so `position` is the box centre (old item.ts). */
function Item({ item, url, wall, visible }: ItemProps) {
  const gltf = useGLTF(url);
  const setSize = useViewer((s) => s.setSize);
  const ref = useRef<THREE.Group>(null);
  const { object, size } = useMemo(() => {
    const object = gltf.scene.clone(true);
    // precise: vertex-level, so rotated nodes (sofa-2's Z-up root) don't inflate the box.
    const box = new THREE.Box3().setFromObject(object, true);
    object.position.sub(box.getCenter(new THREE.Vector3()));
    return { object, size: box.getSize(new THREE.Vector3()) };
  }, [gltf.scene]);
  useEffect(() => {
    if (cutsWall(item)) setSize(url, { x: size.x, y: size.y, z: size.z });
  }, [item, url, size, setSize]);
  useFrame(() => {
    if (wall !== undefined && ref.current) ref.current.visible = visible.current[wall] ?? true;
  });
  const { position: p, rotation: r, scale: s } = item;
  return (
    <group ref={ref} position={[p.x, p.y, p.z]} rotation={[r.x, r.y, r.z]} scale={[s.x, s.y, s.z]}>
      <primitive object={object} />
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

/** Puts a failed load in the UI's error list instead of hanging or blanking the canvas. */
class Report extends Component<{ what: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    useViewer.getState().addError(`${this.props.what}: ${error.message}`);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function Throw({ message }: { message: string }): never {
  throw new Error(message);
}
