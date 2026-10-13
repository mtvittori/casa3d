import { detect, detectRooms, RasterImage } from '../core/detect';
import { FloorPlan, Point, Room, StateMap, emptyPlan, entityDomain, polygonCentroid, uid } from '../core/model';
import { renderSVG } from '../core/render2d';
import { FloorScene3D } from '../core/render3d';
import { drawSamplePlan } from '../core/sample';
import { SKINS, Skin, getSkin } from '../core/skins';
import { HAClient } from './ha';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type Tool = 'select' | 'wall' | 'entity' | 'calibrate';
type Tab = 'edit' | '2d' | '3d';

const state = {
  image: null as RasterImage | null,
  imageUrl: '',
  plan: null as FloorPlan | null,
  skin: SKINS[0] as Skin,
  tool: 'select' as Tool,
  tab: 'edit' as Tab,
  selectedWall: '' as string,
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

async function loadImage(src: string | HTMLCanvasElement) {
  let canvas: HTMLCanvasElement;
  if (typeof src === 'string') {
    const img = new Image();
    img.src = src;
    await img.decode();
    // limita le dimensioni per tenere veloce il rilevamento
    const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * k);
    canvas.height = Math.round(img.naturalHeight * k);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  } else canvas = src;
  const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
  state.image = { width: canvas.width, height: canvas.height, data: data.data };
  state.imageUrl = canvas.toDataURL('image/png');
  ($('srcImg') as HTMLImageElement).src = state.imageUrl;
  $('empty').style.display = 'none';
  runDetect();
}

function runDetect() {
  if (!state.image) return;
  const thr = Number(($('thr') as HTMLInputElement).value);
  const minT = Number(($('minT') as HTMLInputElement).value);
  const t0 = performance.now();
  const res = detect(state.image, { threshold: thr || undefined, minThickness: minT || undefined });
  state.plan = res.plan;
  state.selectedWall = state.selectedRoom = '';
  ($('thr') as HTMLInputElement).value = String(res.threshold);
  $('thrVal').textContent = String(res.threshold);
  $('detectInfo').textContent = `${res.plan.walls.length} muri, ${res.plan.rooms.length} stanze in ${Math.round(performance.now() - t0)} ms`;
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
    const sel = w.id === state.selectedWall;
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
  if (drag) {
    const color = state.tool === 'calibrate' ? '#7c3aed' : '#e53935';
    parts.push(
      `<line x1="${drag.a.x}" y1="${drag.a.y}" x2="${drag.b.x}" y2="${drag.b.y}" stroke="${color}" stroke-width="${state.tool === 'wall' ? defaultThickness() : 3}" stroke-opacity="0.7" stroke-dasharray="${state.tool === 'calibrate' ? '8 4' : ''}"/>`,
    );
  }
  svg.innerHTML = parts.join('');
}

function renderSelection() {
  const box = $('selection');
  const p = state.plan;
  const room = p?.rooms.find((r) => r.id === state.selectedRoom);
  const wall = p?.walls.find((w) => w.id === state.selectedWall);
  if (wall) {
    box.innerHTML = `<div>Muro selezionato · spessore <input id="wallT" type="number" min="1" value="${wall.thickness}" style="width:60px"> px</div><button id="wallDel">Elimina muro (Canc)</button>`;
    $('wallDel').onclick = deleteSelectedWall;
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

let drag: { a: Point; b: Point } | null = null;

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
      drag = { a, b: a };
      ev.preventDefault();
      return;
    }
    if (state.tool === 'select') {
      const t = ev.target as Element;
      state.selectedWall = t.getAttribute('data-wall') ?? '';
      state.selectedRoom = state.selectedWall ? '' : (t.getAttribute('data-room') ?? roomAt(p)?.id ?? '');
      refresh();
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
    drag.b = state.tool === 'wall' ? snapEnd(drag.a, snapPoint(p)) : p;
    renderOverlay();
  });
  window.addEventListener('mouseup', () => {
    if (!drag || !state.plan) return;
    const { a, b } = drag;
    drag = null;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
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
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && state.selectedWall && !(ev.target instanceof HTMLInputElement)) {
      deleteSelectedWall();
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
    if (f) loadImage(URL.createObjectURL(f));
  });
}

function deleteSelectedWall() {
  if (!state.plan) return;
  state.plan.walls = state.plan.walls.filter((w) => w.id !== state.selectedWall);
  state.selectedWall = '';
  refresh(true);
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
    if (f) loadImage(URL.createObjectURL(f));
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
  document.querySelectorAll<HTMLButtonElement>('#tools button').forEach(
    (b) =>
      (b.onclick = () => {
        state.tool = b.dataset.tool as Tool;
        document.querySelectorAll('#tools button').forEach((x) => x.classList.toggle('on', x === b));
        $('overlay').style.cursor = state.tool === 'select' ? 'default' : 'crosshair';
      }),
  );
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
