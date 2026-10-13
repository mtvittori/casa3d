// Estrazione deterministica di muri e stanze da un'immagine di planimetria.
// Pipeline: scala di grigi → soglia (Otsu) → apertura morfologica (toglie testo e linee sottili)
// → rettangoli orizzontali/verticali di pixel scuri = muri → chiusura porte → flood fill = stanze.

import { FloorPlan, Point, Room, Wall, emptyPlan, polygonArea, uid } from './model';

export interface RasterImage {
  width: number;
  height: number;
  /** RGBA, come `ImageData.data`. */
  data: Uint8ClampedArray;
}

export interface DetectOptions {
  /** Soglia 0-255; se assente viene calcolata con Otsu. */
  threshold?: number;
  /** Spessore minimo di un muro in px: tratti più sottili (testo, quote) vengono scartati. */
  minThickness?: number;
  /** Spessore massimo di un muro in px. */
  maxThickness?: number;
  /** Lunghezza minima di un muro in px. */
  minLength?: number;
  /** Larghezza massima di una porta in px (i varchi più piccoli vengono chiusi per separare le stanze). */
  maxDoorWidth?: number;
  /** Area minima di una stanza in px². */
  minRoomArea?: number;
}

export interface DetectResult {
  plan: FloorPlan;
  threshold: number;
  /** Maschera dei muri dopo il filtraggio (1 = muro), utile per l'anteprima. */
  wallMask: Uint8Array;
}

export function toGray(img: RasterImage): Uint8Array {
  const { width, height, data } = img;
  const g = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const a = data[i * 4 + 3] / 255;
    // pixel trasparenti = sfondo bianco
    const lum = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    g[i] = Math.round(lum * a + 255 * (1 - a));
  }
  return g;
}

export function otsu(gray: Uint8Array): number {
  const hist = new Array<number>(256).fill(0);
  for (const v of gray) hist[v]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  return thr;
}

/** Erosione o dilatazione con un quadrato di lato k, separabile (prima righe poi colonne). */
function morph(mask: Uint8Array, w: number, h: number, k: number, erode: boolean): Uint8Array {
  if (k <= 1) return mask.slice();
  const r1 = Math.floor((k - 1) / 2);
  const r2 = k - 1 - r1;
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  const target = erode ? 0 : 1; // basta un pixel "target" nella finestra per imporlo (fuori immagine = neutro)
  for (let y = 0; y < h; y++) {
    // conteggio scorrevole dei pixel target nella finestra
    let count = 0;
    const row = y * w;
    for (let x = -r1; x <= r2 - 1 && x < w; x++) if (x >= 0 && mask[row + x] === target) count++;
    for (let x = 0; x < w; x++) {
      const add = x + r2;
      if (add < w && mask[row + add] === target) count++;
      tmp[row + x] = count > 0 ? target : 1 - target;
      const rem = x - r1;
      if (rem >= 0 && mask[row + rem] === target) count--;
    }
  }
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = -r1; y <= r2 - 1 && y < h; y++) if (y >= 0 && tmp[y * w + x] === target) count++;
    for (let y = 0; y < h; y++) {
      const add = y + r2;
      if (add < h && tmp[add * w + x] === target) count++;
      out[y * w + x] = count > 0 ? target : 1 - target;
      const rem = y - r1;
      if (rem >= 0 && tmp[rem * w + x] === target) count--;
    }
  }
  return out;
}

interface Rect {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

/**
 * Trova i rettangoli formati da run orizzontali di pixel a 1, lunghi almeno `minLen`,
 * impilati su righe consecutive con estremi simili.
 */
function horizontalRects(mask: Uint8Array, w: number, h: number, minLen: number, tol: number): Rect[] {
  const done: Rect[] = [];
  let active: Rect[] = [];
  for (let y = 0; y < h; y++) {
    const next: Rect[] = [];
    let x = 0;
    while (x < w) {
      if (!mask[y * w + x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < w && mask[y * w + x]) x++;
      const end = x - 1;
      if (end - start + 1 < minLen) continue;
      const i = active.findIndex((r) => Math.abs(r.x1 - start) <= tol && Math.abs(r.x2 - end) <= tol);
      if (i >= 0) {
        const r = active.splice(i, 1)[0];
        r.y2 = y;
        r.x1 = Math.min(r.x1, start);
        r.x2 = Math.max(r.x2, end);
        next.push(r);
      } else {
        next.push({ x1: start, x2: end, y1: y, y2: y });
      }
    }
    done.push(...active);
    active = next;
  }
  done.push(...active);
  return done;
}

function transpose(mask: Uint8Array, w: number, h: number): Uint8Array {
  const t = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) t[x * h + y] = mask[y * w + x];
  return t;
}

export function detect(img: RasterImage, opts: DetectOptions = {}): DetectResult {
  const { width: w, height: h } = img;
  const diag = Math.hypot(w, h);
  const minT = opts.minThickness ?? Math.max(3, Math.round(diag / 400));
  const maxT = opts.maxThickness ?? Math.max(minT * 6, Math.round(diag / 40));
  const minLen = opts.minLength ?? Math.max(minT * 3, Math.round(diag / 60));
  const minRoomArea = opts.minRoomArea ?? (diag / 25) ** 2;

  const gray = toGray(img);
  const threshold = opts.threshold ?? otsu(gray);
  let mask: Uint8Array = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i++) mask[i] = gray[i] <= threshold ? 1 : 0;

  // Apertura: elimina tutto ciò che è più sottile di minT.
  mask = morph(morph(mask, w, h, minT, true), w, h, minT, false);

  const tol = Math.max(2, Math.round(minT / 2));
  const walls: Wall[] = [];
  for (const r of horizontalRects(mask, w, h, minLen, tol)) {
    const t = r.y2 - r.y1 + 1;
    if (t < minT || t > maxT) continue;
    const y = (r.y1 + r.y2 + 1) / 2;
    walls.push({ id: uid('w'), a: { x: r.x1, y }, b: { x: r.x2 + 1, y }, thickness: t });
  }
  for (const r of horizontalRects(transpose(mask, w, h), h, w, minLen, tol)) {
    // nel trasposto x↔y
    const t = r.y2 - r.y1 + 1;
    if (t < minT || t > maxT) continue;
    const x = (r.y1 + r.y2 + 1) / 2;
    walls.push({ id: uid('w'), a: { x, y: r.x1 }, b: { x, y: r.x2 + 1 }, thickness: t });
  }

  const plan = emptyPlan(w, h);
  plan.walls = walls;
  if (walls.length) {
    const ts = walls.map((x) => x.thickness).sort((a, b) => a - b);
    const median = ts[Math.floor(ts.length / 2)];
    // ipotesi: muro tipico ~20 cm. Si ricalibra dall'editor.
    plan.scale = Math.max(5, median / 0.2);
  }
  // varchi (porte, finestre disegnate a tratto sottile) fino a ~2,5 m o 1/10 della diagonale
  const maxDoor = opts.maxDoorWidth ?? Math.round(Math.max(diag / 10, 2.5 * plan.scale));
  plan.rooms = detectRooms(plan, maxDoor, minRoomArea);
  return { plan, threshold, wallMask: mask };
}

/** Rasterizza i muri su una griglia di celle `cell` px. */
function rasterWalls(plan: FloorPlan, cell: number, gw: number, gh: number): Uint8Array {
  const g = new Uint8Array(gw * gh);
  for (const wall of plan.walls) {
    const half = wall.thickness / 2;
    const x1 = Math.min(wall.a.x, wall.b.x) - (wall.a.y === wall.b.y ? 0 : half);
    const x2 = Math.max(wall.a.x, wall.b.x) + (wall.a.y === wall.b.y ? 0 : half);
    const y1 = Math.min(wall.a.y, wall.b.y) - (wall.a.x === wall.b.x ? 0 : half);
    const y2 = Math.max(wall.a.y, wall.b.y) + (wall.a.x === wall.b.x ? 0 : half);
    if (wall.a.x !== wall.b.x && wall.a.y !== wall.b.y) {
      // muro obliquo: campionamento lungo l'asse
      const len = Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y);
      const steps = Math.ceil(len / (cell / 2));
      for (let s = 0; s <= steps; s++) {
        const px = wall.a.x + ((wall.b.x - wall.a.x) * s) / steps;
        const py = wall.a.y + ((wall.b.y - wall.a.y) * s) / steps;
        for (let dy = -half; dy <= half; dy += cell / 2)
          for (let dx = -half; dx <= half; dx += cell / 2) setCell(g, gw, gh, (px + dx) / cell, (py + dy) / cell);
      }
      continue;
    }
    for (let cy = Math.floor(y1 / cell); cy <= Math.floor((y2 - 0.001) / cell); cy++)
      for (let cx = Math.floor(x1 / cell); cx <= Math.floor((x2 - 0.001) / cell); cx++) setCell(g, gw, gh, cx, cy);
  }
  return g;
}

function setCell(g: Uint8Array, gw: number, gh: number, fx: number, fy: number) {
  const x = Math.floor(fx);
  const y = Math.floor(fy);
  if (x >= 0 && y >= 0 && x < gw && y < gh) g[y * gw + x] = 1;
}

/**
 * Trova le stanze come regioni libere chiuse dai muri.
 * I varchi delle porte vengono chiusi prolungando ogni estremità di muro fino a `maxDoor` px
 * se incontra un altro muro.
 */
export function detectRooms(plan: FloorPlan, maxDoor: number, minRoomArea: number): Room[] {
  const cell = Math.max(2, Math.round(Math.min(...plan.walls.map((w) => w.thickness), 8) / 2));
  const gw = Math.ceil(plan.width / cell);
  const gh = Math.ceil(plan.height / cell);
  const blocked = rasterWalls(plan, cell, gw, gh);
  const base = blocked.slice();

  // chiusura porte
  for (const wall of plan.walls) {
    const len = Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y);
    if (len === 0) continue;
    const ux = (wall.b.x - wall.a.x) / len;
    const uy = (wall.b.y - wall.a.y) / len;
    const halfCells = Math.max(0, Math.floor(wall.thickness / 2 / cell));
    for (const [p, dx, dy] of [
      [wall.b, ux, uy],
      [wall.a, -ux, -uy],
    ] as const) {
      const path: number[] = [];
      let hit = false;
      // campiona ogni mezza cella partendo dall'estremità; i primi campioni possono cadere nel muro stesso
      for (let d = cell / 2; d <= maxDoor; d += cell / 2) {
        const cx = Math.floor((p.x + dx * d) / cell);
        const cy = Math.floor((p.y + dy * d) / cell);
        if (cx < 0 || cy < 0 || cx >= gw || cy >= gh) break;
        const idx = cy * gw + cx;
        if (base[idx]) {
          if (d <= cell) continue;
          hit = true;
          break;
        }
        if (path[path.length - 1] !== idx) path.push(idx);
      }
      if (!hit) continue;
      for (const idx of path) {
        const cx = idx % gw;
        const cy = Math.floor(idx / gw);
        for (let o = -halfCells; o <= halfCells; o++) {
          // spessore perpendicolare alla direzione del muro
          const ox = Math.round(cx + -dy * o);
          const oy = Math.round(cy + dx * o);
          if (ox >= 0 && oy >= 0 && ox < gw && oy < gh) blocked[oy * gw + ox] = 1;
        }
      }
    }
  }

  // flood fill delle regioni libere
  const label = new Int32Array(gw * gh).fill(-1);
  const rooms: Room[] = [];
  const stack: number[] = [];
  let n = 0;
  for (let start = 0; start < gw * gh; start++) {
    if (blocked[start] || label[start] !== -1) continue;
    const cells: number[] = [];
    let touchesBorder = false;
    stack.push(start);
    label[start] = n;
    while (stack.length) {
      const i = stack.pop()!;
      cells.push(i);
      const x = i % gw;
      const y = (i - x) / gw;
      if (x === 0 || y === 0 || x === gw - 1 || y === gh - 1) touchesBorder = true;
      const nb = [x > 0 ? i - 1 : -1, x < gw - 1 ? i + 1 : -1, y > 0 ? i - gw : -1, y < gh - 1 ? i + gw : -1];
      for (const j of nb) {
        if (j >= 0 && !blocked[j] && label[j] === -1) {
          label[j] = n;
          stack.push(j);
        }
      }
    }
    if (!touchesBorder && cells.length * cell * cell >= minRoomArea) {
      const poly = tracePolygon(label, gw, gh, n).map((p) => ({ x: p.x * cell, y: p.y * cell }));
      if (poly.length >= 3 && polygonArea(poly) >= minRoomArea) {
        rooms.push({ id: uid('r'), name: `Stanza ${rooms.length + 1}`, polygon: poly, entities: [] });
      }
    }
    n++;
  }
  return rooms;
}

/** Contorno esterno (rettilineo) della regione `id` sulla griglia, con vertici collineari rimossi. */
function tracePolygon(label: Int32Array, gw: number, gh: number, id: number): Point[] {
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < gw && y < gh && label[y * gw + x] === id;
  // Lati di bordo orientati (cella dentro a sinistra), indicizzati per vertice di partenza.
  const edges = new Map<string, Point[]>();
  const add = (ax: number, ay: number, bx: number, by: number) => {
    const k = `${ax},${ay}`;
    const list = edges.get(k) ?? [];
    list.push({ x: bx, y: by });
    edges.set(k, list);
  };
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (!inside(x, y)) continue;
      if (!inside(x, y - 1)) add(x + 1, y, x, y);
      if (!inside(x, y + 1)) add(x, y + 1, x + 1, y + 1);
      if (!inside(x - 1, y)) add(x, y, x, y + 1);
      if (!inside(x + 1, y)) add(x + 1, y + 1, x + 1, y);
    }
  }
  // Concatena i lati in anelli e tiene il più lungo (il contorno esterno).
  let best: Point[] = [];
  while (edges.size) {
    const [k, list] = edges.entries().next().value as [string, Point[]];
    const [sx, sy] = k.split(',').map(Number);
    const loop: Point[] = [{ x: sx, y: sy }];
    let cur = list.pop()!;
    if (!list.length) edges.delete(k);
    let guard = 0;
    while (!(cur.x === sx && cur.y === sy) && guard++ < 1e6) {
      loop.push(cur);
      const ck = `${cur.x},${cur.y}`;
      const nxt = edges.get(ck);
      if (!nxt || !nxt.length) break;
      const c = nxt.pop()!;
      if (!nxt.length) edges.delete(ck);
      cur = c;
    }
    if (loop.length > best.length) best = loop;
  }
  return simplify(best);
}

function simplify(poly: Point[]): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[(i - 1 + poly.length) % poly.length];
    const c = poly[i];
    const nx = poly[(i + 1) % poly.length];
    const cross = (c.x - p.x) * (nx.y - c.y) - (c.y - p.y) * (nx.x - c.x);
    if (cross !== 0) out.push(c);
  }
  return out;
}
