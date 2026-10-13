// Floorplan 2D come SVG (stringa), usato dalla webapp e dalla card.

import { FloorPlan, StateMap, entityDomain, isActive, polygonCentroid } from './model';
import { Skin, roomColor } from './skins';

export interface Render2DOptions {
  states?: StateMap;
  showLabels?: boolean;
  /** Evidenzia un muro (editor). */
  selectedWall?: string;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const ICON: Record<string, string> = {
  light: 'M0,-7a5,5 0 0 1 4,8v2h-8v-2a5,5 0 0 1 4,-8zM-3,4h6v2h-6z',
  switch: 'M-5,-3h10v6h-10z',
  sensor: 'M-1.5,-6h3v8a3,3 0 1 1 -3,0z',
  binary_sensor: 'M-5,-5h10v10h-10z',
  climate: 'M0,-7l2,5h5l-4,3l2,6l-5,-4l-5,4l2,-6l-4,-3h5z',
  cover: 'M-6,-6h12v3h-12zM-6,-1h12v3h-12zM-6,4h12v2h-12z',
  other: 'M0,0m-5,0a5,5 0 1 0 10,0a5,5 0 1 0 -10,0',
};

export function renderSVG(plan: FloorPlan, skin: Skin, opts: Render2DOptions = {}): string {
  const states = opts.states ?? {};
  const parts: string[] = [];
  const pat = patternDef(skin);
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${plan.width} ${plan.height}" preserveAspectRatio="xMidYMid meet" style="background:${skin.background}">`,
    `<defs>${pat}<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${plan.scale * 0.6}"/></filter></defs>`,
  );

  plan.rooms.forEach((room, i) => {
    const pts = room.polygon.map((p) => `${p.x},${p.y}`).join(' ');
    const lightsOn = room.entities.some((e) => entityDomain(e.entity_id) === 'light' && isActive(states[e.entity_id]));
    const hasLights = room.entities.some((e) => entityDomain(e.entity_id) === 'light');
    parts.push(`<polygon data-room="${room.id}" points="${pts}" fill="${roomColor(skin, i)}"/>`);
    if (pat) parts.push(`<polygon points="${pts}" fill="url(#floorpat)" pointer-events="none"/>`);
    if (hasLights && !lightsOn && skin.dimOff > 0)
      parts.push(`<polygon points="${pts}" fill="#000" opacity="${skin.dimOff}" pointer-events="none"/>`);
    if (lightsOn) {
      for (const e of room.entities.filter((e) => entityDomain(e.entity_id) === 'light' && isActive(states[e.entity_id]))) {
        parts.push(
          `<circle cx="${e.position.x}" cy="${e.position.y}" r="${plan.scale * 1.6}" fill="${skin.glow}" opacity="0.55" filter="url(#glow)" pointer-events="none"/>`,
        );
      }
    }
  });

  for (const w of plan.walls) {
    const sel = w.id === opts.selectedWall;
    parts.push(
      `<line data-wall="${w.id}" x1="${w.a.x}" y1="${w.a.y}" x2="${w.b.x}" y2="${w.b.y}" stroke="${sel ? '#e53935' : skin.wall}" stroke-opacity="${skin.wallOpacity}" stroke-width="${w.thickness}" stroke-linecap="square"/>`,
    );
  }

  const fs = Math.max(10, plan.scale * 0.35);
  for (const room of plan.rooms) {
    if (opts.showLabels !== false) {
      const c = polygonCentroid(room.polygon);
      parts.push(
        `<text x="${c.x}" y="${c.y}" font-family="system-ui,sans-serif" font-size="${fs}" fill="${skin.text}" text-anchor="middle" dominant-baseline="middle" pointer-events="none">${esc(room.name)}</text>`,
      );
    }
    for (const e of room.entities) {
      const st = states[e.entity_id];
      const on = isActive(st);
      const kind = entityDomain(e.entity_id);
      const s = Math.max(1, plan.scale / 25);
      const value = kind === 'sensor' && st ? `${st.state}${(st.attributes.unit_of_measurement as string) ?? ''}` : '';
      parts.push(
        `<g data-entity="${esc(e.entity_id)}" transform="translate(${e.position.x},${e.position.y})" style="cursor:pointer">` +
          `<circle r="${11 * s}" fill="${skin.background}" stroke="${on ? skin.entityOn : skin.entityOff}" stroke-width="${2 * s}"/>` +
          `<path d="${ICON[kind]}" fill="${on ? skin.entityOn : skin.entityOff}" transform="scale(${s})"/>` +
          (value
            ? `<text y="${22 * s}" font-family="system-ui,sans-serif" font-size="${fs * 0.8}" fill="${skin.text}" text-anchor="middle">${esc(value)}</text>`
            : '') +
          `<title>${esc(e.label ?? e.entity_id)}${st ? ': ' + esc(st.state) : ''}</title></g>`,
      );
    }
  }
  parts.push('</svg>');
  return parts.join('');
}

function patternDef(skin: Skin): string {
  const c = skin.wall;
  switch (skin.floorPattern) {
    case 'grid':
      return `<pattern id="floorpat" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20,0H0V20" fill="none" stroke="${skin.text}" stroke-opacity="0.12"/></pattern>`;
    case 'tiles':
      return `<pattern id="floorpat" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24,0H0V24" fill="none" stroke="${c}" stroke-opacity="0.12"/></pattern>`;
    case 'wood':
      return `<pattern id="floorpat" width="60" height="12" patternUnits="userSpaceOnUse"><path d="M0,12H60M30,0V12" stroke="#000" stroke-opacity="0.12"/></pattern>`;
    default:
      return '';
  }
}
