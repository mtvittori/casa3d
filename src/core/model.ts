// Modello dati condiviso tra webapp e card.
// Tutte le coordinate sono in pixel dell'immagine sorgente; `scale` converte in metri.

export interface Point {
  x: number;
  y: number;
}

/** Muro rettilineo, rappresentato come asse centrale + spessore. */
export interface Wall {
  id: string;
  a: Point;
  b: Point;
  thickness: number;
}

export type EntityKind = 'light' | 'switch' | 'sensor' | 'binary_sensor' | 'climate' | 'cover' | 'other';

/** Entità Home Assistant posizionata sulla planimetria. */
export interface PlacedEntity {
  entity_id: string;
  position: Point;
  label?: string;
}

export interface Room {
  id: string;
  name: string;
  /** Poligono del pavimento, in senso orario o antiorario. */
  polygon: Point[];
  entities: PlacedEntity[];
}

export interface FloorPlan {
  version: 1;
  width: number;
  height: number;
  /** Pixel per metro. */
  scale: number;
  /** Altezza muri in metri. */
  wallHeight: number;
  walls: Wall[];
  rooms: Room[];
}

export function emptyPlan(width: number, height: number): FloorPlan {
  return { version: 1, width, height, scale: 50, wallHeight: 2.7, walls: [], rooms: [] };
}

let counter = 0;
export function uid(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}

export function entityDomain(entityId: string): EntityKind {
  const domain = entityId.split('.')[0];
  switch (domain) {
    case 'light':
    case 'switch':
    case 'sensor':
    case 'binary_sensor':
    case 'climate':
    case 'cover':
      return domain;
    default:
      return 'other';
  }
}

export function polygonCentroid(poly: Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  return { x: x / poly.length, y: y / poly.length };
}

export function polygonArea(poly: Point[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    s += p.x * q.y - q.x * p.y;
  }
  return Math.abs(s) / 2;
}

/** Minimo sottoinsieme dello stato HA che ci serve (compatibile con `hass.states`). */
export interface EntityState {
  state: string;
  attributes: Record<string, unknown>;
}
export type StateMap = Record<string, EntityState | undefined>;

/** Un'entità è "attiva" se va evidenziata (luce accesa, porta aperta, ...). */
export function isActive(s: EntityState | undefined): boolean {
  if (!s) return false;
  return ['on', 'open', 'opening', 'heat', 'cool', 'heat_cool', 'playing', 'home'].includes(s.state);
}
