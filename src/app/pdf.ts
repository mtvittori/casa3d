// Lettura dei PDF (planimetrie catastali, scansioni) con pdf.js.
// Il worker gira nel thread principale: niente file separati, funziona anche come pagina singola.

import { getDocument } from 'pdfjs-dist';
import * as worker from 'pdfjs-dist/build/pdf.worker.mjs';

(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;

export interface PdfFile {
  pages: number;
  render(page: number, maxDim?: number): Promise<HTMLCanvasElement>;
}

export async function openPdf(data: ArrayBuffer): Promise<PdfFile> {
  const doc = await getDocument({ data: new Uint8Array(data) }).promise;
  return {
    pages: doc.numPages,
    async render(n: number, maxDim = 3000) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: maxDim / Math.max(base.width, base.height) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      return canvas;
    },
  };
}
