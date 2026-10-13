import { defineConfig } from 'vite';

// Custom card Lovelace: un unico file JS da caricare come risorsa in Home Assistant
export default defineConfig({
  build: {
    outDir: 'dist/card',
    minify: true,
    emptyOutDir: true,
    lib: {
      entry: 'src/card/casa3d-card.ts',
      formats: ['es'],
      fileName: () => 'casa3d-card.js',
    },
  },
});
