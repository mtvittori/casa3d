import { describe, expect, it } from 'vitest';
import { detect, RasterImage } from './detect';

function canvas(w: number, h: number) {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  const rect = (x: number, y: number, rw: number, rh: number, v = 0) => {
    for (let yy = y; yy < y + rh; yy++)
      for (let xx = x; xx < x + rw; xx++) {
        const i = (yy * w + xx) * 4;
        data[i] = data[i + 1] = data[i + 2] = v;
      }
  };
  return { img: { width: w, height: h, data } as RasterImage, rect };
}

describe('detect', () => {
  it('trova i muri e due stanze separate da una porta', () => {
    const { img, rect } = canvas(400, 300);
    const t = 10;
    // perimetro 20..380 x 20..280
    rect(20, 20, 360, t);
    rect(20, 270, 360, t);
    rect(20, 20, t, 260);
    rect(370, 20, t, 260);
    // muro interno verticale a x=200 con porta tra y=120 e y=170
    rect(200, 20, t, 100);
    rect(200, 170, t, 110);
    // testo/quote sottili che non devono diventare muri
    rect(60, 100, 80, 2);
    rect(250, 60, 1, 80);

    const { plan } = detect(img, { minThickness: 5 });
    expect(plan.walls.length).toBe(6);
    expect(plan.walls.every((w) => w.thickness === t)).toBe(true);
    expect(plan.rooms.length).toBe(2);
    const areas = plan.rooms
      .map((r) => {
        const xs = r.polygon.map((p) => p.x);
        return Math.max(...xs) - Math.min(...xs);
      })
      .sort((a, b) => a - b);
    // larghezze interne ~170 e ~160 px
    expect(areas[0]).toBeGreaterThan(150);
    expect(areas[1]).toBeLessThan(185);
  });

  it('separa le 5 stanze di un appartamento con porte vicine agli angoli', () => {
    const { img, rect } = canvas(1000, 700);
    const T = 14;
    const t = 9;
    rect(80, 80, 840, T);
    rect(80, 606, 470, T);
    rect(640, 606, 280, T);
    rect(80, 80, T, 540);
    rect(906, 80, T, 540);
    rect(460, 80, t, 220);
    rect(460, 360, t, 260);
    rect(460, 330, 240, t);
    rect(760, 330, 160, t);
    rect(700, 80, t, 160);
    rect(700, 290, t, 40);
    rect(80, 360, 250, t);
    rect(400, 360, 60, t);
    const { plan } = detect(img);
    expect(plan.walls.length).toBe(13);
    expect(plan.rooms.length).toBe(5);
  });
});
