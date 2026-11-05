// Рендер страниц PDF + слой кликабельных слов. В памяти держим только текущую и соседние страницы.

const WORD_RE = /[A-Za-z]+(?:['’][A-Za-z]+)*/g;
const KEEP = 1; // сколько соседних страниц держим готовыми с каждой стороны

const measureCtx = document.createElement('canvas').getContext('2d');

export class PdfView {
  constructor(doc) {
    this.doc = doc;
    this.cache = new Map(); // номер -> { canvas, words, text, cssW, cssH, key }
    this.pending = new Map(); // номер -> Promise
    this.cssWidth = 800;
    this.key = '';
  }

  get pages() { return this.doc.numPages; }

  setWidth(cssWidth) {
    const w = Math.round(cssWidth);
    if (w === this.cssWidth) return false;
    this.cssWidth = w;
    this.dropAll();
    return true;
  }

  dropAll() {
    for (const [, v] of this.cache) this.release(v);
    this.cache.clear();
    this.pending.clear();
  }

  release(entry) {
    if (entry && entry.canvas) { entry.canvas.width = 0; entry.canvas.height = 0; }
  }

  // Готовая страница (рисуем, если ещё нет)
  async get(num) {
    const key = `${num}@${this.cssWidth}`;
    const have = this.cache.get(num);
    if (have && have.key === key) return have;
    if (this.pending.has(key)) return this.pending.get(key);
    const p = this.build(num, key).then((entry) => {
      this.pending.delete(key);
      if (`${num}@${this.cssWidth}` !== key) { this.release(entry); return this.get(num); }
      const old = this.cache.get(num);
      if (old && old !== entry) this.release(old);
      this.cache.set(num, entry);
      return entry;
    }).catch((e) => { this.pending.delete(key); throw e; });
    this.pending.set(key, p);
    return p;
  }

  async build(num, key) {
    const page = await this.doc.getPage(num);
    const base = page.getViewport({ scale: 1 });
    const scale = this.cssWidth / base.width;
    const viewport = page.getViewport({ scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
    const content = await page.getTextContent();
    const { words, text } = extractWords(content, viewport);
    page.cleanup();
    return { key, canvas, words, text, cssW: Math.floor(viewport.width), cssH: Math.floor(viewport.height) };
  }

  // Подготовить соседей в фоне и выкинуть дальние страницы
  prefetchAround(num) {
    for (const [n, v] of this.cache) {
      if (Math.abs(n - num) > KEEP) { this.release(v); this.cache.delete(n); }
    }
    const run = () => {
      for (let d = 1; d <= KEEP; d++) {
        for (const n of [num + d, num - d]) {
          if (n >= 1 && n <= this.pages) this.get(n).catch(() => {});
        }
      }
    };
    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 600 });
    else setTimeout(run, 120);
  }
}

function extractWords(content, viewport) {
  const words = [];
  let text = '';
  const styles = content.styles || {};
  let prev = null; // { top, bottom, h } предыдущего текстового куска
  for (const item of content.items) {
    if (typeof item.str !== 'string') continue;
    const str = item.str;
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const angle = Math.atan2(tx[1], tx[0]);
    const style = styles[item.fontName] || {};
    const fontH = Math.hypot(tx[2], tx[3]);
    const ascent = style.ascent ? style.ascent : style.descent ? 1 + style.descent : 0.8;
    const top = tx[5] - fontH * ascent;
    const visible = str.trim() && Math.abs(angle) <= 0.02 && fontH >= 3;
    if (visible && prev) {
      // большой отступ или смена размера шрифта = новый абзац/заголовок, предложение там заканчивается
      const gap = top - prev.bottom;
      const ratio = fontH / prev.h;
      if (gap > Math.max(fontH, prev.h) * 0.7 || ratio > 1.25 || ratio < 0.8) text += '\u0001';
    }
    const start = text.length;
    text += str;
    if (item.hasEOL) text += '\n';
    if (!visible) continue;
    prev = { top, bottom: top + fontH, h: fontH };
    const left = tx[4];
    const widthPx = item.width * viewport.scale;
    measureCtx.font = `${fontH}px ${style.fontFamily || 'sans-serif'}`;
    const natural = measureCtx.measureText(str).width || 1;
    const k = widthPx / natural;
    WORD_RE.lastIndex = 0;
    let m;
    while ((m = WORD_RE.exec(str))) {
      const before = measureCtx.measureText(str.slice(0, m.index)).width * k;
      const w = measureCtx.measureText(m[0]).width * k;
      words.push({
        i: words.length,
        word: m[0],
        x: left + before,
        y: top,
        w: Math.max(w, 4),
        h: fontH * 1.08,
        at: start + m.index,
      });
    }
  }
  // Склеиваем перенос: "some-" в конце строки + "thing" в начале следующей
  for (let j = 0; j < words.length - 1; j++) {
    const a = words[j];
    const b = words[j + 1];
    const end = a.at + a.word.length;
    if (/[-‐‑]/.test(text[end] || '') && b && b.y > a.y + 2 && /^[a-z]/.test(b.word)) {
      a.join = a.word + b.word;
      b.join = a.word + b.word;
      b.joinPart = true;
    }
  }
  return { words, text };
}

// Предложение вокруг слова (для перевода в контексте).
// Возвращает { text, wordStart, rel } — где в предложении стоит слово.
export function sentenceAt(text, at, wordLen = 1) {
  const flat = text.replace(/-\n(?=[a-z])/g, '\u0000\u0000').replace(/\n/g, ' ');
  const isEnd = (i) => flat[i] === '\u0001' || (/[.!?…]/.test(flat[i]) && (i + 1 >= flat.length || /[\s"'”’)\u0001]/.test(flat[i + 1])));
  let s = at;
  while (s > 0 && !isEnd(s - 1) && at - s < 700) s--;
  let e = at;
  while (e < flat.length && !isEnd(e) && e - at < 700) e++;
  const raw = flat.slice(s, Math.min(flat.length, e + 1));
  // чистим строку и пересчитываем позицию слова
  let out = '';
  let wordStart = -1;
  let space = false;
  for (let i = 0; i < raw.length; i++) {
    if (i === at - s) { if (space && out) out += ' '; space = false; wordStart = out.length; }
    const ch = raw[i];
    if (ch === '\u0000') continue;
    if (/\s|\u0001/.test(ch)) { space = true; continue; }
    if (space && out) out += ' ';
    space = false;
    out += ch;
  }
  if (wordStart < 0) wordStart = 0;
  return { text: out, wordStart, wordLen, rel: out.length ? (wordStart + wordLen / 2) / out.length : 0.5 };
}
