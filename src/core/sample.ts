// Genera una planimetria di esempio "realistica" (muri, porte con arco, testi, quote) su canvas.

export function drawSamplePlan(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 1000;
  c.height = 700;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#111';
  const T = 14; // muri esterni
  const t = 9; // muri interni
  const R = (x: number, y: number, w: number, h: number) => g.fillRect(x, y, w, h);

  // perimetro 80..920 x 80..620 con ingresso in basso
  R(80, 80, 840, T);
  R(80, 606, 470, T);
  R(640, 606, 280, T);
  R(80, 80, T, 540);
  R(906, 80, T, 540);
  // muro verticale a x=460 (soggiorno | camere), porta 300..360
  R(460, 80, t, 220);
  R(460, 360, t, 260);
  // muro orizzontale a destra y=330, porta 700..760
  R(460, 330, 240, t);
  R(760, 330, 160, t);
  // bagno in alto a destra: verticale x=700 da 80 a 330 con porta 240..290
  R(700, 80, t, 160);
  R(700, 290, t, 40);
  // cucina separata a sinistra: orizzontale y=360 da 80 a 330, porta 330..400 aperta verso il soggiorno
  R(80, 360, 250, t);
  R(400, 360, 60, t);

  // finestre (linee sottili doppie) sui muri esterni
  g.fillStyle = '#fff';
  R(200, 80, 100, T);
  R(780, 80, 80, T);
  g.strokeStyle = '#111';
  g.lineWidth = 1.5;
  for (const [x1, x2] of [
    [200, 300],
    [780, 860],
  ]) {
    g.beginPath();
    g.moveTo(x1, 84);
    g.lineTo(x2, 84);
    g.moveTo(x1, 90);
    g.lineTo(x2, 90);
    g.stroke();
  }

  // archi delle porte
  g.lineWidth = 1;
  const arc = (cx: number, cy: number, r: number, a1: number, a2: number) => {
    g.beginPath();
    g.moveTo(cx, cy);
    g.arc(cx, cy, r, a1, a2);
    g.closePath();
    g.stroke();
  };
  arc(469, 300, 55, 0, Math.PI / 2);
  arc(700, 339, 55, 0, Math.PI / 2);
  arc(709, 240, 45, 0, Math.PI / 2);
  arc(550, 606, 85, -Math.PI / 2, 0);

  // testi
  g.fillStyle = '#222';
  g.font = '22px sans-serif';
  g.fillText('CUCINA', 180, 230);
  g.fillText('SOGGIORNO', 200, 490);
  g.fillText('CAMERA', 540, 210);
  g.fillText('BAGNO', 770, 210);
  g.fillText('CAMERA 2', 700, 480);
  g.font = '14px sans-serif';
  g.fillText('14,2 m²', 190, 255);
  g.fillText('28,5 m²', 215, 515);

  // quote
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(80, 50);
  g.lineTo(920, 50);
  g.moveTo(80, 42);
  g.lineTo(80, 58);
  g.moveTo(920, 42);
  g.lineTo(920, 58);
  g.stroke();
  g.fillText('12,00', 480, 44);
  return c;
}
