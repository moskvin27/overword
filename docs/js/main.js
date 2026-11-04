import { kvGet, kvSet, fileGet, fileSet, fileDel, fileKeys, emptyState, normalizeState, mergeStates, hashFile } from './store.js';
import { loadDict, lemmaOf, entry as dictEntry, shortRu } from './dict.js';
import { PdfView, sentenceAt } from './pdfview.js';
import * as speech from './speech.js';
import * as tr from './translate.js';
import { Sync } from './sync.js';

// ---------- палитра: у каждого слова свой цвет ----------
const COLORS = [
  { c: '232,163,61', line: '168,106,18', ink: '126,74,6', dot: '#E8A33D' },
  { c: '56,178,172', line: '31,122,117', ink: '21,89,85', dot: '#38B2AC' },
  { c: '146,112,214', line: '106,75,176', ink: '79,53,144', dot: '#9270D6' },
  { c: '232,108,128', line: '178,64,90', ink: '140,44,66', dot: '#E86C80' },
  { c: '88,140,224', line: '47,98,179', ink: '33,75,142', dot: '#588CE0' },
  { c: '120,180,90', line: '76,127,46', ink: '58,99,34', dot: '#78B45A' },
  { c: '240,128,70', line: '186,84,30', ink: '140,60,18', dot: '#F08046' },
  { c: '190,165,60', line: '138,116,20', ink: '100,84,10', dot: '#BEA53C' },
];
const colorOf = (rec) => COLORS[(rec && rec.color ? rec.color : 0) % COLORS.length];

const $ = (id) => document.getElementById(id);
const el = {
  pager: $('pager'), prev: $('prevBtn'), next: $('nextBtn'), pageInput: $('pageInput'), pageTotal: $('pageTotal'),
  zoomBox: $('zoomBox'), zoomIn: $('zoomIn'), zoomOut: $('zoomOut'), zoomVal: $('zoomVal'),
  libraryBtn: $('libraryBtn'), dictBtn: $('dictBtn'), dictCount: $('dictCount'), bookTitle: $('bookTitle'),
  syncPill: $('syncPill'), syncText: $('syncText'), settingsBtn: $('settingsBtn'),
  stage: $('stage'), library: $('library'), drop: $('drop'), fileInput: $('fileInput'), dictStatus: $('dictStatus'),
  recentBox: $('recentBox'), recentList: $('recentList'),
  reader: $('reader'), page: $('page'), canvas: $('pageCanvas'), words: $('wordsLayer'), labels: $('labelsLayer'),
  pageLoading: $('pageLoading'), noText: $('noText'),
  pop: $('pop'), popWord: $('popWord'), popIpa: $('popIpa'), popSpeak: $('popSpeak'), popClose: $('popClose'),
  popForm: $('popForm'), popLabelRow: $('popLabelRow'), popLabelInput: $('popLabelInput'), popMeanings: $('popMeanings'),
  popSentence: $('popSentence'), popButtons: $('popButtons'),
  drawer: $('drawer'), drawerClose: $('drawerClose'), dictSearch: $('dictSearch'), dictList: $('dictList'), dictEmpty: $('dictEmpty'),
  settings: $('settings'), voiceSelect: $('voiceSelect'), rateInput: $('rateInput'), rateVal: $('rateVal'), autoSpeak: $('autoSpeak'),
  testVoice: $('testVoice'), tokenInput: $('tokenInput'), tokenSave: $('tokenSave'), tokenClear: $('tokenClear'), syncInfo: $('syncInfo'),
  exportBtn: $('exportBtn'), importInput: $('importInput'), toast: $('toast'),
};

// ---------- настройки этого компа (не синхронизируются) ----------
const prefs = Object.assign(
  { voice: '', rate: 0.9, autoSpeak: true, zoom: 1, drawer: false, filter: 'page' },
  safeJson(localStorage.getItem('ow.prefs')),
);
function savePrefs() { localStorage.setItem('ow.prefs', JSON.stringify(prefs)); }
function safeJson(s) { try { return JSON.parse(s) || {}; } catch (e) { return {}; } }

// ---------- состояние ----------
let state = emptyState();
let dictLoaded = false;
let book = null; // { id, title, doc, view }
let current = null; // { num, entry, lemmas }
let pageNum = 1;
let activeIdx = -1;
let saveTimer = null;
let showToken = 0;

const sync = new Sync({
  getState: () => state,
  setState: (s) => { state = normalizeState(s); saveLocal(); afterStateChange(); },
  onStatus: (kind, text) => {
    el.syncPill.className = 'sync-pill ' + (kind === 'off' ? '' : kind);
    el.syncText.textContent = text;
    if (el.settings.open) renderSyncInfo();
  },
});

function live(lemma) {
  const r = state.words[lemma];
  return r && !r.del ? r : null;
}
function liveWords() {
  return Object.entries(state.words).filter(([, r]) => !r.del);
}

function saveLocal() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => kvSet('state', state).catch((e) => console.warn(e)), 300);
}
function changed() {
  saveLocal();
  sync.schedulePush();
}

function toast(msg, ms = 2600) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.toast.hidden = true; }, ms);
}

// ---------- запуск ----------
async function init() {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';
  const saved = await kvGet('state').catch(() => null);
  state = normalizeState(saved);
  bindUi();
  renderCount();
  renderLibrary();
  sync.status(sync.enabled ? 'busy' : 'off', sync.enabled ? 'синхра…' : 'синхра выкл');

  try {
    const n = await loadDict((p) => { el.dictStatus.textContent = `Загружаю словарь… ${Math.round(p * 100)}%`; });
    dictLoaded = true;
    el.dictStatus.textContent = `Словарь готов: ${n.toLocaleString('ru-RU')} слов. Работает без интернета.`;
  } catch (e) {
    el.dictStatus.textContent = 'Словарь не загрузился. Обнови страницу.';
    console.error(e);
  }

  if (sync.enabled) sync.syncNow();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => current && decorate());
}

// ---------- библиотека ----------
async function renderLibrary() {
  const keys = new Set(await fileKeys().catch(() => []));
  const books = Object.entries(state.books).filter(([, b]) => !b.del).sort((a, b) => (b[1].u || 0) - (a[1].u || 0));
  el.recentBox.hidden = books.length === 0;
  el.recentList.textContent = '';
  for (const [id, b] of books) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'book';
    const pct = b.pages ? Math.round(((b.page || 1) / b.pages) * 100) : 0;
    btn.innerHTML = `
      <span class="book-cover" aria-hidden="true">Aa</span>
      <span class="book-main">
        <span class="book-title"></span>
        <span class="book-meta">стр. ${b.page || 1} из ${b.pages || '?'} · ${pct}%</span>
        <span class="book-bar"><i style="width:${pct}%"></i></span>
      </span>`;
    btn.querySelector('.book-title').textContent = b.title || 'Без названия';
    if (!keys.has(id)) {
      const tag = document.createElement('span');
      tag.className = 'book-tag';
      tag.textContent = 'открой PDF на этом компе';
      btn.appendChild(tag);
    }
    btn.addEventListener('click', async () => {
      const f = await fileGet(id).catch(() => null);
      if (f && f.blob) openBlob(id, f.blob, f.name || b.title);
      else { toast('Выбери этот же PDF — продолжишь с того же места'); el.fileInput.click(); }
    });
    const del = document.createElement('button');
    del.className = 'book-del';
    del.setAttribute('aria-label', 'Убрать книгу из списка');
    del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Убрать «${b.title}» из списка? Слова в словаре останутся.`)) return;
      state.books[id] = { ...b, del: true, u: Date.now() };
      await fileDel(id).catch(() => {});
      changed();
      renderLibrary();
    });
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;gap:8px;align-items:center';
    wrap.append(btn, del);
    li.appendChild(wrap);
    el.recentList.appendChild(li);
  }
}

async function openFile(file) {
  if (!file) return;
  if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) { toast('Это не PDF'); return; }
  const id = await hashFile(file);
  await fileSet(id, { blob: file, name: file.name }).catch((e) => console.warn('не сохранил файл', e));
  openBlob(id, file, file.name);
}

async function openBlob(id, blob, name) {
  closePop();
  if (book) { try { book.doc.destroy(); } catch (e) { /* ок */ } book = null; }
  el.library.hidden = true;
  el.reader.hidden = false;
  el.pageLoading.hidden = false;
  el.words.textContent = '';
  el.labels.textContent = '';
  try {
    const data = new Uint8Array(await blob.arrayBuffer());
    const doc = await pdfjsLib.getDocument({
      data,
      cMapUrl: 'vendor/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: 'vendor/pdfjs/standard_fonts/',
    }).promise;
    let title = (name || '').replace(/\.pdf$/i, '');
    try {
      const meta = await doc.getMetadata();
      const t = meta && meta.info && meta.info.Title;
      if (t && t.trim().length > 2 && !/untitled|microsoft word/i.test(t)) title = t.trim();
    } catch (e) { /* без метаданных */ }
    const view = new PdfView(doc);
    book = { id, title, doc, view };
    const prev = state.books[id];
    state.books[id] = { title, page: prev && !prev.del ? prev.page || 1 : 1, pages: doc.numPages, u: Date.now() };
    changed();
    el.bookTitle.textContent = title;
    el.pager.hidden = false;
    el.zoomBox.hidden = false;
    el.libraryBtn.hidden = false;
    el.pageTotal.textContent = `/ ${doc.numPages}`;
    el.pageInput.max = doc.numPages;
    fitWidth();
    await showPage(state.books[id].page || 1);
  } catch (e) {
    console.error(e);
    toast('Не получилось открыть PDF: ' + (e.message || e));
    goLibrary();
  }
}

function goLibrary() {
  closePop();
  if (book) { try { book.doc.destroy(); } catch (e) { /* ок */ } }
  book = null;
  current = null;
  el.reader.hidden = true;
  el.library.hidden = false;
  el.pager.hidden = true;
  el.zoomBox.hidden = true;
  el.libraryBtn.hidden = true;
  el.bookTitle.textContent = 'читалка с подстрочником';
  renderLibrary();
  renderDrawer();
}

// ---------- страницы ----------
function stageWidth() {
  const w = el.stage.clientWidth - 48;
  return Math.max(320, Math.min(w, 860) * prefs.zoom);
}

function fitWidth() {
  if (!book) return false;
  el.zoomVal.textContent = Math.round(prefs.zoom * 100) + '%';
  return book.view.setWidth(stageWidth());
}

async function showPage(n) {
  if (!book) return;
  n = Math.max(1, Math.min(book.view.pages, Math.round(n) || 1));
  const token = ++showToken;
  pageNum = n;
  el.pageInput.value = n;
  closePop();
  const slow = setTimeout(() => { if (token === showToken) el.pageLoading.hidden = false; }, 120);
  let entry;
  try {
    entry = await book.view.get(n);
  } catch (e) {
    clearTimeout(slow);
    console.error(e);
    toast('Страница не нарисовалась');
    return;
  }
  clearTimeout(slow);
  if (token !== showToken) return;
  el.pageLoading.hidden = true;

  // Меняем холст целиком: готовая страница из кэша показывается мгновенно
  const canvas = entry.canvas;
  canvas.id = 'pageCanvas';
  const old = el.page.querySelector('canvas');
  if (old !== canvas) el.page.replaceChild(canvas, old);
  el.canvas = canvas;
  el.page.style.width = entry.cssW + 'px';
  el.page.style.height = entry.cssH + 'px';

  const lemmas = entry.words.map((w) => lemmaOf(w.join || w.word));
  current = { num: n, entry, lemmas };
  buildWordButtons();
  decorate();
  el.noText.hidden = entry.words.length > 0;
  el.stage.scrollTop = 0;

  const b = state.books[book.id];
  if (b && b.page !== n) { state.books[book.id] = { ...b, page: n, u: Date.now() }; changed(); }
  book.view.prefetchAround(n);
  renderDrawer();
}

function buildWordButtons() {
  const frag = document.createDocumentFragment();
  for (const w of current.entry.words) {
    const b = document.createElement('button');
    b.className = 'w';
    b.type = 'button';
    b.dataset.i = w.i;
    b.tabIndex = -1;
    b.style.left = w.x.toFixed(1) + 'px';
    b.style.top = w.y.toFixed(1) + 'px';
    b.style.width = w.w.toFixed(1) + 'px';
    b.style.height = w.h.toFixed(1) + 'px';
    b.setAttribute('aria-label', w.word);
    frag.appendChild(b);
  }
  el.words.textContent = '';
  el.words.appendChild(frag);
}

function pinKey(i) { return `${current.num}:${i}`; }
function pinIndexFor(i) {
  // у слова с переносом надпись живёт на первой половинке
  const w = current.entry.words[i];
  if (w && w.joinPart) return i - 1;
  return i;
}
function isPinned(rec, i) {
  const pins = rec.pins && book && rec.pins[book.id];
  return !!(pins && pins.includes(pinKey(i)));
}

// Подсветка и надписи для видимой страницы
function decorate() {
  if (!current) return;
  const btns = el.words.children;
  const words = current.entry.words;
  const pinnedList = [];
  for (let i = 0; i < btns.length; i++) {
    const rec = live(current.lemmas[i]);
    const b = btns[i];
    if (!rec) { b.className = 'w' + (i === activeIdx ? ' active' : ''); continue; }
    const col = colorOf(rec);
    const pinned = isPinned(rec, pinIndexFor(i));
    b.className = 'w saved' + (pinned ? ' pinned' : '') + (i === activeIdx ? ' active' : '');
    b.style.setProperty('--c', col.c);
    b.style.setProperty('--c-line', col.line);
    if (pinned && !words[i].joinPart) pinnedList.push({ i, rec, col });
  }
  placeLabels(pinnedList);
}

function placeLabels(list) {
  el.labels.textContent = '';
  if (!list.length) return;
  const words = current.entry.words;
  const pageW = current.entry.cssW;
  const size = Math.round(Math.max(11, Math.min(14, 12 * (pageW / 760))));
  // 1) рисуем надписи невидимыми, чтобы померить реальную ширину шрифта
  const items = list.map(({ i, rec, col }) => {
    const w = words[i];
    const text = (rec.ru || shortRu(current.lemmas[i]) || '…').trim();
    const d = document.createElement('div');
    d.className = 'lbl';
    d.textContent = text;
    d.title = text;
    d.style.cssText = `left:0;top:0;visibility:hidden;--lbl-size:${size}px;--c:${col.c};--c-ink:${col.ink}`;
    el.labels.appendChild(d);
    return { i, w, d, cx: w.x + w.w / 2 };
  });
  for (const it of items) it.natural = it.d.offsetWidth + 1;
  items.sort((a, b) => a.w.y - b.w.y || a.w.x - b.w.x);

  // 2) раскладываем по строкам без наложений
  const lines = [];
  for (const it of items) {
    const line = lines.find((l) => Math.abs(l.y - it.w.y) < it.w.h * 0.5);
    if (line) line.items.push(it); else lines.push({ y: it.w.y, items: [it] });
  }
  for (const line of lines) {
    line.items.sort((a, b) => a.cx - b.cx);
    let prevRight = -Infinity;
    line.items.forEach((it, k) => {
      const next = line.items[k + 1];
      let left = Math.max(it.cx - it.natural / 2, prevRight + 3, 0);
      let limit = pageW;
      if (next) limit = Math.max(next.cx - Math.min(next.natural, next.w.w + 16) / 2, left + 26);
      let width = Math.min(it.natural, limit - left - 3);
      if (width < 26) width = 26;
      if (left + width > pageW) left = Math.max(0, pageW - width);
      prevRight = left + width;
      it.d.style.left = left.toFixed(1) + 'px';
      it.d.style.top = (it.w.y + 2).toFixed(1) + 'px';
      it.d.style.maxWidth = width.toFixed(1) + 'px';
      it.d.style.visibility = '';
    });
  }
}

// ---------- клик по слову ----------
function onWordClick(i) {
  if (!current) return;
  const w = current.entry.words[i];
  const lemma = current.lemmas[i];
  if (activeIdx === i && !el.pop.hidden) { closePop(); return; }
  const rec = live(lemma);
  if (!rec && dictEntry(lemma)) {
    // первый клик: в словарь + надпись над этим местом
    const now = Date.now();
    state.words[lemma] = {
      ru: shortRu(lemma),
      color: state.nextColor % COLORS.length,
      pins: { [book.id]: [pinKey(pinIndexFor(i))] },
      u: now,
      at: now,
    };
    state.nextColor = (state.nextColor || 0) + 1;
    changed();
    renderCount();
    if (prefs.autoSpeak) speech.speak(w.join || w.word, voiceOpts());
  }
  openPop(i);
}

function voiceOpts() { return { voiceName: prefs.voice, rate: prefs.rate }; }

function openPop(i) {
  activeIdx = i;
  decorate();
  renderDrawer();
  const w = current.entry.words[i];
  const shown = w.join || w.word;
  const lemma = current.lemmas[i];
  const rec = live(lemma);
  const ent = dictEntry(lemma);

  el.popWord.textContent = lemma;
  el.popIpa.textContent = ent && ent.ipa ? `[${ent.ipa}]` : '';
  el.popForm.textContent = shown.toLowerCase() !== lemma ? `в тексте: ${shown}` : '';
  el.popForm.hidden = !el.popForm.textContent;

  // надпись
  el.popLabelRow.hidden = !rec;
  if (rec) el.popLabelInput.value = rec.ru || '';

  // значения
  el.popMeanings.textContent = '';
  if (ent) {
    for (const [pos, means] of ent.groups) {
      const g = document.createElement('div');
      g.className = 'pos-group';
      if (pos) { const p = document.createElement('span'); p.className = 'pos'; p.textContent = pos; g.appendChild(p); }
      for (const m of means) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'mean';
        b.textContent = m;
        const short = m.split(/[,;]/)[0].replace(/\([^)]*\)/g, '').trim();
        if (rec && rec.ru === short) b.classList.add('on');
        b.title = 'Сделать надписью над словом';
        b.addEventListener('click', () => setLabel(lemma, short, i));
        g.appendChild(b);
      }
      el.popMeanings.appendChild(g);
    }
  } else {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Этого слова нет в словаре (имя, редкое слово или сокращение). Смотри перевод предложения ниже или впиши свой.';
    el.popMeanings.appendChild(p);
  }

  // кнопки
  el.popButtons.textContent = '';
  const btn = (text, cls, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    if (cls) b.className = cls;
    b.addEventListener('click', fn);
    el.popButtons.appendChild(b);
  };
  if (rec) {
    const pIdx = pinIndexFor(i);
    if (isPinned(rec, pIdx)) btn('Убрать надпись', '', () => togglePin(lemma, pIdx, false));
    else btn('Подписать здесь', 'main', () => togglePin(lemma, pIdx, true));
    btn('Удалить из словаря', 'danger', () => removeWord(lemma));
  } else {
    btn('Добавить в словарь', 'main', () => addCustom(lemma, i));
  }

  // предложение
  const sentence = sentenceAt(current.entry.text, w.at);
  fillSentence(sentence);

  // позиция
  if (el.pop.parentElement !== el.page) el.page.appendChild(el.pop);
  el.pop.hidden = false;
  const pw = el.pop.offsetWidth;
  const ph = el.pop.offsetHeight;
  const pageW = current.entry.cssW;
  const pageH = current.entry.cssH;
  let left = w.x + w.w / 2 - pw / 2;
  left = Math.max(-12, Math.min(left, pageW - pw + 12));
  let top = w.y + w.h + 10;
  if (top + ph > pageH + 40 && w.y - ph - 26 > 0) top = w.y - ph - 26;
  el.pop.style.left = left + 'px';
  el.pop.style.top = top + 'px';
  requestAnimationFrame(() => el.pop.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
}

let sentenceToken = 0;
async function fillSentence(sentence) {
  const token = ++sentenceToken;
  el.popSentence.textContent = '';
  const out = document.createElement('span');
  const orig = document.createElement('span');
  orig.className = 'orig';
  orig.textContent = sentence;
  el.popSentence.append(out, orig);
  if (!sentence) { out.textContent = '—'; return; }
  if (!tr.supported()) {
    out.textContent = 'Перевод предложения работает в Chrome 138+ или Edge на компе.';
    return;
  }
  out.textContent = 'Перевожу…';
  try {
    const res = await tr.translateSentence(sentence, (p) => {
      if (token === sentenceToken) out.textContent = `Скачиваю модель перевода (один раз)… ${Math.round(p * 100)}%`;
    });
    if (token === sentenceToken) out.textContent = res;
  } catch (e) {
    console.warn(e);
    if (token === sentenceToken) out.textContent = 'Переводчик Chrome сейчас недоступен. Проверь, что Chrome обновлён.';
  }
}

function closePop() {
  el.pop.hidden = true;
  if (activeIdx !== -1) { activeIdx = -1; if (current) decorate(); }
}

function setLabel(lemma, text, i) {
  const rec = live(lemma);
  if (!rec) return;
  state.words[lemma] = { ...rec, ru: text, u: Date.now() };
  changed();
  decorate();
  renderDrawer();
  if (i != null && !el.pop.hidden) openPop(i);
}

function togglePin(lemma, idx, on) {
  const rec = live(lemma);
  if (!rec) return;
  const pins = { ...(rec.pins || {}) };
  const list = new Set(pins[book.id] || []);
  if (on) list.add(pinKey(idx)); else list.delete(pinKey(idx));
  pins[book.id] = [...list];
  state.words[lemma] = { ...rec, pins, u: Date.now() };
  changed();
  openPop(activeIdx);
}

function removeWord(lemma) {
  state.words[lemma] = { del: true, u: Date.now() };
  changed();
  renderCount();
  closePop();
  decorate();
  renderDrawer();
  toast(`«${lemma}» удалено из словаря`);
}

function addCustom(lemma, i) {
  const now = Date.now();
  state.words[lemma] = {
    ru: '',
    color: state.nextColor % COLORS.length,
    pins: { [book.id]: [pinKey(pinIndexFor(i))] },
    u: now,
    at: now,
  };
  state.nextColor = (state.nextColor || 0) + 1;
  changed();
  renderCount();
  openPop(i);
  el.popLabelInput.focus();
}

// ---------- словарь сбоку ----------
function renderCount() {
  el.dictCount.textContent = liveWords().length;
}

function renderDrawer() {
  if (el.drawer.hidden) return;
  const q = el.dictSearch.value.trim().toLowerCase();
  const counts = {};
  if (current) for (const l of current.lemmas) counts[l] = (counts[l] || 0) + 1;
  let list = liveWords().sort((a, b) => (b[1].at || b[1].u || 0) - (a[1].at || a[1].u || 0));
  if (prefs.filter === 'page') list = list.filter(([k]) => counts[k]);
  if (q) list = list.filter(([k, r]) => k.includes(q) || (r.ru || '').toLowerCase().includes(q));
  el.dictList.textContent = '';
  el.dictEmpty.hidden = list.length > 0;
  el.dictEmpty.textContent = liveWords().length === 0
    ? 'Пока пусто. Кликни незнакомое слово в книге.'
    : prefs.filter === 'page' ? 'На этой странице слов из словаря нет.' : 'Ничего не нашлось.';
  const frag = document.createDocumentFragment();
  for (const [lemma, rec] of list.slice(0, 400)) {
    const li = document.createElement('li');
    li.className = 'dict-item';
    const dot = document.createElement('span');
    dot.className = 'dict-dot';
    dot.style.background = colorOf(rec).dot;
    const main = document.createElement('div');
    main.className = 'dict-main';
    const w = document.createElement('span');
    w.className = 'dict-word';
    w.textContent = lemma;
    const ru = document.createElement('span');
    ru.className = 'dict-ru';
    ru.textContent = rec.ru || shortRu(lemma) || '—';
    main.append(w, ru);
    li.append(dot, main);
    if (counts[lemma]) {
      const c = document.createElement('span');
      c.className = 'dict-count';
      c.textContent = '×' + counts[lemma];
      li.appendChild(c);
    }
    const sp = document.createElement('button');
    sp.className = 'round';
    sp.setAttribute('aria-label', 'Прослушать ' + lemma);
    sp.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>';
    sp.addEventListener('click', () => speech.speak(lemma, voiceOpts()));
    li.appendChild(sp);
    if (counts[lemma]) {
      main.style.cursor = 'pointer';
      main.addEventListener('click', () => {
        const i = current.lemmas.indexOf(lemma);
        if (i >= 0) openPop(i);
      });
    }
    frag.appendChild(li);
  }
  el.dictList.appendChild(frag);
}

function toggleDrawer(open) {
  prefs.drawer = open == null ? el.drawer.hidden : open;
  savePrefs();
  el.drawer.hidden = !prefs.drawer;
  renderDrawer();
  requestAnimationFrame(onResize);
}

function afterStateChange() {
  renderCount();
  if (current) decorate();
  renderDrawer();
  if (!book) renderLibrary();
}

// ---------- настройки ----------
function fillVoices() {
  const list = speech.listVoices();
  el.voiceSelect.textContent = '';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'Авто (лучший доступный)';
  el.voiceSelect.appendChild(auto);
  for (const v of list) {
    const o = document.createElement('option');
    o.value = v.name;
    o.textContent = `${v.name} · ${v.lang}${/google/i.test(v.name) ? ' · онлайн' : ''}`;
    el.voiceSelect.appendChild(o);
  }
  el.voiceSelect.value = prefs.voice;
}

function renderSyncInfo() {
  if (!sync.enabled) { el.syncInfo.textContent = 'Синхра выключена. Словарь хранится только в этом браузере.'; return; }
  const parts = [];
  if (sync.lastOk) parts.push('Последняя синхра: ' + sync.lastOk.toLocaleString('ru-RU'));
  if (sync.gistId) parts.push('Гист: ' + sync.gistId.slice(0, 8) + '…');
  if (sync.lastError) parts.push('Ошибка: ' + sync.lastError);
  el.syncInfo.textContent = parts.join(' · ') || 'Подключаюсь…';
}

function openSettings() {
  fillVoices();
  el.rateInput.value = prefs.rate;
  el.rateVal.textContent = prefs.rate.toFixed(1);
  el.autoSpeak.checked = prefs.autoSpeak;
  el.tokenInput.value = sync.token ? '••••••••' + sync.token.slice(-4) : '';
  renderSyncInfo();
  el.settings.showModal();
}

// ---------- события ----------
function onResize() {
  if (!book || !current) return;
  if (fitWidth()) showPage(pageNum);
}

function bindUi() {
  el.fileInput.addEventListener('change', () => { openFile(el.fileInput.files[0]); el.fileInput.value = ''; });
  ['dragenter', 'dragover'].forEach((t) => el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.remove('over'); }));
  el.drop.addEventListener('drop', (e) => openFile(e.dataTransfer.files[0]));
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) openFile(e.dataTransfer.files[0]); });

  el.prev.addEventListener('click', () => showPage(pageNum - 1));
  el.next.addEventListener('click', () => showPage(pageNum + 1));
  el.pageInput.addEventListener('change', () => showPage(Number(el.pageInput.value)));
  el.zoomIn.addEventListener('click', () => { prefs.zoom = Math.min(2, +(prefs.zoom + 0.1).toFixed(2)); savePrefs(); onResize(); });
  el.zoomOut.addEventListener('click', () => { prefs.zoom = Math.max(0.6, +(prefs.zoom - 0.1).toFixed(2)); savePrefs(); onResize(); });
  el.libraryBtn.addEventListener('click', goLibrary);
  el.dictBtn.addEventListener('click', () => toggleDrawer());
  el.drawerClose.addEventListener('click', () => toggleDrawer(false));
  el.dictSearch.addEventListener('input', renderDrawer);
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    prefs.filter = t.dataset.filter;
    savePrefs();
    document.querySelectorAll('.tab').forEach((x) => { x.classList.toggle('active', x === t); x.setAttribute('aria-selected', x === t); });
    renderDrawer();
  }));
  document.querySelectorAll('.tab').forEach((x) => { const on = x.dataset.filter === prefs.filter; x.classList.toggle('active', on); x.setAttribute('aria-selected', on); });
  if (prefs.drawer) { el.drawer.hidden = false; }

  el.words.addEventListener('click', (e) => {
    const b = e.target.closest('.w');
    if (b) { e.stopPropagation(); onWordClick(Number(b.dataset.i)); }
  });
  el.pop.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', (e) => {
    if (!el.pop.hidden && !el.pop.contains(e.target) && !e.target.closest('.dict-item')) closePop();
  });
  el.popClose.addEventListener('click', closePop);
  el.popSpeak.addEventListener('click', () => {
    if (activeIdx < 0) return;
    const w = current.entry.words[activeIdx];
    speech.speak(w.join || w.word, voiceOpts());
  });
  el.popLabelInput.addEventListener('input', () => {
    if (activeIdx < 0) return;
    const lemma = current.lemmas[activeIdx];
    const rec = live(lemma);
    if (!rec) return;
    state.words[lemma] = { ...rec, ru: el.popLabelInput.value.trim(), u: Date.now() };
    changed();
    decorate();
    el.popMeanings.querySelectorAll('.mean').forEach((m) => m.classList.remove('on'));
  });
  el.popLabelInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') closePop(); });

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || el.settings.open;
    if (e.key === 'Escape') { if (!el.pop.hidden) closePop(); return; }
    if (typing || !book) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); showPage(pageNum + 1); }
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); showPage(pageNum - 1); }
  });

  let rt = null;
  new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(onResize, 180); }).observe(el.stage);

  // настройки
  el.settingsBtn.addEventListener('click', openSettings);
  el.syncPill.addEventListener('click', openSettings);
  speech.onVoices(() => { if (el.settings.open) fillVoices(); });
  el.voiceSelect.addEventListener('change', () => { prefs.voice = el.voiceSelect.value; savePrefs(); });
  el.rateInput.addEventListener('input', () => { prefs.rate = Number(el.rateInput.value); el.rateVal.textContent = prefs.rate.toFixed(1); savePrefs(); });
  el.autoSpeak.addEventListener('change', () => { prefs.autoSpeak = el.autoSpeak.checked; savePrefs(); });
  el.testVoice.addEventListener('click', () => speech.speak('The tide always returns what the sea borrows.', voiceOpts()));
  el.tokenInput.addEventListener('focus', () => { if (el.tokenInput.value.startsWith('••')) el.tokenInput.value = ''; });
  el.tokenSave.addEventListener('click', async () => {
    const t = el.tokenInput.value.trim();
    if (!t || t.startsWith('••')) { toast('Вставь токен'); return; }
    await sync.setToken(t);
    renderSyncInfo();
    if (!sync.lastError) toast('Синхра подключена 👌'); else toast(sync.lastError, 5000);
  });
  el.tokenClear.addEventListener('click', () => { sync.disable(); el.tokenInput.value = ''; renderSyncInfo(); });
  el.exportBtn.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `overword-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  el.importInput.addEventListener('change', async () => {
    const f = el.importInput.files[0];
    el.importInput.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      state = mergeStates(state, data);
      changed();
      afterStateChange();
      toast('Словарь загружен и объединён');
    } catch (e) { toast('Файл не похож на словарь Overword'); }
  });

  window.addEventListener('focus', () => sync.pullIfStale());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { kvSet('state', state).catch(() => {}); sync.flushOnExit(); }
    else sync.pullIfStale();
  });
  setInterval(() => { if (document.visibilityState === 'visible') sync.pullIfStale(); }, 3 * 60 * 1000);
}

init();
