// Custom card Lovelace "casa3d-card": mostra la planimetria in 2D o 3D con lo stato live delle entità.
//
// type: custom:casa3d-card
// plan_url: /local/casa3d/casa.json   # oppure `plan:` con il JSON esportato dall'editor
// skin: notte                          # id di una skin inclusa, oppure un oggetto skin personalizzato
// mode: 3d                             # 2d | 3d
// height: 420

import { LitElement, css, html, PropertyValues } from 'lit';
import { FloorPlan, StateMap } from '../core/model';
import { renderSVG } from '../core/render2d';
import { FloorScene3D } from '../core/render3d';
import { Skin, getSkin } from '../core/skins';

interface CardConfig {
  type: string;
  plan?: FloorPlan;
  plan_url?: string;
  skin?: string | Partial<Skin>;
  mode?: '2d' | '3d';
  height?: number;
  title?: string;
  show_mode_toggle?: boolean;
}

interface Hass {
  states: StateMap;
  callService(domain: string, service: string, data: Record<string, unknown>): Promise<unknown>;
}

const TOGGLABLE = new Set(['light', 'switch', 'cover', 'fan', 'input_boolean']);

export class Casa3DCard extends LitElement {
  static properties = {
    _plan: { state: true },
    _mode: { state: true },
    _error: { state: true },
  };

  private _config!: CardConfig;
  private _hass?: Hass;
  private _plan?: FloorPlan;
  private _mode: '2d' | '3d' = '3d';
  private _error = '';
  private _scene?: FloorScene3D;
  private _skin: Skin = getSkin(undefined);

  static styles = css`
    ha-card {
      overflow: hidden;
      position: relative;
    }
    .view {
      width: 100%;
      position: relative;
    }
    .view svg {
      width: 100%;
      height: 100%;
      display: block;
    }
    .toggle {
      position: absolute;
      top: 8px;
      right: 8px;
      z-index: 2;
      display: flex;
      border-radius: 16px;
      overflow: hidden;
      background: rgba(0, 0, 0, 0.35);
    }
    .toggle button {
      border: 0;
      background: transparent;
      color: #fff;
      padding: 4px 12px;
      cursor: pointer;
      font: inherit;
    }
    .toggle button.on {
      background: rgba(255, 255, 255, 0.9);
      color: #222;
    }
    .title {
      position: absolute;
      top: 10px;
      left: 14px;
      z-index: 2;
      font-weight: 500;
    }
    .error {
      padding: 16px;
      color: var(--error-color, #c00);
    }
  `;

  setConfig(config: CardConfig) {
    if (!config.plan && !config.plan_url) throw new Error('Specifica `plan` oppure `plan_url`');
    this._config = config;
    this._mode = config.mode ?? '3d';
    this._skin = getSkin(config.skin as Skin | string | undefined);
    if (config.plan) this._plan = config.plan;
    else this.loadPlan(config.plan_url!);
  }

  set hass(hass: Hass) {
    this._hass = hass;
    this.refreshStates();
  }

  getCardSize() {
    return Math.ceil((this._config?.height ?? 420) / 50);
  }

  static getStubConfig() {
    return { plan_url: '/local/casa3d/casa.json', skin: 'minimal', mode: '3d' };
  }

  private async loadPlan(url: string) {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      this._plan = (await res.json()) as FloorPlan;
    } catch (e) {
      this._error = `Impossibile caricare ${url}: ${(e as Error).message}`;
    }
  }

  private relevantStates(): StateMap {
    const out: StateMap = {};
    if (!this._hass || !this._plan) return out;
    for (const r of this._plan.rooms) for (const e of r.entities) out[e.entity_id] = this._hass.states[e.entity_id];
    return out;
  }

  private _lastKey = '';
  private refreshStates() {
    // aggiorna solo se cambia lo stato delle entità della planimetria (hass cambia a ogni evento)
    const states = this.relevantStates();
    const key = JSON.stringify(states, (k, v) => (k === 'context' || k === 'last_updated' ? undefined : v));
    if (key === this._lastKey) return;
    this._lastKey = key;
    if (this._mode === '3d') this._scene?.setStates(states);
    else this.requestUpdate();
  }

  private onEntity(entityId: string) {
    if (!this._hass) return;
    if (TOGGLABLE.has(entityId.split('.')[0])) {
      this._hass.callService('homeassistant', 'toggle', { entity_id: entityId });
    } else {
      this.dispatchEvent(new CustomEvent('hass-more-info', { detail: { entityId }, bubbles: true, composed: true }));
    }
  }

  protected render() {
    if (this._error) return html`<ha-card><div class="error">${this._error}</div></ha-card>`;
    const h = this._config?.height ?? 420;
    const toggle =
      this._config?.show_mode_toggle !== false
        ? html`<div class="toggle">
            <button class=${this._mode === '2d' ? 'on' : ''} @click=${() => this.setMode('2d')}>2D</button>
            <button class=${this._mode === '3d' ? 'on' : ''} @click=${() => this.setMode('3d')}>3D</button>
          </div>`
        : '';
    return html`<ha-card style="background:${this._skin.background}">
      ${this._config?.title ? html`<div class="title" style="color:${this._skin.text}">${this._config.title}</div>` : ''}
      ${toggle}
      <div class="view" id="view" style="height:${h}px" @click=${this.onSvgClick}></div>
    </ha-card>`;
  }

  private setMode(m: '2d' | '3d') {
    this._mode = m;
  }

  private onSvgClick = (ev: Event) => {
    if (this._mode !== '2d') return;
    const g = (ev.target as Element).closest?.('[data-entity]');
    if (g) this.onEntity(g.getAttribute('data-entity')!);
  };

  protected updated(changed: PropertyValues) {
    const view = this.renderRoot.querySelector('#view') as HTMLElement | null;
    if (!view || !this._plan) return;
    if (this._mode === '2d') {
      this._scene?.dispose();
      this._scene = undefined;
      view.innerHTML = renderSVG(this._plan, this._skin, { states: this.relevantStates() });
      return;
    }
    if (!this._scene || changed.has('_plan') || changed.has('_mode')) {
      view.innerHTML = '';
      this._scene?.dispose();
      this._scene = new FloorScene3D(view, { onEntityClick: (id) => this.onEntity(id) });
      this._scene.setPlan(this._plan, this._skin);
      this._scene.setStates(this.relevantStates());
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._scene?.dispose();
    this._scene = undefined;
  }

  connectedCallback() {
    super.connectedCallback();
    if (this._plan && this.hasUpdated) this.requestUpdate('_plan');
  }
}

if (!customElements.get('casa3d-card')) customElements.define('casa3d-card', Casa3DCard);

declare global {
  interface Window {
    customCards?: { type: string; name: string; description: string; preview?: boolean }[];
  }
}
window.customCards = window.customCards ?? [];
window.customCards.push({
  type: 'casa3d-card',
  name: 'Casa 3D',
  description: 'Planimetria 2D/3D della casa con stato live delle entità e skin',
  preview: false,
});
