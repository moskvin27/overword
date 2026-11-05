import { kvGet, kvSet, fileGet, fileSet, fileDel, fileKeys, emptyState, normalizeState, mergeStates, hashFile } from './store.js';
import { loadDict, lemmaOf, entry as dictEntry, meanings as dictMeanings, shortRu } from './dict.js';
import { PdfView, sentenceAt } from './pdfview.js';
import { findMatch, tokenizeRu } from './context.js';
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
const NEUTRAL = { c: '200,190,170', line: '150,140,120', ink: '70,66,58', dot: '#8C877C' };

const $ = (id) => document.getElementById(id);
const el = {
  pager: $('pager'), prev: $('prevBtn'), next: $('nextBtn'), pageInput: $('pageInput'), pageTotal: $('pageTotal'),
  zoomBox: $('zoomBox'), zoomIn: $('zoomIn'), zoomOut: $('zoomOut'), zoomVal: $('zoomVal'),
  libraryBtn: $('libraryBtn'), dictBtn: $('dictBtn'), dictCount: $('dictCount'), bookTitle: $('bookTitle'),
  syncPill: $('syncPill'), syncText: $('syncText'), settingsBtn: $('settingsBtn'),
  stage: $('stage'), library: $('library'), drop: $('drop'), fileInput: $('fileInput'), dictStatus: $('dictStatus'),
  recentBox: $('recentBox'), recentList: $('recentList'),
  reader: $('reader'), page: $('page'), words: $('wordsLayer'), labels: $('labelsLayer'),
  pageLoading: $('pageLoading'), noText: $('noText'),
  side: $('side'), sideClose: $('sideClose'), panelPage: $('panelPage'), panelAll: $('panelAll'),
  cards: $('cards'), pageEmpty: $('pageEmpty'), pageCount: $('pageCount'), allCount: $('allCount'),
  dictSearch: $('dictSearch'), dictList: $('dictList'), dictEmpty: $('dictEmpty'),
  settings: $('settings'), voiceSelect: $('voiceSelect'), rateInput: $('rateInput'), rateVal: $('rateVal'),
  autoSpeak: $('autoSpeak'), hoverAll: $('hoverAll'),
  testVoice: $('testVoice'), tokenInput: $('tokenInput'), tokenSave: $('tokenSave'), tokenClear: $('tokenClear'), syncInfo: $('syncInfo'),
  exportBtn: $('exportBtn'), importInput: $('importInput'), toast: $('toast'),
};

// ---------- настройки этого компа (не синхронизируются) ----------
const prefs = Object.assign(
  { voice: '', rate: 0.9, autoSpeak: true, hoverAll: true, zoom: 1, side: true, tab: 'page' },
  safeJson(localStorage.getItem('ow.prefs')),
);
function savePrefs() { localStorage.setItem('ow.prefs', JSON.stringify(prefs)); }
function safeJson(s) { try { return JSON.parse(s) || {}; } catch (e) { return {}; } }

// ---------- состояние ----------
let state = emptyState();
let book = null; // { id, title, doc, view }
let current = null; // { num, entry, lemmas }
let pageNum = 1;
let showToken = 0;
let saveTimer = null;

// панель переводов
let openLemma = null; // какая карточка раскрыта
let openIdx = -1; // по какому вхождению слова на странице кликнули
let tempCard = null; // слово не из словаря: { lemma, idx }
let showAllMeanings = false;
const touched = new Map(); // lemma -> когда последний раз трогали (для порядка карточек)
const ctxCache = new Map(); // "стр:индекс" -> { ru, match }

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
function voiceOpts() { return { voiceName: prefs.voice, rate: prefs.rate }; }
function labelOf(lemma) {
  const r = live(lemma);
  return (r && r.ru) || shortRu(lemma) || '';
}
function svg(path) { return `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`; }
const ICON = {
  speak: svg('<path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>'),
  close: svg('<path d="M18 6L6 18M6 6l12 12"/>'),
  trash: svg('<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>'),
};

// ---------- запуск ----------
async function init() {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';
  const saved = await kvGet('state').catch(() => null);
  state = normalizeState(saved);
  bindUi();
  renderCounts();
  renderLibrary();
  sync.status(sync.enabled ? 'busy' : 'off', sync.enabled ? 'синхра…' : 'синхра выкл');
  try {
    const n = await loadDict((p) => { el.dictStatus.textContent = `Загружаю словарь… ${Math.round(p * 100)}%`; });
    el.dictStatus.textContent = `Словарь готов: ${n.toLocaleString('ru-RU')} слов. Работает без интернета.`;
  } catch (e) {
    el.dictStatus.textContent = 'Словарь не загрузился. Обнови страницу.';
    console.error(e);
  }
  if (sync.enabled) sync.syncNow();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
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
    del.innerHTML = ICON.trash;
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
  if (book) { try { book.doc.destroy(); } catch (e) { /* ок */ } book = null; }
  el.library.hidden = true;
  el.reader.hidden = false;
  el.pageLoading.hidden = false;
  el.words.textContent = '';
  el.labels.textContent = '';
  try {
    const data = new Uint8Array(await blob.arrayBuffer());
    const doc = await pdfjsLib.getDocument({
      data, cMapUrl: 'vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: 'vendor/pdfjs/standard_fonts/',
    }).promise;
    let title = (name || '').replace(/\.pdf$/i, '');
    try {
      const meta = await doc.getMetadata();
      const t = meta && meta.info && meta.info.Title;
      if (t && t.trim().length > 2 && !/untitled|microsoft word/i.test(t)) title = t.trim();
    } catch (e) { /* без метаданных */ }
    book = { id, title, doc, view: new PdfView(doc) };
    const prev = state.books[id];
    state.books[id] = { title, page: prev && !prev.del ? prev.page || 1 : 1, pages: doc.numPages, u: Date.now() };
    changed();
    el.bookTitle.textContent = title;
    el.pager.hidden = false;
    el.zoomBox.hidden = false;
    el.libraryBtn.hidden = false;
    el.side.hidden = !prefs.side;
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
  if (book) { try { book.doc.destroy(); } catch (e) { /* ок */ } }
  book = null;
  current = null;
  closeCard();
  el.reader.hidden = true;
  el.library.hidden = false;
  el.pager.hidden = true;
  el.zoomBox.hidden = true;
  el.libraryBtn.hidden = true;
  el.side.hidden = true;
  el.bookTitle.textContent = 'читалка с подстрочником';
  renderLibrary();
}

// ---------- страницы ----------
function stageWidth() {
  const w = el.stage.clientWidth - 48;
  return Math.max(320, Math.min(w, 900) * prefs.zoom);
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
  const samePage = current && current.num === n;
  pageNum = n;
  el.pageInput.value = n;
  hideTip();
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

  const canvas = entry.canvas;
  const old = el.page.querySelector('canvas');
  if (old !== canvas) el.page.replaceChild(canvas, old);
  el.page.style.width = entry.cssW + 'px';
  el.page.style.height = entry.cssH + 'px';

  current = { num: n, entry, lemmas: entry.words.map((w) => lemmaOf(w.join || w.word)) };
  buildWordButtons();
  if (!samePage) {
    openLemma = null;
    openIdx = -1;
    tempCard = null;
    touched.clear();
    el.stage.scrollTop = 0;
    el.panelPage.scrollTop = 0;
  }
  decorate();
  renderCards();
  el.noText.hidden = entry.words.length > 0;

  const b = state.books[book.id];
  if (b && b.page !== n) { state.books[book.id] = { ...b, page: n, u: Date.now() }; changed(); }
  book.view.prefetchAround(n);
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

// Подсветка слов из словаря на видимой странице
function decorate() {
  if (!current) return;
  const btns = el.words.children;
  for (let i = 0; i < btns.length; i++) {
    const lemma = current.lemmas[i];
    const rec = live(lemma);
    const b = btns[i];
    const active = i === openIdx || (openIdx >= 0 && current.entry.words[openIdx].join && sameJoin(i, openIdx));
    if (!rec) { b.className = 'w' + (active ? ' active' : ''); continue; }
    const col = colorOf(rec);
    b.className = 'w saved' + (active ? ' active' : '');
    b.style.setProperty('--c', col.c);
    b.style.setProperty('--c-line', col.line);
  }
}
function sameJoin(i, j) {
  const w = current.entry.words;
  return Math.abs(i - j) === 1 && w[i].join && w[i].join === w[j].join;
}

// ---------- подсказка при наведении ----------
let tipEl = null;
let tipTimer = null;
let tipIdx = -1;

function showTip(i) {
  if (!current) return;
  const lemma = current.lemmas[i];
  const rec = live(lemma);
  clearTimeout(tipTimer);
  if (!rec && !prefs.hoverAll) return;
  const text = rec ? labelOf(lemma) : shortRu(lemma);
  if (!text) { hideTip(); return; }
  const delay = rec ? 0 : 280;
  tipIdx = i;
  tipTimer = setTimeout(() => {
    if (tipIdx !== i) return;
    if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tip'; }
    if (tipEl.parentElement !== el.labels) el.labels.appendChild(tipEl);
    const w = current.entry.words[i];
    const col = rec ? colorOf(rec) : NEUTRAL;
    tipEl.className = 'tip' + (rec ? '' : ' weak');
    tipEl.textContent = text;
    tipEl.style.setProperty('--c', col.c);
    tipEl.style.setProperty('--c-ink', col.ink);
    tipEl.style.left = '0px';
    tipEl.style.top = '0px';
    tipEl.hidden = false;
    const tw = tipEl.offsetWidth;
    const pageW = current.entry.cssW;
    const left = Math.max(2, Math.min(w.x + w.w / 2 - tw / 2, pageW - tw - 2));
    tipEl.style.left = left.toFixed(1) + 'px';
    tipEl.style.top = (w.y - 3).toFixed(1) + 'px';
  }, delay);
}
function hideTip() {
  clearTimeout(tipTimer);
  tipIdx = -1;
  if (tipEl) tipEl.hidden = true;
}

// ---------- клик по слову ----------
function onWordClick(i) {
  if (!current || !book) return;
  hideTip();
  const w = current.entry.words[i];
  const lemma = current.lemmas[i];
  let rec = live(lemma);
  if (!rec && dictEntry(lemma)) {
    const now = Date.now();
    rec = state.words[lemma] = {
      ru: shortRu(lemma), auto: true, color: state.nextColor % COLORS.length, u: now, at: now,
    };
    state.nextColor = (state.nextColor || 0) + 1;
    changed();
    renderCounts();
    if (prefs.autoSpeak) speech.speak(w.join || w.word, voiceOpts());
  }
  if (rec) { tempCard = null; openCard(lemma, i); } else { tempCard = { lemma, idx: i }; openCard(lemma, i); }
}

function openCard(lemma, idx) {
  openLemma = lemma;
  openIdx = idx;
  showAllMeanings = false;
  touched.set(lemma, Date.now());
  if (prefs.tab !== 'page') setTab('page');
  if (!prefs.side) setSide(true);
  decorate();
  renderCards();
  el.panelPage.scrollTop = 0;
}

function closeCard() {
  openLemma = null;
  openIdx = -1;
  tempCard = null;
  if (current) { decorate(); renderCards(); }
}

// ---------- карточки справа ----------
function pageCounts() {
  const counts = new Map();
  if (current) for (const l of current.lemmas) counts.set(l, (counts.get(l) || 0) + 1);
  return counts;
}

function renderCounts() {
  const total = liveWords().length;
  el.dictCount.textContent = total;
  el.allCount.textContent = total;
}

function renderCards() {
  renderCounts();
  const counts = pageCounts();
  let list = current ? liveWords().filter(([k]) => counts.has(k)) : [];
  list.sort((a, b) => (touched.get(b[0]) || 0) - (touched.get(a[0]) || 0) || (b[1].at || b[1].u || 0) - (a[1].at || a[1].u || 0));
  el.pageCount.textContent = list.length;
  el.cards.textContent = '';
  if (tempCard && !live(tempCard.lemma)) el.cards.appendChild(buildCard(tempCard.lemma, null, counts.get(tempCard.lemma) || 1));
  for (const [lemma, rec] of list) el.cards.appendChild(buildCard(lemma, rec, counts.get(lemma)));
  el.pageEmpty.hidden = el.cards.children.length > 0;
  if (prefs.tab === 'all') renderAll();
}

function buildCard(lemma, rec, count) {
  const isOpen = lemma === openLemma;
  const col = rec ? colorOf(rec) : NEUTRAL;
  const card = document.createElement('div');
  card.className = 'card' + (isOpen ? ' open' : '');
  card.dataset.lemma = lemma;
  card.style.setProperty('--c', col.c);
  card.style.setProperty('--c-line', col.line);

  const row = document.createElement(isOpen ? 'div' : 'button');
  row.className = 'card-row';
  if (!isOpen) {
    row.type = 'button';
    row.addEventListener('click', () => {
      const i = current ? current.lemmas.indexOf(lemma) : -1;
      openCard(lemma, i);
      if (i >= 0) {
        const b = el.words.children[i];
        if (b) b.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    });
  }
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = col.dot;
  const main = document.createElement('span');
  main.className = 'card-main';
  const word = document.createElement('span');
  word.className = 'card-word';
  word.textContent = lemma;
  if (isOpen) {
    const ent = dictEntry(lemma);
    if (ent && ent.ipa) {
      const ipa = document.createElement('span');
      ipa.className = 'card-ipa';
      ipa.textContent = `[${ent.ipa}]`;
      word.appendChild(ipa);
    }
  }
  main.appendChild(word);
  if (!isOpen) {
    const ru = document.createElement('span');
    ru.className = 'card-ru';
    ru.textContent = labelOf(lemma) || '—';
    main.appendChild(ru);
  }
  row.append(dot, main);
  if (!isOpen && count) {
    const n = document.createElement('span');
    n.className = 'card-n';
    n.textContent = '×' + count;
    row.appendChild(n);
  }
  const sp = document.createElement(isOpen ? 'button' : 'span');
  sp.className = 'round' + (isOpen ? ' accent' : '');
  sp.innerHTML = ICON.speak;
  sp.setAttribute('aria-label', 'Прослушать ' + lemma);
  if (isOpen) sp.type = 'button'; else sp.setAttribute('role', 'button');
  sp.addEventListener('click', (e) => {
    e.stopPropagation();
    const w = openIdx >= 0 && isOpen && current ? current.entry.words[openIdx] : null;
    speech.speak(w ? w.join || w.word : lemma, voiceOpts());
  });
  row.appendChild(sp);
  if (isOpen) {
    const cl = document.createElement('button');
    cl.type = 'button';
    cl.className = 'round';
    cl.innerHTML = ICON.close;
    cl.setAttribute('aria-label', 'Свернуть');
    cl.addEventListener('click', closeCard);
    row.appendChild(cl);
  }
  card.appendChild(row);

  // подсветить слово на странице, пока мышь над карточкой
  card.addEventListener('mouseenter', () => glow(lemma, true));
  card.addEventListener('mouseleave', () => glow(lemma, false));

  if (isOpen) card.appendChild(buildCardBody(lemma, rec));
  return card;
}

function glow(lemma, on) {
  if (!current) return;
  const btns = el.words.children;
  current.lemmas.forEach((l, i) => { if (l === lemma && btns[i]) btns[i].classList.toggle('glow', on); });
}

function buildCardBody(lemma, rec) {
  const body = document.createElement('div');
  body.className = 'card-body';
  const w = current && openIdx >= 0 ? current.entry.words[openIdx] : null;
  const shown = w ? w.join || w.word : lemma;
  if (shown.toLowerCase() !== lemma) {
    const f = document.createElement('div');
    f.className = 'card-form';
    f.textContent = `в тексте: ${shown}`;
    body.appendChild(f);
  }

  // мой перевод (он же подсказка при наведении)
  if (rec) {
    const my = document.createElement('label');
    my.className = 'my';
    my.innerHTML = '<span class="cap">Мой перевод</span>';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.maxLength = 60;
    inp.value = rec.ru || '';
    inp.id = 'myInput';
    inp.addEventListener('input', () => {
      const r = live(lemma);
      if (!r) return;
      state.words[lemma] = { ...r, ru: inp.value.trim(), auto: false, u: Date.now() };
      changed();
      body.querySelectorAll('.chip.on').forEach((c) => c.classList.remove('on'));
    });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { inp.blur(); renderCards(); } });
    inp.addEventListener('change', () => renderCards());
    my.appendChild(inp);
    body.appendChild(my);
  }

  // варианты из словаря — компактные чипы, 3 штуки + «ещё»
  const ms = dictMeanings(lemma);
  // значение, которое сейчас выбрано (в т.ч. по контексту), — первым
  const cur = rec && rec.ru ? rec.ru.toLowerCase().replace(/ё/g, 'е') : '';
  const has = (m) => cur && m.text.toLowerCase().replace(/ё/g, 'е').split(/[,;]/).some((p) => p.trim().replace(/\([^)]*\)/g, '').trim().split(/\s+/).includes(cur) || p.trim() === cur);
  if (!showAllMeanings) {
    const k = ms.findIndex(has);
    if (k > 0) ms.unshift(...ms.splice(k, 1));
  }
  if (ms.length) {
    const chips = document.createElement('div');
    chips.className = 'chips';
    const limit = showAllMeanings ? ms.length : 3;
    let lastPos = null;
    ms.slice(0, limit).forEach((m) => {
      if (showAllMeanings && m.pos !== lastPos && m.pos) {
        const p = document.createElement('span');
        p.className = 'chip-pos';
        p.textContent = m.pos;
        chips.appendChild(p);
      }
      lastPos = m.pos;
      const c = document.createElement('button');
      c.type = 'button';
      c.className = 'chip' + (rec && (rec.ru === m.short || has(m)) ? ' on' : '');
      c.textContent = showAllMeanings ? m.text : m.short;
      c.title = m.text;
      c.addEventListener('click', () => setMy(lemma, m.short));
      chips.appendChild(c);
    });
    if (ms.length > limit) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'chip more';
      more.textContent = `ещё ${ms.length - limit}`;
      more.addEventListener('click', () => { showAllMeanings = true; renderCards(); });
      chips.appendChild(more);
    } else if (showAllMeanings && ms.length > 3) {
      const less = document.createElement('button');
      less.type = 'button';
      less.className = 'chip more';
      less.textContent = 'свернуть';
      less.addEventListener('click', () => { showAllMeanings = false; renderCards(); });
      chips.appendChild(less);
    }
    body.appendChild(chips);
  } else {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Этого слова нет в словаре — имя, редкое слово или сокращение. Смотри перевод предложения ниже.';
    body.appendChild(p);
  }

  // перевод в контексте
  if (w) body.appendChild(buildContext(lemma, w));

  // кнопки
  const act = document.createElement('div');
  act.className = 'card-actions';
  if (rec) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'danger';
    del.textContent = 'Удалить из словаря';
    del.addEventListener('click', () => removeWord(lemma));
    act.appendChild(del);
  } else {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'main';
    add.textContent = 'Добавить в словарь';
    add.addEventListener('click', () => addCustom(lemma));
    act.appendChild(add);
  }
  body.appendChild(act);
  return body;
}

function setMy(lemma, text) {
  const r = live(lemma);
  if (!r) return;
  state.words[lemma] = { ...r, ru: text, auto: false, u: Date.now() };
  changed();
  renderCards();
}

function buildContext(lemma, w) {
  const box = document.createElement('div');
  box.className = 'ctx';
  box.innerHTML = '<span class="cap">В контексте · переводчик Chrome</span>';
  const ru = document.createElement('div');
  ru.className = 'ctx-ru';
  const en = document.createElement('div');
  en.className = 'ctx-en';
  const hint = document.createElement('div');
  hint.className = 'ctx-hint';
  box.append(ru, en, hint);

  const s = sentenceAt(current.entry.text, w.at, (w.join || w.word).length);
  // оригинал с подсветкой слова
  const mark = document.createElement('mark');
  mark.textContent = s.text.slice(s.wordStart, s.wordStart + (w.join || w.word).length);
  en.append(s.text.slice(0, s.wordStart), mark, s.text.slice(s.wordStart + mark.textContent.length));

  if (!s.text) { ru.textContent = '—'; return box; }
  if (!tr.supported()) {
    ru.textContent = 'Перевод предложения работает в Chrome 138+ или Edge на компе.';
    return box;
  }
  const key = `${current.num}:${w.i}`;
  const fill = (res, match) => {
    // авто-перевод: подбираем значение по контексту, пока сам не поправил
    const r = live(lemma);
    if (match && r && r.auto !== false && r.ru !== match.label) {
      state.words[lemma] = { ...r, ru: match.label, auto: true, u: Date.now() };
      changed();
      const inp = document.getElementById('myInput');
      if (!(inp && document.activeElement === inp)) { renderCards(); return; }
    }
    ru.textContent = '';
    const toks = tokenizeRu(res);
    let pos = 0;
    toks.forEach((t, ti) => {
      if (t.start > pos) ru.append(res.slice(pos, t.start));
      const span = document.createElement(match && match.token === ti ? 'mark' : 'span');
      span.className = 'tk';
      span.textContent = t.word;
      span.title = 'Взять как мой перевод';
      span.addEventListener('click', () => {
        if (!live(lemma)) return;
        setMy(lemma, t.word.toLowerCase());
        toast(`«${lemma}» → ${t.word.toLowerCase()}`);
      });
      ru.appendChild(span);
      pos = t.end;
    });
    if (pos < res.length) ru.append(res.slice(pos));
    hint.textContent = match
      ? 'Подсвечено слово, которое совпало со словарём. Кликни другое, если перевод не тот.'
      : 'Не нашёл точного совпадения со словарём — кликни слово в переводе, чтобы взять его.';
  };
  const cached = ctxCache.get(key);
  if (cached) { fill(cached.res, cached.match); return box; }
  ru.textContent = 'Перевожу…';
  tr.translateSentence(s.text, (p) => { ru.textContent = `Скачиваю модель перевода (один раз)… ${Math.round(p * 100)}%`; })
    .then(async (res) => {
      // 1) переводчик Chrome переводит само слово — если этот перевод есть в предложении, это самый точный вариант
      let match = null;
      const forms = [...new Set([(w.join || w.word).toLowerCase(), lemma])];
      for (const f of forms) {
        if (match) break;
        try {
          const single = (await tr.translateSentence(f)).trim().toLowerCase().replace(/[.!?,;:]+$/, '');
          if (single && !/\s/.test(single) && /[а-яё]/i.test(single)) match = findMatch(res, s.rel, [{ text: single, short: single }]);
        } catch (e) { /* нет — не страшно */ }
      }
      // 2) иначе ищем в предложении любое значение из словаря
      if (!match) match = findMatch(res, s.rel, dictMeanings(lemma));
      ctxCache.set(key, { res, match });
      if (ctxCache.size > 200) ctxCache.delete(ctxCache.keys().next().value);
      if (box.isConnected) fill(res, match);
      else if (openLemma === lemma) renderCards();
    })
    .catch((e) => {
      console.warn(e);
      ru.textContent = 'Переводчик Chrome сейчас недоступен. Проверь, что Chrome обновлён.';
    });
  return box;
}

function removeWord(lemma) {
  state.words[lemma] = { del: true, u: Date.now() };
  changed();
  if (openLemma === lemma) { openLemma = null; openIdx = -1; }
  decorate();
  renderCards();
  toast(`«${lemma}» удалено из словаря`);
}

function addCustom(lemma) {
  const now = Date.now();
  state.words[lemma] = { ru: '', auto: false, color: state.nextColor % COLORS.length, u: now, at: now };
  state.nextColor = (state.nextColor || 0) + 1;
  tempCard = null;
  changed();
  decorate();
  renderCards();
  const inp = document.getElementById('myInput');
  if (inp) inp.focus();
}

// ---------- весь словарь ----------
function renderAll() {
  const q = el.dictSearch.value.trim().toLowerCase();
  const counts = pageCounts();
  let list = liveWords().sort((a, b) => (b[1].at || b[1].u || 0) - (a[1].at || a[1].u || 0));
  if (q) list = list.filter(([k, r]) => k.includes(q) || (r.ru || '').toLowerCase().includes(q));
  el.dictList.textContent = '';
  el.dictEmpty.hidden = list.length > 0;
  el.dictEmpty.textContent = liveWords().length ? 'Ничего не нашлось.' : 'Пока пусто. Кликни незнакомое слово в книге.';
  const frag = document.createDocumentFragment();
  for (const [lemma, rec] of list.slice(0, 500)) {
    const li = document.createElement('li');
    const card = document.createElement('div');
    card.className = 'card';
    const row = document.createElement('div');
    row.className = 'card-row';
    row.style.cursor = 'default';
    row.innerHTML = `<span class="dot" style="background:${colorOf(rec).dot}"></span>
      <span class="card-main"><span class="card-word"></span><span class="card-ru"></span></span>`;
    row.querySelector('.card-word').textContent = lemma;
    row.querySelector('.card-ru').textContent = labelOf(lemma) || '—';
    if (counts.get(lemma)) {
      const n = document.createElement('span');
      n.className = 'card-n';
      n.textContent = '×' + counts.get(lemma);
      row.appendChild(n);
    }
    const sp = document.createElement('button');
    sp.type = 'button';
    sp.className = 'round';
    sp.innerHTML = ICON.speak;
    sp.setAttribute('aria-label', 'Прослушать ' + lemma);
    sp.addEventListener('click', () => speech.speak(lemma, voiceOpts()));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'round';
    del.innerHTML = ICON.trash;
    del.setAttribute('aria-label', 'Удалить ' + lemma);
    del.addEventListener('click', () => removeWord(lemma));
    row.append(sp, del);
    card.appendChild(row);
    li.appendChild(card);
    frag.appendChild(li);
  }
  el.dictList.appendChild(frag);
}

function setTab(tab) {
  prefs.tab = tab;
  savePrefs();
  document.querySelectorAll('.tab').forEach((x) => {
    const on = x.dataset.tab === tab;
    x.classList.toggle('active', on);
    x.setAttribute('aria-selected', on);
  });
  el.panelPage.hidden = tab !== 'page';
  el.panelAll.hidden = tab !== 'all';
  if (tab === 'all') renderAll();
}

function setSide(open) {
  prefs.side = open;
  savePrefs();
  el.side.hidden = !open || !book;
  requestAnimationFrame(onResize);
}

function afterStateChange() {
  renderCounts();
  if (current) { decorate(); renderCards(); }
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
  el.rateVal.textContent = Number(prefs.rate).toFixed(1);
  el.autoSpeak.checked = prefs.autoSpeak;
  el.hoverAll.checked = prefs.hoverAll;
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
  el.dictBtn.addEventListener('click', () => {
    if (!book) { toast('Сначала открой книгу'); return; }
    setSide(el.side.hidden);
  });
  el.sideClose.addEventListener('click', () => setSide(false));
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
  setTab(prefs.tab === 'all' ? 'all' : 'page');
  el.dictSearch.addEventListener('input', renderAll);

  // клики по странице: слово — открыть перевод справа, пустое место — свернуть карточку
  el.words.addEventListener('click', (e) => {
    const b = e.target.closest('.w');
    if (b) { e.stopPropagation(); onWordClick(Number(b.dataset.i)); }
  });
  el.stage.addEventListener('click', (e) => {
    if (e.target.closest('.w') || !openLemma) return;
    if (window.getSelection && String(window.getSelection())) return;
    closeCard();
  });

  // наведение
  el.words.addEventListener('mouseover', (e) => {
    const b = e.target.closest('.w');
    if (b) showTip(Number(b.dataset.i));
  });
  el.words.addEventListener('mouseout', (e) => {
    const b = e.target.closest('.w');
    if (b && !(e.relatedTarget && b.contains(e.relatedTarget))) hideTip();
  });
  el.stage.addEventListener('scroll', hideTip, { passive: true });

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || el.settings.open;
    if (e.key === 'Escape' && !el.settings.open) { closeCard(); return; }
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
  el.hoverAll.addEventListener('change', () => { prefs.hoverAll = el.hoverAll.checked; savePrefs(); });
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
      state = mergeStates(state, JSON.parse(await f.text()));
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
