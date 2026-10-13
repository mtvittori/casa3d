# Casa 3D

Da un'immagine di planimetria a un floorplan 2D e a un modello 3D della casa, con skin e stato live delle entità di Home Assistant. Lo stesso core alimenta due prodotti:

- **Editor web** (`index.html`, `src/app`): carichi l'immagine, rilevi muri e stanze, correggi a mano, posizioni le entità HA, scegli la skin ed esporti.
- **Card Lovelace** (`src/card`): `custom:casa3d-card`, un unico file JS da caricare in Home Assistant che mostra la casa in 2D o 3D e accende/spegne le entità al tocco.

## Struttura

```
src/core/model.ts     modello dati (muri, stanze, entità) condiviso
src/core/detect.ts    estrazione muri/stanze: soglia Otsu → apertura morfologica → rettangoli → chiusura porte → flood fill
src/core/render2d.ts  floorplan SVG
src/core/render3d.ts  scena Three.js (muri estrusi, pavimenti, luci legate alle entità)
src/core/skins.ts     skin incluse (Minimal, Notte, Parquet, Blueprint, Pastello)
src/app/              editor web + client WebSocket di Home Assistant
src/card/             custom card Lovelace (Lit)
```

## Sviluppo

```
npm install
npm run dev        # editor su http://localhost:5173
npm test           # test del rilevamento
npm run build      # dist/app (editor) + dist/card/casa3d-card.js
```

## Usare la card in Home Assistant

1. Copia `dist/card/casa3d-card.js` in `config/www/casa3d-card.js`.
2. Impostazioni → Dashboard → Risorse → aggiungi `/local/casa3d-card.js` come *Modulo JavaScript*.
3. Dall'editor esporta `casa.json` e copialo in `config/www/casa3d/casa.json`.
4. Aggiungi la card:

```yaml
type: custom:casa3d-card
plan_url: /local/casa3d/casa.json
skin: notte          # minimal | notte | legno | blueprint | pastello, oppure un oggetto skin
mode: 3d             # 2d | 3d
height: 480
```

In alternativa, dall'editor collegato a HA (URL + token long-lived) il pulsante **Crea dashboard su HA** crea una dashboard "Casa 3D" con la card e la planimetria incorporata.

## Skin personalizzate

Una skin è un oggetto con i campi di `Skin` in `src/core/skins.ts` (colori di sfondo, pavimento, muri, entità accese/spente, bagliore delle luci, motivo del pavimento). Si può incollare come JSON nell'editor o passare direttamente nel campo `skin:` della card.
