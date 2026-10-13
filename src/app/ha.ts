// Client minimale per la WebSocket API di Home Assistant (autenticazione con token long-lived).

import type { EntityState, StateMap } from '../core/model';

export class HAClient {
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  states: StateMap = {};
  onStates?: (states: StateMap) => void;

  async connect(baseUrl: string, token: string): Promise<void> {
    const url = baseUrl.replace(/\/$/, '').replace(/^http/, 'ws') + '/api/websocket';
    const ws = new WebSocket(url);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.onerror = () => reject(new Error('Connessione WebSocket fallita'));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string);
        if (msg.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: token }));
        else if (msg.type === 'auth_invalid') reject(new Error('Token non valido'));
        else if (msg.type === 'auth_ok') {
          ws.onmessage = (e) => this.handle(JSON.parse(e.data as string));
          resolve();
        }
      };
    });
    const list = (await this.call({ type: 'get_states' })) as (EntityState & { entity_id: string })[];
    for (const s of list) this.states[s.entity_id] = s;
    this.onStates?.(this.states);
    await this.call({ type: 'subscribe_events', event_type: 'state_changed' });
  }

  call(msg: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    this.ws!.send(JSON.stringify({ ...msg, id }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  callService(domain: string, service: string, data: Record<string, unknown>) {
    return this.call({ type: 'call_service', domain, service, service_data: data });
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private handle(msg: { id: number; type: string; success?: boolean; result?: unknown; error?: { message: string }; event?: any }) {
    if (msg.type === 'event' && msg.event?.event_type === 'state_changed') {
      const { entity_id, new_state } = msg.event.data;
      this.states = { ...this.states, [entity_id]: new_state ?? undefined };
      this.onStates?.(this.states);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.type === 'result' && msg.success === false) p.reject(new Error(msg.error?.message ?? 'Errore'));
    else p.resolve(msg.result);
  }
}
