// Офлайн-словарь Мюллера + приведение слова к начальной форме (ran → run, ships → ship).

let W = null; // слово -> [ipa, [[часть речи, [значения]]]]
let F = null; // форма -> лемма

export async function loadDict(onProgress) {
  const res = await fetch('data/dict.json');
  if (!res.ok) throw new Error('словарь не загрузился: ' + res.status);
  const total = Number(res.headers.get('content-length')) || 0;
  let data;
  if (res.body && total && onProgress) {
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress(Math.min(1, got / total));
    }
    const blob = new Blob(chunks);
    data = JSON.parse(await blob.text());
  } else {
    data = await res.json();
  }
  W = data.w;
  F = data.f;
  return Object.keys(W).length;
}

export const ready = () => !!W;

function norm(w) {
  return w.toLowerCase().replace(/[’‘]/g, "'");
}

function has(w) {
  return Object.prototype.hasOwnProperty.call(W, w);
}

function follow(w) {
  let cur = w;
  for (let i = 0; i < 3; i++) {
    if (has(cur)) return cur;
    const next = F[cur];
    if (!next) return null;
    cur = next;
  }
  return has(cur) ? cur : null;
}

function candidates(w) {
  const out = [];
  const add = (x) => { if (x && x.length > 1 && !out.includes(x)) out.push(x); };
  if (w.endsWith("'s")) add(w.slice(0, -2));
  if (w.endsWith("s'")) add(w.slice(0, -1));
  const dbl = (s) => (/(.)\1$/.test(s) ? s.slice(0, -1) : null);
  if (w.endsWith('ies')) add(w.slice(0, -3) + 'y');
  if (w.endsWith('ves')) { add(w.slice(0, -3) + 'f'); add(w.slice(0, -3) + 'fe'); }
  if (w.endsWith('s') && !w.endsWith('ss')) add(w.slice(0, -1));
  if (w.endsWith('es')) add(w.slice(0, -2));
  if (w.endsWith('ied')) add(w.slice(0, -3) + 'y');
  if (w.endsWith('ed')) { const b = w.slice(0, -2); add(b + 'e'); add(b); add(dbl(b)); }
  if (w.endsWith('ing')) { const b = w.slice(0, -3); add(b + 'e'); add(b); add(dbl(b)); if (b.endsWith('y')) add(b.slice(0, -1) + 'ie'); }
  if (w.endsWith('ier')) add(w.slice(0, -3) + 'y');
  if (w.endsWith('iest')) add(w.slice(0, -4) + 'y');
  if (w.endsWith('er')) { const b = w.slice(0, -2); add(b + 'e'); add(b); add(dbl(b)); }
  if (w.endsWith('est')) { const b = w.slice(0, -3); add(b + 'e'); add(b); add(dbl(b)); }
  if (w.endsWith('ily')) add(w.slice(0, -3) + 'y');
  if (w.endsWith('ly')) add(w.slice(0, -2));
  return out;
}

// Ключ слова в словаре пользователя: начальная форма, если её удалось найти.
export function lemmaOf(word) {
  const w = norm(word);
  if (!W) return w;
  if (has(w)) return w;
  const viaForm = follow(w);
  if (viaForm) return viaForm;
  for (const c of candidates(w)) {
    const r = follow(c);
    if (r) return r;
  }
  return w;
}

export function entry(lemma) {
  if (!W || !has(lemma)) return null;
  const [ipa, groups] = W[lemma];
  return { ipa, groups };
}

// Короткий перевод для надписи над словом.
export function shortRu(lemma) {
  const e = entry(lemma);
  if (!e) return '';
  const first = e.groups[0] && e.groups[0][1][0];
  if (!first) return '';
  return first.split(/[,;]/)[0].replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
}
