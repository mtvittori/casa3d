// Unisce dist/artifact (index.html + assets) in un'unica pagina: dist/casa3d.html
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const dir = 'dist/artifact';
const html = readFileSync(`${dir}/index.html`, 'utf8');
const assets = readdirSync(`${dir}/assets`);
const css = assets.filter((f) => f.endsWith('.css')).map((f) => readFileSync(`${dir}/assets/${f}`, 'utf8')).join('\n');
const js = assets.filter((f) => f.endsWith('.js')).map((f) => readFileSync(`${dir}/assets/${f}`, 'utf8'));
if (js.length !== 1) throw new Error(`atteso un solo bundle JS, trovati ${js.length}`);
if (js[0].includes('</script')) throw new Error('il bundle contiene </script');
const title = html.match(/<title>.*?<\/title>/)?.[0] ?? '<title>Casa 3D</title>';
const body = html
  .match(/<body>([\s\S]*)<\/body>/)[1]
  .replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '');
writeFileSync('dist/casa3d.html', `${title}\n<style>${css}</style>\n${body}\n<script type="module">${js[0]}</script>\n`);
console.log('dist/casa3d.html scritto');
