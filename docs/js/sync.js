// Синхра через приватный GitHub Gist: словарь, надписи и место в книге.

import { mergeStates, normalizeState } from './store.js';

const FILE = 'overword-sync.json';
const API = 'https://api.github.com';
const LS_TOKEN = 'ow.token';
const LS_GIST = 'ow.gist';

export class Sync {
  constructor({ getState, setState, onStatus }) {
    this.getState = getState;
    this.setState = setState;
    this.onStatus = onStatus;
    this.token = localStorage.getItem(LS_TOKEN) || '';
    this.gistId = localStorage.getItem(LS_GIST) || '';
    this.pushTimer = null;
    this.busy = false;
    this.lastPull = 0;
    this.lastRemote = '';
    this.lastOk = null;
  }

  get enabled() { return !!this.token; }

  status(kind, text) { this.onStatus && this.onStatus(kind, text); }

  async api(path, opts = {}) {
    const res = await fetch(API + path, {
      ...opts,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (res.status === 401) throw new Error('Токен не подходит (401). Создай новый с галкой gist.');
    if (res.status === 403 || res.status === 404) {
      const txt = await res.text();
      throw new Error(`GitHub ответил ${res.status}: ${txt.slice(0, 120)}`);
    }
    if (!res.ok) throw new Error(`GitHub ответил ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  async setToken(token) {
    this.token = token.trim();
    this.gistId = '';
    localStorage.setItem(LS_TOKEN, this.token);
    localStorage.removeItem(LS_GIST);
    return this.syncNow();
  }

  disable() {
    this.token = '';
    this.gistId = '';
    localStorage.removeItem(LS_TOKEN);
    localStorage.removeItem(LS_GIST);
    this.status('off', 'синхра выкл');
  }

  async findGist() {
    if (this.gistId) return this.gistId;
    for (let page = 1; page <= 5; page++) {
      const list = await this.api(`/gists?per_page=100&page=${page}`);
      const g = list.find((x) => x.files && x.files[FILE]);
      if (g) {
        this.gistId = g.id;
        localStorage.setItem(LS_GIST, g.id);
        return g.id;
      }
      if (list.length < 100) break;
    }
    return '';
  }

  async readRemote() {
    const id = await this.findGist();
    if (!id) return null;
    const g = await this.api(`/gists/${id}`);
    const f = g.files && g.files[FILE];
    if (!f) return null;
    let content = f.content;
    if (f.truncated && f.raw_url) content = await (await fetch(f.raw_url)).text();
    try { return JSON.parse(content); } catch (e) { return null; }
  }

  async writeRemote(state) {
    const content = JSON.stringify(state);
    if (content === this.lastRemote) return;
    if (!this.gistId) {
      const g = await this.api('/gists', {
        method: 'POST',
        body: JSON.stringify({ description: 'Overword — словарь и прогресс чтения', public: false, files: { [FILE]: { content } } }),
      });
      this.gistId = g.id;
      localStorage.setItem(LS_GIST, g.id);
    } else {
      await this.api(`/gists/${this.gistId}`, { method: 'PATCH', body: JSON.stringify({ files: { [FILE]: { content } } }) });
    }
    this.lastRemote = content;
  }

  // Забрать с GitHub, слить с локальным, отправить обратно, если есть что-то новое.
  async syncNow() {
    if (!this.enabled || this.busy) return;
    if (!navigator.onLine) { this.status('err', 'нет сети'); return; }
    this.busy = true;
    this.status('busy', 'синхра…');
    try {
      const remote = await this.readRemote();
      const local = this.getState();
      const merged = remote ? mergeStates(local, remote) : normalizeState(local);
      if (remote) this.lastRemote = JSON.stringify(normalizeState(remote));
      if (JSON.stringify(merged) !== JSON.stringify(normalizeState(local))) this.setState(merged);
      await this.writeRemote(merged);
      this.lastPull = Date.now();
      this.lastOk = new Date();
      this.status('ok', 'синхра ' + this.lastOk.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }));
    } catch (e) {
      console.warn('sync', e);
      this.status('err', 'ошибка синхры');
      this.lastError = e.message;
    } finally {
      this.busy = false;
    }
  }

  schedulePush() {
    if (!this.enabled) return;
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => this.syncNow(), 8000);
  }

  pullIfStale() {
    if (this.enabled && Date.now() - this.lastPull > 60000) this.syncNow();
  }

  // При закрытии вкладки — быстрая отправка без ожидания ответа.
  flushOnExit() {
    if (!this.enabled || !this.gistId || !this.pushTimer) return;
    clearTimeout(this.pushTimer);
    this.pushTimer = null;
    const content = JSON.stringify(this.getState());
    if (content === this.lastRemote || content.length > 60000) return;
    try {
      fetch(`${API}/gists/${this.gistId}`, {
        method: 'PATCH',
        keepalive: true,
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: { [FILE]: { content } } }),
      });
    } catch (e) { /* не страшно, отправим при следующем открытии */ }
  }
}
