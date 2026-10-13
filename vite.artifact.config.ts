import { defineConfig } from 'vite';

// Editor in un unico bundle (niente chunk dinamici), da impacchettare in una sola pagina HTML
// con scripts/single-html.mjs per l'anteprima pubblicata.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist/artifact',
    chunkSizeWarningLimit: 4000,
    rolldownOptions: { output: { codeSplitting: false } },
  },
});
