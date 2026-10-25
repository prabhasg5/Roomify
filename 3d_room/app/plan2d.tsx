// The 2D floorplanner, in SVG. Looks and controls from the old floorplanner/floorplanner.ts and
// floorplanner_view.ts; every geometry rule is in core/plan.ts. Pan, zoom and drag previews write
// the DOM through refs; the store gets one editPlan() per edit, on release.

import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type PointerEvent } from "react";
import { cmToMeasure, deleteCorner, deleteWalls, dragCorner, dragWall, drawCorner, moveCorners, neighbours, snapToAxis, wallLabel } from "./core/plan";
import { findRooms } from "./core/rooms";
import type { Design, Point } from "./core/types";
import { buildEdges, type HalfEdge } from "./core/walls";
import { useViewer } from "./store";

type Mode = "move" | "draw" | "delete";

/** Old floorplanner.ts: 15 px per foot before any fit, wheel zoom clamped to 0.02–5 px/cm, fit at 85%. */
const DEFAULT_K = 15 / 30.48;
const MIN_K = 0.02;
const MAX_K = 5;
const FIT_MARGIN = 0.85;
/** Old floorplanner_view.ts: labels shorter than this on screen are skipped; grid spacing. */
const MIN_LABEL_PX = 45;
const GRID_PX = 20;
/** A press that travels further than this (px) pans instead of clicking. */
const CLICK_PX = 3;

type Drag = { walls: number[]; rooms: number[]; from: Point; moves: Record<string, Point> | null };
type Gesture =
  | { kind: "pan"; x: number; y: number; travel: number }
  | ({ kind: "corner"; id: string } & Drag)
  | ({ kind: "wall"; index: number } & Drag);

const pts = (ps: Point[]) => ps.map((p) => `${p.x},${p.y}`).join(" ");
const outline = (e: HalfEdge | null) => (e ? pts([e.interiorStart, e.interiorEnd, e.exteriorEnd, e.exteriorStart]) : "");
const mod = (a: number, n: number) => ((a % n) + n) % n;
const setLine = (l: Element, a: Point, b: Point) => {
  l.setAttribute("x1", String(a.x));
  l.setAttribute("y1", String(a.y));
  l.setAttribute("x2", String(b.x));
  l.setAttribute("y2", String(b.y));
};

export function Floorplanner({ shown }: { shown: boolean }) {
  const design = useViewer((s) => s.design);
  const source = useViewer((s) => s.source);
  const [mode, setMode] = useState<Mode>("move");
  // Bumped per commit: remounts the drawing, so nothing a drag preview wrote to the DOM survives.
  const [rev, bump] = useReducer((n: number) => n + 1, 0);
  const wrap = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const target = useRef<SVGGElement>(null);
  /** World (cm) at the top-left corner, and px per cm. */
  const view = useRef({ x: 0, y: 0, k: DEFAULT_K });
  const needsFit = useRef(true);
  const gesture = useRef<Gesture | null>(null);
  /** Draw mode: the corner the next wall starts from. */
  const last = useRef<string | null>(null);

  const corners = design?.corners;
  const walls = design?.walls;
  const plan = useMemo(() => {
    if (!corners || !walls) return null;
    const d = { corners, walls, floorTextures: {}, items: [] };
    const rooms = findRooms(d);
    return { rooms, edges: buildEdges(d, rooms) };
  }, [corners, walls]);

  /** Writes the view to the DOM: viewBox, px size for CSS, grid offset, which labels fit. */
  const applyView = () => {
    const el = svg.current;
    const w = wrap.current;
    if (!el || !w || !w.clientWidth || !w.clientHeight) return;
    const v = view.current;
    if (needsFit.current) {
      needsFit.current = false;
      fit(v, useViewer.getState().design, w.clientWidth, w.clientHeight);
    }
    el.setAttribute("viewBox", `${v.x} ${v.y} ${w.clientWidth / v.k} ${w.clientHeight / v.k}`);
    el.style.setProperty("--px", String(1 / v.k));
    w.style.backgroundPosition = `${mod(-v.x * v.k, GRID_PX)}px ${mod(-v.y * v.k, GRID_PX)}px`;
    for (const t of el.querySelectorAll<SVGTextElement>(".labels text")) {
      t.style.display = Number(t.dataset.len) * v.k < MIN_LABEL_PX ? "none" : "";
    }
  };

  // A new design: fit it, start in Move mode (old reset()).
  useEffect(() => {
    needsFit.current = true;
    last.current = null;
    setMode("move");
    applyView();
  }, [source]);
  useLayoutEffect(applyView);
  useEffect(() => {
    const el = svg.current!;
    const ro = new ResizeObserver(applyView); // also fires when the tab is shown
    ro.observe(wrap.current!);
    // Old wheel(): ×1.1 per notch, keeping the point under the cursor in place.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = view.current;
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const wx = v.x + px / v.k;
      const wy = v.y + py / v.k;
      v.k = Math.max(MIN_K, Math.min(MAX_K, v.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      v.x = wx - px / v.k;
      v.y = wy - py / v.k;
      applyView();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", onWheel);
    };
  }, []);

  const changeMode = (m: Mode) => {
    last.current = null;
    target.current?.querySelector("line")?.setAttribute("visibility", "hidden");
    setMode(m);
  };
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && changeMode("move");
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown]);

  if (!design || !plan) return <div className="plan2d" ref={wrap} hidden={!shown}><svg ref={svg} /></div>;
  const pos = new Map(design.corners.map((c) => [c.id, c]));

  const commit = (next: Design) => {
    bump();
    useViewer.getState().editPlan(next);
  };
  const world = (e: { clientX: number; clientY: number }): Point => {
    const r = svg.current!.getBoundingClientRect();
    const v = view.current;
    return { x: v.x + (e.clientX - r.left) / v.k, y: v.y + (e.clientY - r.top) / v.k };
  };
  /** Draw mode: the pointer, lined up with the last corner within 25 cm. */
  const drawTarget = (p: Point) => (last.current ? snapToAxis(p, [pos.get(last.current)!]) : p);
  const showTarget = (p: Point) => {
    const [line, dot] = target.current!.children;
    dot.setAttribute("cx", String(p.x));
    dot.setAttribute("cy", String(p.y));
    const from = last.current && pos.get(last.current);
    line.setAttribute("visibility", from ? "visible" : "hidden");
    if (from) setLine(line, from, p);
  };
  /** What a drag of these corners redraws: walls on them or their neighbours (mitres), rooms on them. */
  const dragOf = (ids: string[], from: Point): Drag => {
    const near = new Set(ids.flatMap((id) => [id, ...neighbours(design, id)]));
    return {
      walls: design.walls.flatMap((w, i) => (near.has(w.start) || near.has(w.end) ? [i] : [])),
      rooms: plan.rooms.flatMap((r, i) => (r.some((id) => ids.includes(id)) ? [i] : [])),
      from,
      moves: null,
    };
  };
  const preview = (g: Drag) => {
    const moves = g.moves!;
    const moved = design.corners.map((c) => (moves[c.id] ? { ...c, ...moves[c.id] } : c));
    const at = new Map(moved.map((c) => [c.id, c]));
    const edges = buildEdges({ ...design, corners: moved }, plan.rooms);
    const root = svg.current!;
    for (const i of g.walls) {
      const w = design.walls[i];
      const el = root.querySelector(`[data-wall="${i}"]`)!;
      for (const l of el.querySelectorAll("line")) setLine(l, at.get(w.start)!, at.get(w.end)!);
      const [front, back] = el.querySelectorAll("polygon");
      front.setAttribute("points", outline(edges.walls[i].front));
      back.setAttribute("points", outline(edges.walls[i].back));
      const label = root.querySelector<SVGTextElement>(`[data-label="${i}"]`)!;
      const { at: p, length } = wallLabel(edges, i);
      label.setAttribute("x", String(p.x));
      label.setAttribute("y", String(p.y));
      label.dataset.len = String(length);
      label.firstChild!.nodeValue = cmToMeasure(length); // React's own text node, so React can still update it
      label.style.display = length * view.current.k < MIN_LABEL_PX ? "none" : "";
    }
    for (const i of g.rooms) root.querySelector(`[data-room="${i}"]`)!.setAttribute("points", pts(plan.rooms[i].map((id) => at.get(id)!)));
    for (const [id, p] of Object.entries(moves)) {
      const c = root.querySelector(`[data-corner="${CSS.escape(id)}"]`)!;
      c.setAttribute("cx", String(p.x));
      c.setAttribute("cy", String(p.y));
    }
  };

  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const hit = e.target as Element;
    const cornerEl = hit.closest("[data-corner]");
    const wallEl = hit.closest("[data-wall]");
    const corner = cornerEl?.getAttribute("data-corner");
    const wall = wallEl ? Number(wallEl.getAttribute("data-wall")) : undefined;
    svg.current!.setPointerCapture(e.pointerId);
    if (mode === "delete") {
      if (corner != null) return commit(deleteCorner(design, corner, plan.edges));
      if (wall !== undefined) return commit(deleteWalls(design, [wall], plan.edges));
      changeMode("move");
    } else if (mode === "move" && corner != null) {
      cornerEl!.classList.add("active");
      gesture.current = { kind: "corner", id: corner, ...dragOf([corner], world(e)) };
      return;
    } else if (mode === "move" && wall !== undefined) {
      wallEl!.classList.add("active");
      const w = design.walls[wall];
      gesture.current = { kind: "wall", index: wall, ...dragOf([w.start, w.end], world(e)) };
      return;
    }
    gesture.current = { kind: "pan", x: e.clientX, y: e.clientY, travel: 0 };
  };

  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    if (mode === "draw") showTarget(drawTarget(world(e)));
    if (!g) return;
    if (g.kind === "pan") {
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      g.x = e.clientX;
      g.y = e.clientY;
      g.travel += Math.hypot(dx, dy);
      if (g.travel <= CLICK_PX) return;
      view.current.x -= dx / view.current.k;
      view.current.y -= dy / view.current.k;
      applyView();
      return;
    }
    const p = world(e);
    g.moves = g.kind === "corner" ? dragCorner(design, g.id, p) : dragWall(design, g.index, { x: p.x - g.from.x, y: p.y - g.from.y });
    preview(g);
  };

  const onPointerUp = (e: PointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.kind === "pan") {
      if (mode !== "draw" || g.travel > CLICK_PX) return;
      const r = drawCorner(design, last.current, drawTarget(world(e)));
      commit(r.design);
      if (r.done) changeMode("move");
      else last.current = r.id;
    } else if (g.moves) {
      commit(moveCorners(design, g.moves));
    } else {
      svg.current!.querySelector(".active")?.classList.remove("active");
    }
  };
  const onPointerCancel = () => {
    if (gesture.current && gesture.current.kind !== "pan") bump(); // drop the preview
    gesture.current = null;
  };

  return (
    <div className={`plan2d ${mode}`} ref={wrap} hidden={!shown}>
      <svg ref={svg} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}>
        <g key={rev}>
          <g className="rooms">
            {plan.rooms.map((r, i) => <polygon key={i} data-room={i} points={pts(r.map((id) => pos.get(id)!))} />)}
          </g>
          <g className="walls">
            {design.walls.map((w, i) => {
              const a = pos.get(w.start)!;
              const b = pos.get(w.end)!;
              return (
                <g key={i} className="wall" data-wall={i}>
                  <line className="line" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
                  <polygon className="edge" points={outline(plan.edges.walls[i].front)} />
                  <polygon className="edge" points={outline(plan.edges.walls[i].back)} />
                  <line className="hit" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
                </g>
              );
            })}
          </g>
          <g className="corners">
            {design.corners.map((c) => <circle key={c.id} data-corner={c.id} cx={c.x} cy={c.y} />)}
          </g>
          <g className="labels">
            {design.walls.map((_, i) => {
              const { at, length } = wallLabel(plan.edges, i);
              return <text key={i} data-label={i} data-len={length} x={at.x} y={at.y}>{cmToMeasure(length)}</text>;
            })}
          </g>
        </g>
        <g className="target" ref={target}>
          <line visibility="hidden" />
          <circle />
        </g>
      </svg>
      <div className="tools" role="group" aria-label="2D mode">
        <button aria-pressed={mode === "move"} onClick={() => changeMode("move")}>Move Walls</button>
        <button aria-pressed={mode === "draw"} onClick={() => changeMode("draw")}>Draw Walls</button>
        <button aria-pressed={mode === "delete"} onClick={() => changeMode("delete")}>Delete Walls</button>
      </div>
      {mode === "draw" && <div className="hint">Press the "Esc" key to stop drawing walls</div>}
    </div>
  );
}

/** Old fitView() + resetOrigin(): the corners' bbox at 85% of the view, centred. */
function fit(v: { x: number; y: number; k: number }, design: Design | null, w: number, h: number) {
  const xs = design?.corners.map((c) => c.x) ?? [];
  const ys = design?.corners.map((c) => c.y) ?? [];
  let cx = 0;
  let cy = 0;
  if (xs.length) {
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    if (x1 > x0 && y1 > y0) v.k = Math.max(MIN_K, Math.min(MAX_K, Math.min((w * FIT_MARGIN) / (x1 - x0), (h * FIT_MARGIN) / (y1 - y0))));
    cx = (x0 + x1) / 2;
    cy = (y0 + y1) / 2;
  }
  v.x = cx - w / 2 / v.k;
  v.y = cy - h / 2 / v.k;
}
