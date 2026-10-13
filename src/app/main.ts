import { detect, detectRooms, RasterImage } from '../core/detect';
import { FloorPlan, Point, Room, StateMap, emptyPlan, entityDomain, polygonCentroid, uid } from '../core/model';
import { renderSVG } from '../core/render2d';
import { FloorScene3D } from '../core/render3d';
import { drawSamplePlan } from '../core/sample';
import { SKINS, Skin, getSkin } from '../core/skins';
import { HAClient } from './ha';
import type { PdfFile } from './pdf';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type Tool = 'select' | 'wall' | 'entity' | 'calibrate' | 'crop';
type Tab = 'edit' | '2d' | '3d';

const state = {
  image: null as RasterImage | null,
  imageUrl: '',
  plan: null as FloorPlan | null,
  skin: SKINS[0] as Skin,
  tool: 'select' as Tool,
  tab: 'edit' as Tab,
  selectedWalls: new Set<string>(),
  selectedRoom: '' as string,
  demoStates: {} as StateMap,
};

const ha = new HAClient();
let scene3d: FloorScene3D | null = null;

// ---------- dialoghi (niente prompt/alert: non funzionano dentro iframe e WebView) ----------

function ask(label: string, value = ''): Promise<string | null> {
  const dlg = $('dlg');
  const input = $<HTMLInputElement>('dlgInput');
  $('dlgLabel').textContent = label;
  input.value = value;
  dlg.hidden = false;
  input.focus();
  input.select();
  return new Promise((resolve) => {
    const done = (v: string | null) => {
      dlg.hidden = true;
      ($('dlgForm') as HTMLFormElement).onsubmit = null;
      $('dlgCancel').onclick = null;
      resolve(v);
    };
    ($('dlgForm') as HTMLFormElement).onsubmit = (e) => {
      e.preventDefault();
      done(input.value.trim());
    };
    $('dlgCancel').onclick = () => done(null);
  });
}

let toastTimer = 0;
function toast(msg: string) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 3500);
}

// ---------- immagine ----------

/** Immagine caricata (o pagina del PDF) e versione corrente dopo rotazioni e ritagli. */
let original: HTMLCanvasElement | null = null;
let source: HTMLCanvasElement | null = null;
let pdf: PdfFile | null = null;
/** Lato massimo dell'immagine su cui gira il rilevamento. */
const WORK_SIZE = 1600;

function canvasOf(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

async function loadFile(f: File) {
  if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
    toast('Apro il PDF…');
    const { openPdf } = await import('./pdf');
    pdf = await openPdf(await f.arrayBuffer());
    const sel = $<HTMLSelectElement>('pdfPage');
    sel.innerHTML = Array.from({ length: pdf.pages }, (_, i) => `<option value="${i + 1}">${i + 1} di ${pdf!.pages}</option>`).join('');
    $('pdfPageRow').hidden = pdf.pages < 2;
    await loadImage(await pdf.render(1));
  } else {
    pdf = null;
    $('pdfPageRow').hidden = true;
    await loadImage(URL.createObjectURL(f));
  }
}

async function loadImage(src: string | HTMLCanvasElement) {
  let canvas: HTMLCanvasElement;
  if (typeof src === 'string') {
    const img = new Image();
    img.src = src;
    await img.decode();
    // teniamo una buona risoluzione per poter ritagliare senza perdere dettaglio
    const k = Math.min(1, 3000 / Math.max(img.naturalWidth, img.naturalHeight));
    canvas = canvasOf(img.naturalWidth * k, img.naturalHeight * k);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  } else canvas = src;
  original = source = canvas;
  // nuova immagine: soglia di nuovo automatica
  $<HTMLInputElement>('thr').value = '0';
  $('thrVal').textContent = 'auto';
  prepareWork();
}

/** Riduce l'immagine corrente alla dimensione di lavoro e rilancia il rilevamento. */
function prepareWork() {
  if (!source) return;
  const k = Math.min(1, WORK_SIZE / Math.max(source.width, source.height));
  const work = canvasOf(source.width * k, source.height * k);
  const ctx = work.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, work.width, work.height);
  ctx.drawImage(source, 0, 0, work.width, work.height);
  const data = ctx.getImageData(0, 0, work.width, work.height);
  state.image = { width: work.width, height: work.height, data: data.data };
  state.imageUrl = work.toDataURL('image/png');
  ($('srcImg') as HTMLImageElement).src = state.imageUrl;
  $('empty').style.display = 'none';
  runDetect();
}

function rotate(dir: 1 | -1) {
  if (!source) return;
  const r = canvasOf(source.height, source.width);
  const ctx = r.getContext('2d')!;
  ctx.translate(r.width / 2, r.height / 2);
  ctx.rotate((dir * Math.PI) / 2);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  source = r;
  prepareWork();
}

/** Ritaglia l'immagine corrente al rettangolo `a`-`b` (coordinate dell'immagine di lavoro). */
function cropTo(a: Point, b: Point) {
  if (!source || !state.image) return;
  const k = source.width / state.image.width;
  const x = Math.max(0, Math.min(a.x, b.x) * k);
  const y = Math.max(0, Math.min(a.y, b.y) * k);
  const w = Math.min(source.width - x, Math.abs(b.x - a.x) * k);
  const h = Math.min(source.height - y, Math.abs(b.y - a.y) * k);
  if (w < 20 || h < 20) return;
  const c = canvasOf(w, h);
  c.getContext('2d')!.drawImage(source, x, y, w, h, 0, 0, c.width, c.height);
  source = c;
  prepareWork();
}

function runDetect() {
  if (!state.image) return;
  const num = (id: string) => {
    const v = $<HTMLInputElement>(id).value;
    return v === '' ? undefined : Number(v);
  };
  const t0 = performance.now();
  const res = detect(state.image, {
    threshold: num('thr') || undefined,
    minThickness: num('minT') || undefined,
    fillGap: num('fillGap'),
  });
  state.plan = res.plan;
  state.selectedWalls.clear();
  state.selectedRoom = '';
  $<HTMLInputElement>('thr').value = String(res.threshold);
  $('thrVal').textContent = String(res.threshold);
  $<HTMLInputElement>('fillGap').placeholder = `auto (${res.fillGap})`;
  $('detectInfo').textContent =
    `${res.plan.walls.length} muri, ${res.plan.rooms.length} stanze in ${Math.round(performance.now() - t0)} ms` +
    (res.fillGap ? ` · muri a doppia linea riempiti fino a ${res.fillGap} px` : '');
  syncPlanInputs();
  refresh(true);
}

function syncPlanInputs() {
  if (!state.plan) return;
  ($('scale') as HTMLInputElement).value = state.plan.scale.toFixed(1);
  ($('height') as HTMLInputElement).value = String(state.plan.wallHeight);
}

// ---------- rendering ----------

function currentStates(): StateMap {
  return ha.connected ? ha.states : state.demoStates;
}

function refresh(planChanged = false) {
  renderOverlay();
  renderSelection();
  if (!state.plan) return;
  if (state.tab === '2d') $('v2d').innerHTML = renderSVG(state.plan, state.skin, { states: currentStates() });
  if (state.tab === '3d') {
    if (!scene3d) {
      scene3d = new FloorScene3D($('v3d'), { onEntityClick: toggleEntity });
      planChanged = true;
    }
    if (planChanged) scene3d.setPlan(state.plan, state.skin);
    scene3d.setStates(currentStates());
  } else if (planChanged && scene3d) {
    scene3d.setPlan(state.plan, state.skin);
  }
}

function renderOverlay() {
  const svg = $('overlay') as unknown as SVGSVGElement;
  const p = state.plan;
  if (!p) {
    svg.innerHTML = '';
    return;
  }
  svg.setAttribute('viewBox', `0 0 ${p.width} ${p.height}`);
  const parts: string[] = [];
  const hues = [210, 140, 30, 280, 0, 180, 60, 320];
  p.rooms.forEach((r, i) => {
    const sel = r.id === state.selectedRoom;
    parts.push(
      `<polygon data-room="${r.id}" points="${r.polygon.map((q) => `${q.x},${q.y}`).join(' ')}" fill="hsl(${hues[i % hues.length]} 80% 60%)" fill-opacity="${sel ? 0.45 : 0.22}" stroke="${sel ? '#2563eb' : 'none'}" stroke-width="3"/>`,
    );
  });
  for (const w of p.walls) {
    const sel = state.selectedWalls.has(w.id);
    parts.push(
      `<line data-wall="${w.id}" x1="${w.a.x}" y1="${w.a.y}" x2="${w.b.x}" y2="${w.b.y}" stroke="${sel ? '#e53935' : '#d97706'}" stroke-opacity="0.85" stroke-width="${Math.max(w.thickness, 6)}" style="cursor:pointer"/>`,
    );
  }
  for (const r of p.rooms) {
    const c = polygonCentroid(r.polygon);
    parts.push(
      `<text x="${c.x}" y="${c.y}" font-size="${Math.max(12, p.scale * 0.35)}" text-anchor="middle" font-family="system-ui" fill="#1e3a8a" pointer-events="none">${escapeHtml(r.name)}</text>`,
    );
    for (const e of r.entities)
      parts.push(
        `<circle cx="${e.position.x}" cy="${e.position.y}" r="${Math.max(7, p.scale * 0.18)}" fill="#16a34a" stroke="#fff" stroke-width="2"><title>${escapeHtml(e.entity_id)}</title></circle>`,
      );
  }
  if (drag?.kind === 'line') {
    const color = state.tool === 'calibrate' ? '#7c3aed' : '#e53935';
    parts.push(
      `<line x1="${drag.a.x}" y1="${drag.a.y}" x2="${drag.b.x}" y2="${drag.b.y}" stroke="${color}" stroke-width="${state.tool === 'wall' ? defaultThickness() : 3}" stroke-opacity="0.7" stroke-dasharray="${state.tool === 'calibrate' ? '8 4' : ''}"/>`,
    );
  } else if (drag?.kind === 'box') {
    const x = Math.min(drag.a.x, drag.b.x);
    const y = Math.min(drag.a.y, drag.b.y);
    const crop = state.tool === 'crop';
    parts.push(
      `<rect x="${x}" y="${y}" width="${Math.abs(drag.b.x - drag.a.x)}" height="${Math.abs(drag.b.y - drag.a.y)}" fill="${crop ? 'none' : '#2563eb'}" fill-opacity="0.08" stroke="${crop ? '#16a34a' : '#2563eb'}" stroke-width="3" stroke-dasharray="10 6"/>`,
    );
  }
  svg.innerHTML = parts.join('');
}

function renderSelection() {
  const box = $('selection');
  const p = state.plan;
  const room = p?.rooms.find((r) => r.id === state.selectedRoom);
  const nSel = state.selectedWalls.size;
  const wall = nSel === 1 ? p?.walls.find((w) => state.selectedWalls.has(w.id)) : undefined;
  if (nSel > 1) {
    box.innerHTML = `<div>${nSel} muri selezionati</div><button id="wallDel">Elimina ${nSel} muri (Canc)</button>`;
    $('wallDel').onclick = deleteSelectedWalls;
  } else if (wall) {
    box.innerHTML = `<div>Muro selezionato · spessore <input id="wallT" type="number" min="1" value="${wall.thickness}" style="width:60px"> px</div><button id="wallDel">Elimina muro (Canc)</button>`;
    $('wallDel').onclick = deleteSelectedWalls;
    $('wallT').onchange = (e) => {
      wall.thickness = Number((e.target as HTMLInputElement).value) || wall.thickness;
      refresh(true);
    };
  } else if (room) {
    box.innerHTML =
      `<label>Nome stanza <input id="roomName" value="${escapeHtml(room.name)}"></label>` +
      room.entities
        .map(
          (e, i) =>
            `<div class="entity-row"><code title="${escapeHtml(e.entity_id)}">${escapeHtml(e.entity_id)}</code><button data-del="${i}">×</button></div>`,
        )
        .join('') +
      `<div class="muted">Strumento “Entità”: clicca nella stanza per posizionarne una.</div><button id="roomDel">Elimina stanza</button>`;
    $('roomName').onchange = (e) => {
      room.name = (e.target as HTMLInputElement).value;
      refresh(true);
    };
    box.querySelectorAll<HTMLButtonElement>('[data-del]').forEach(
      (b) =>
        (b.onclick = () => {
          room.entities.splice(Number(b.dataset.del), 1);
          refresh(true);
        }),
    );
    $('roomDel').onclick = () => {
      p!.rooms = p!.rooms.filter((r) => r !== room);
      state.selectedRoom = '';
      refresh(true);
    };
  } else box.innerHTML = '';
}

// ---------- editor ----------

/** `line`: muro o calibrazione; `box`: selezione multipla o ritaglio. */
let drag: { kind: 'line' | 'box'; a: Point; b: Point } | null = null;

function toPlan(ev: MouseEvent): Point {
  const svg = $('overlay') as unknown as SVGSVGElement;
  const pt = svg.createSVGPoint();
  pt.x = ev.clientX;
  pt.y = ev.clientY;
  const r = pt.matrixTransform(svg.getScreenCTM()!.inverse());
  return { x: r.x, y: r.y };
}

function defaultThickness() {
  const p = state.plan!;
  if (!p.walls.length) return Math.round(p.scale * 0.15);
  const ts = p.walls.map((w) => w.thickness).sort((a, b) => a - b);
  return ts[0];
}

function snapEnd(a: Point, b: Point): Point {
  // allinea a orizzontale/verticale se quasi tale
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const ang = Math.abs(Math.atan2(dy, dx) * (180 / Math.PI));
  if (ang < 10 || ang > 170) return { x: b.x, y: a.y };
  if (Math.abs(ang - 90) < 10) return { x: a.x, y: b.y };
  return b;
}

function snapPoint(p: Point): Point {
  // aggancia agli estremi dei muri esistenti
  let best = p;
  let bestD = 12;
  for (const w of state.plan!.walls)
    for (const q of [w.a, w.b]) {
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = { ...q };
      }
    }
  return best;
}

function roomAt(p: Point): Room | undefined {
  return state.plan?.rooms.find((r) => pointInPolygon(p, r.polygon));
}

function pointInPolygon(p: Point, poly: Point[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function setupEditor() {
  const svg = $('overlay');
  svg.addEventListener('mousedown', (ev) => {
    if (!state.plan) return;
    const p = toPlan(ev);
    if (state.tool === 'wall' || state.tool === 'calibrate') {
      const a = state.tool === 'wall' ? snapPoint(p) : p;
      drag = { kind: 'line', a, b: a };
      ev.preventDefault();
      return;
    }
    if (state.tool === 'crop') {
      drag = { kind: 'box', a: p, b: p };
      ev.preventDefault();
      return;
    }
    if (state.tool === 'select') {
      const id = (ev.target as Element).getAttribute('data-wall');
      if (id) {
        if (!ev.shiftKey) state.selectedWalls.clear();
        state.selectedWalls.has(id) && ev.shiftKey ? state.selectedWalls.delete(id) : state.selectedWalls.add(id);
        state.selectedRoom = '';
        refresh();
      } else {
        // clic su una stanza o trascinamento per selezionare più muri: si decide al rilascio
        drag = { kind: 'box', a: p, b: p };
        ev.preventDefault();
      }
      return;
    }
    if (state.tool === 'entity') {
      const room = roomAt(p);
      if (!room) return toast('Clicca dentro una stanza rilevata.');
      ask(`Entità Home Assistant in “${room.name}” (es. light.soggiorno, sensor.temperatura)`, 'light.').then((id) => {
        if (!id || !/^\w+\.\w+$/.test(id)) return id && toast('ID non valido: usa il formato dominio.nome');
        room.entities.push({ entity_id: id, position: p });
        state.selectedRoom = room.id;
        if (!ha.connected && entityDomain(id) === 'light') state.demoStates[id] = { state: 'on', attributes: {} };
        refresh(true);
      });
    }
  });
  window.addEventListener('mousemove', (ev) => {
    if (!drag) return;
    const p = toPlan(ev);
    drag.b = drag.kind === 'line' && state.tool === 'wall' ? snapEnd(drag.a, snapPoint(p)) : p;
    renderOverlay();
  });
  window.addEventListener('mouseup', (ev) => {
    if (!drag || !state.plan) return;
    const { kind, a, b } = drag;
    drag = null;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (kind === 'box') {
      if (state.tool === 'crop') {
        setTool('select');
        if (len >= 5) cropTo(a, b);
        else renderOverlay();
        return;
      }
      if (len < 5) {
        state.selectedWalls.clear();
        state.selectedRoom = roomAt(a)?.id ?? '';
      } else {
        const inside = (q: Point) => q.x >= Math.min(a.x, b.x) && q.x <= Math.max(a.x, b.x) && q.y >= Math.min(a.y, b.y) && q.y <= Math.max(a.y, b.y);
        if (!ev.shiftKey) state.selectedWalls.clear();
        for (const w of state.plan.walls) if (inside(w.a) && inside(w.b)) state.selectedWalls.add(w.id);
        state.selectedRoom = '';
      }
      return refresh();
    }
    if (len < 5) return renderOverlay();
    if (state.tool === 'wall') {
      state.plan.walls.push({ id: uid('w'), a, b, thickness: defaultThickness() });
      refresh(true);
    } else {
      renderOverlay();
      ask('Lunghezza reale del tratto disegnato, in metri', '1').then((v) => {
        const m = Number(v?.replace(',', '.'));
        if (!(m > 0) || !state.plan) return;
        state.plan.scale = len / m;
        syncPlanInputs();
        refresh(true);
        toast(`Scala: ${state.plan.scale.toFixed(1)} px per metro`);
      });
    }
  });
  window.addEventListener('keydown', (ev) => {
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && state.selectedWalls.size && !(ev.target instanceof HTMLInputElement)) {
      deleteSelectedWalls();
    }
    if (ev.key === 'Escape' && drag) {
      drag = null;
      renderOverlay();
    }
  });

  // drag & drop immagine
  const edit = $('edit');
  edit.addEventListener('dragover', (e) => {
    e.preventDefault();
    edit.classList.add('dragover');
  });
  edit.addEventListener('dragleave', () => edit.classList.remove('dragover'));
  edit.addEventListener('drop', (e) => {
    e.preventDefault();
    edit.classList.remove('dragover');
    const f = e.dataTransfer?.files[0];
    if (f) loadFile(f);
  });
}

function deleteSelectedWalls() {
  if (!state.plan) return;
  state.plan.walls = state.plan.walls.filter((w) => !state.selectedWalls.has(w.id));
  state.selectedWalls.clear();
  refresh(true);
}

function setTool(tool: Tool) {
  state.tool = tool;
  document.querySelectorAll<HTMLElement>('[data-tool]').forEach((x) => x.classList.toggle('on', x.dataset.tool === tool));
  $('overlay').style.cursor = tool === 'select' ? 'default' : 'crosshair';
  if (tool === 'crop') toast('Trascina un rettangolo attorno alla pianta da usare');
}

function recomputeRooms() {
  const p = state.plan;
  if (!p) return;
  const old = p.rooms;
  const diag = Math.hypot(p.width, p.height);
  p.rooms = detectRooms(p, Math.round(Math.max(diag / 10, 2.5 * p.scale)), (diag / 25) ** 2);
  // conserva nomi ed entità delle stanze che si sovrappongono
  for (const r of p.rooms) {
    const prev = old.find((o) => pointInPolygon(polygonCentroid(r.polygon), o.polygon) || pointInPolygon(polygonCentroid(o.polygon), r.polygon));
    if (prev) {
      r.name = prev.name;
      r.entities = prev.entities.filter((e) => pointInPolygon(e.position, r.polygon));
    }
  }
  refresh(true);
}

function toggleEntity(id: string) {
  const domain = id.split('.')[0];
  if (ha.connected) {
    if (['light', 'switch', 'cover', 'fan', 'input_boolean'].includes(domain)) ha.callService('homeassistant', 'toggle', { entity_id: id });
    return;
  }
  const cur = state.demoStates[id];
  state.demoStates[id] = { state: cur?.state === 'on' ? 'off' : 'on', attributes: cur?.attributes ?? {} };
  refresh();
}

// ---------- export ----------

function download(name: string, text: string, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function cardConfig(inline: boolean): Record<string, unknown> {
  return {
    type: 'custom:casa3d-card',
    ...(inline ? { plan: state.plan } : { plan_url: '/local/casa3d/casa.json' }),
    skin: state.skin.id === 'custom' ? state.skin : state.skin.id,
    mode: '3d',
    height: 480,
  };
}

/** YAML semplice per oggetti JSON (sufficiente per la configurazione della card). */
function toYaml(v: unknown, indent = 0): string {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return v.map((x) => `\n${pad}- ${toYaml(x, indent + 2).replace(/^\n\s*/, '')}`).join('');
  }
  if (v && typeof v === 'object') {
    const entries = Object.entries(v);
    if (!entries.length) return '{}';
    return entries.map(([k, x]) => `\n${pad}${k}: ${toYaml(x, indent + 2)}`).join('');
  }
  if (typeof v === 'string') return /^[\w./-]+$/.test(v) && !/^(true|false|null|yes|no|on|off|\d.*)$/i.test(v) ? v : JSON.stringify(v);
  return String(v);
}

function dashboardYaml(): string {
  const cfg = { title: 'Casa', views: [{ title: 'Casa', path: 'casa', panel: true, cards: [cardConfig(false)] }] };
  return toYaml(cfg).trimStart() + '\n';
}

async function createDashboard() {
  if (!ha.connected || !state.plan) return;
  try {
    const urlPath = 'casa-3d';
    try {
      await ha.call({ type: 'lovelace/dashboards/create', url_path: urlPath, title: 'Casa 3D', icon: 'mdi:home-floor-1', show_in_sidebar: true, require_admin: false, mode: 'storage' });
    } catch (e) {
      if (!/already|exists|in uso/i.test((e as Error).message)) throw e;
    }
    await ha.call({
      type: 'lovelace/config/save',
      url_path: urlPath,
      config: { title: 'Casa 3D', views: [{ title: 'Casa', path: 'casa', panel: true, cards: [cardConfig(true)] }] },
    });
    $('haInfo').textContent = 'Dashboard “Casa 3D” creata. Serve la risorsa /local/casa3d-card.js (vedi README).';
  } catch (e) {
    $('haInfo').textContent = 'Creazione dashboard fallita: ' + (e as Error).message;
  }
}

// ---------- UI wiring ----------

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function setTab(tab: Tab) {
  state.tab = tab;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.tab === tab));
  $('edit').classList.toggle('on', tab === 'edit');
  $('v2d').classList.toggle('on', tab === '2d');
  $('v3d').classList.toggle('on', tab === '3d');
  refresh(tab === '3d');
}

function init() {
  const skinSel = $('skin') as HTMLSelectElement;
  skinSel.innerHTML = SKINS.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
  ($('skinJson') as HTMLTextAreaElement).value = JSON.stringify({ ...SKINS[1], id: 'custom', name: 'La mia skin' }, null, 2);
  skinSel.onchange = () => {
    state.skin = getSkin(skinSel.value);
    scene3d?.setSkin(state.skin);
    refresh();
  };
  $('skinApply').onclick = () => {
    try {
      state.skin = getSkin({ ...JSON.parse(($('skinJson') as HTMLTextAreaElement).value), id: 'custom' });
      scene3d?.setSkin(state.skin);
      refresh();
    } catch (e) {
      toast('JSON della skin non valido: ' + (e as Error).message);
    }
  };

  $('file').onchange = (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) loadFile(f).catch((err) => toast('File non leggibile: ' + (err as Error).message));
  };
  $('pdfPage').onchange = async () => {
    if (pdf) await loadImage(await pdf.render(Number($<HTMLSelectElement>('pdfPage').value)));
  };
  $('rotL').onclick = () => rotate(-1);
  $('rotR').onclick = () => rotate(1);
  $('cropBtn').onclick = () => setTool(state.tool === 'crop' ? 'select' : 'crop');
  $('resetImg').onclick = () => {
    source = original;
    prepareWork();
  };
  $('sample').onclick = () => loadImage(drawSamplePlan()).then(nameSampleRooms);
  $('thr').oninput = () => ($('thrVal').textContent = ($('thr') as HTMLInputElement).value);
  $('detect').onclick = runDetect;
  $('rooms').onclick = recomputeRooms;
  $('scale').onchange = () => {
    if (state.plan) state.plan.scale = Number(($('scale') as HTMLInputElement).value) || state.plan.scale;
    refresh(true);
  };
  $('height').onchange = () => {
    if (state.plan) state.plan.wallHeight = Number(($('height') as HTMLInputElement).value) || state.plan.wallHeight;
    refresh(true);
  };
  document.querySelectorAll<HTMLButtonElement>('#tools button').forEach((b) => (b.onclick = () => setTool(b.dataset.tool as Tool)));
  document.querySelectorAll<HTMLButtonElement>('#tabs button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab as Tab)));
  $('v2d').addEventListener('click', (ev) => {
    const g = (ev.target as Element).closest('[data-entity]');
    if (g) toggleEntity(g.getAttribute('data-entity')!);
  });

  $('exportJson').onclick = () => state.plan && download('casa.json', JSON.stringify(state.plan, null, 2));
  $('exportYaml').onclick = async () => {
    if (!state.plan) return;
    const yaml = toYaml(cardConfig(false)).trimStart();
    const out = $<HTMLTextAreaElement>('yamlOut');
    out.value = yaml;
    out.hidden = false;
    try {
      await navigator.clipboard.writeText(yaml);
      toast('YAML della card copiato');
    } catch {
      out.select();
      toast('Copia il YAML dal riquadro qui sotto');
    }
  };
  $('exportDash').onclick = () => state.plan && download('casa3d-dashboard.yaml', dashboardYaml(), 'text/yaml');
  $('importJson').onclick = () => $('importFile').click();
  $('importFile').onchange = async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    const plan = JSON.parse(await f.text()) as FloorPlan;
    state.plan = { ...emptyPlan(plan.width, plan.height), ...plan };
    $('empty').style.display = 'none';
    syncPlanInputs();
    refresh(true);
  };

  ($('haUrl') as HTMLInputElement).value = localStorage.getItem('casa3d.haUrl') ?? '';
  $('haConnect').onclick = async () => {
    const url = ($('haUrl') as HTMLInputElement).value.trim();
    const token = ($('haToken') as HTMLInputElement).value.trim();
    try {
      localStorage.setItem('casa3d.haUrl', url);
    } catch {
      /* storage non disponibile */
    }
    try {
      ha.onStates = () => refresh();
      await ha.connect(url, token);
      const ids = Object.keys(ha.states).sort();
      $('entities').innerHTML = ids.map((id) => `<option value="${id}">`).join('');
      $('haInfo').textContent = `Connesso: ${ids.length} entità, stato live attivo.`;
      ($('haDashboard') as HTMLButtonElement).disabled = false;
      refresh();
    } catch (e) {
      $('haInfo').textContent = 'Errore: ' + (e as Error).message;
    }
  };
  $('haDashboard').onclick = createDashboard;

  setupEditor();
  // si parte dalla planimetria di esempio, così si vede subito il flusso completo
  loadImage(drawSamplePlan()).then(nameSampleRooms);
}

/** Nomi ed entità demo per la planimetria di esempio. */
function nameSampleRooms() {
  const p = state.plan;
  if (!p) return;
  const names: [Point, string, string][] = [
    [{ x: 200, y: 220 }, 'Cucina', 'light.cucina'],
    [{ x: 260, y: 490 }, 'Soggiorno', 'light.soggiorno'],
    [{ x: 580, y: 200 }, 'Camera', 'light.camera'],
    [{ x: 800, y: 200 }, 'Bagno', 'light.bagno'],
    [{ x: 760, y: 470 }, 'Camera 2', 'light.camera_2'],
  ];
  for (const [pt, name, light] of names) {
    const r = roomAt(pt);
    if (!r) continue;
    r.name = name;
    const c = polygonCentroid(r.polygon);
    r.entities.push({ entity_id: light, position: { x: c.x, y: c.y - p.scale * 0.8 } });
    state.demoStates[light] = { state: name === 'Camera' || name === 'Bagno' ? 'off' : 'on', attributes: {} };
  }
  const sog = p.rooms.find((r) => r.name === 'Soggiorno');
  if (sog) {
    const c = polygonCentroid(sog.polygon);
    sog.entities.push({ entity_id: 'sensor.temperatura_soggiorno', position: { x: c.x + p.scale * 1.5, y: c.y + p.scale * 0.8 } });
    state.demoStates['sensor.temperatura_soggiorno'] = { state: '21.5', attributes: { unit_of_measurement: '°C' } };
  }
  refresh(true);
}

init();
