// Skin = tema visivo applicato sia al floorplan 2D sia al modello 3D.
// Una skin personalizzata è un semplice oggetto JSON con gli stessi campi.

export type FloorPattern = 'plain' | 'wood' | 'tiles' | 'grid';

export interface Skin {
  id: string;
  name: string;
  background: string;
  floor: string;
  floorPattern: FloorPattern;
  /** Colori alternati per distinguere le stanze (vuoto = tutte `floor`). */
  roomTints: string[];
  wall: string;
  wallTop: string;
  text: string;
  entityOff: string;
  entityOn: string;
  /** Colore della luce emessa nelle stanze con luci accese (3D). */
  glow: string;
  /** 0-1: quanto le stanze buie vengono scurite. */
  dimOff: number;
  ambient: number;
  wallOpacity: number;
}

export const SKINS: Skin[] = [
  {
    id: 'minimal',
    name: 'Minimal chiaro',
    background: '#f4f4f1',
    floor: '#ffffff',
    floorPattern: 'plain',
    roomTints: [],
    wall: '#2b2b2b',
    wallTop: '#3a3a3a',
    text: '#333333',
    entityOff: '#9aa0a6',
    entityOn: '#f4b400',
    glow: '#ffd27a',
    dimOff: 0,
    ambient: 0.9,
    wallOpacity: 1,
  },
  {
    id: 'notte',
    name: 'Notte',
    background: '#0e1117',
    floor: '#1b2230',
    floorPattern: 'grid',
    roomTints: [],
    wall: '#5b6b8c',
    wallTop: '#8fa3cc',
    text: '#c8d3ea',
    entityOff: '#4a556b',
    entityOn: '#ffcf5c',
    glow: '#ffb547',
    dimOff: 0.55,
    ambient: 0.35,
    wallOpacity: 1,
  },
  {
    id: 'legno',
    name: 'Parquet caldo',
    background: '#efe7dc',
    floor: '#c89b6d',
    floorPattern: 'wood',
    roomTints: [],
    wall: '#f5f1ea',
    wallTop: '#6b4f36',
    text: '#3d2b1c',
    entityOff: '#8c7a68',
    entityOn: '#ff9f1c',
    glow: '#ffc58a',
    dimOff: 0.2,
    ambient: 0.8,
    wallOpacity: 1,
  },
  {
    id: 'blueprint',
    name: 'Blueprint',
    background: '#0b3d91',
    floor: '#0f4aa8',
    floorPattern: 'grid',
    roomTints: [],
    wall: '#e8f1ff',
    wallTop: '#ffffff',
    text: '#e8f1ff',
    entityOff: '#7fa6e0',
    entityOn: '#ffe14d',
    glow: '#fff3a0',
    dimOff: 0,
    ambient: 0.9,
    wallOpacity: 0.85,
  },
  {
    id: 'pastello',
    name: 'Pastello',
    background: '#fbf7f4',
    floor: '#ffffff',
    floorPattern: 'tiles',
    roomTints: ['#ffe3e3', '#e3f2ff', '#e8f8e3', '#fff3d6', '#efe3ff', '#dff7f4'],
    wall: '#6d6875',
    wallTop: '#b5838d',
    text: '#4a4453',
    entityOff: '#b8b1c2',
    entityOn: '#ff7f50',
    glow: '#ffd1b3',
    dimOff: 0.1,
    ambient: 0.85,
    wallOpacity: 1,
  },
];

export function getSkin(id: string | Skin | undefined): Skin {
  if (id && typeof id === 'object') return { ...SKINS[0], ...id };
  return SKINS.find((s) => s.id === id) ?? SKINS[0];
}

export function roomColor(skin: Skin, index: number): string {
  return skin.roomTints.length ? skin.roomTints[index % skin.roomTints.length] : skin.floor;
}
