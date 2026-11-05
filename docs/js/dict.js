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

// Служебные слова: у Мюллера там длинные пояснения ("указывает на направление..."),
// поэтому даём короткие переводы руками.
const FUNC = {
  on: ['на', 'в', 'по, после', 'о, об'], in: ['в', 'на', 'через (о времени)'], at: ['в, на, у', 'за (занятие)'],
  to: ['к, в, на', 'до', 'чтобы'], of: ['кого? чего? (род. падеж)', 'из', 'о, об'], for: ['для', 'за', 'в течение', 'на (срок)'],
  by: ['у, около', 'кем, чем', 'к (сроку)', 'по'], with: ['с', 'при помощи', 'у'], from: ['из', 'от', 'с'],
  into: ['в', 'на'], onto: ['на'], about: ['о, об, про', 'около, примерно', 'вокруг'], over: ['над', 'через', 'больше, свыше'],
  under: ['под', 'меньше, ниже'], through: ['через, сквозь'], after: ['после', 'за, следом'], before: ['до, перед', 'раньше'],
  between: ['между'], during: ['во время'], within: ['в пределах, внутри'], without: ['без'], against: ['против', 'о'],
  among: ['среди'], since: ['с (тех пор)', 'так как'], until: ['до'], till: ['до'], than: ['чем'], as: ['как', 'так как', 'в качестве'],
  if: ['если', 'ли'], that: ['что', 'тот', 'который'], which: ['который', 'какой'], what: ['что', 'какой'], who: ['кто', 'который'],
  the: ['артикль (этот, тот)'], a: ['артикль (один, какой-то)'], an: ['артикль (один, какой-то)'], and: ['и', 'а'], or: ['или'],
  but: ['но', 'а', 'кроме'], so: ['так', 'поэтому'], it: ['он, она, оно', 'это'], this: ['этот', 'это'], these: ['эти'],
  those: ['те'], there: ['там', 'туда'], here: ['здесь', 'сюда'], very: ['очень'], not: ['не'], no: ['нет', 'никакой'],
  be: ['быть', 'являться', 'находиться'], have: ['иметь', 'вспом. глагол'], do: ['делать', 'вспом. глагол'],
  will: ['будет (будущее время)', 'воля'], would: ['бы'], can: ['мочь', 'уметь'], may: ['можно', 'может быть'], must: ['должен'],
  should: ['следует, должен'], could: ['мог бы', 'мог'], more: ['больше', 'более'], most: ['самый', 'большинство'],
  any: ['любой', 'какой-нибудь'], some: ['некоторые', 'какой-то', 'немного'], each: ['каждый'], every: ['каждый'],
  all: ['все', 'весь'], only: ['только', 'единственный'], also: ['также'], just: ['просто', 'только что', 'как раз'],
  even: ['даже'], when: ['когда'], where: ['где', 'куда'], how: ['как'], why: ['почему'], then: ['тогда', 'затем'],
  now: ['сейчас'], such: ['такой'], other: ['другой'], its: ['его, её (о предмете)'], his: ['его'], her: ['её'],
  their: ['их'], your: ['твой, ваш'], my: ['мой'], our: ['наш'], he: ['он'], she: ['она'], they: ['они'], we: ['мы'],
  you: ['ты, вы'], i: ['я'], me: ['меня, мне'], him: ['его, ему'], them: ['их, им'], us: ['нас, нам'], up: ['вверх', 'наверх'],
  down: ['вниз'], out: ['наружу, вне'], off: ['с, от', 'прочь'], both: ['оба'], either: ['любой из двух', 'тоже (с отрицанием)'],
  whether: ['ли'], while: ['пока', 'в то время как'], because: ['потому что'], although: ['хотя'], though: ['хотя'],
  however: ['однако'], therefore: ['поэтому'], yet: ['ещё', 'однако'], still: ['всё ещё', 'тем не менее'],
};

const EXPLAIN = /^(указывает|употр|в пространств|во временн|в сочет|служит|передаётся|как вспомогат|в функции)/i;

export function entry(lemma) {
  const f = FUNC[lemma];
  if (!W || !has(lemma)) return f ? { ipa: '', groups: [['', f]] } : null;
  const [ipa, groups] = W[lemma];
  if (!f) return { ipa, groups };
  const rest = groups.map(([pos, ms]) => [pos, ms.filter((m) => !EXPLAIN.test(m))]).filter(([, ms]) => ms.length);
  return { ipa, groups: [['', f], ...rest] };
}

// Все варианты перевода одним списком: [{ text, short, pos }]
export function meanings(lemma) {
  const e = entry(lemma);
  if (!e) return [];
  const out = [];
  for (const [pos, ms] of e.groups) {
    for (const m of ms) out.push({ text: m, short: shortOf(m), pos });
  }
  return out;
}

export function shortOf(m) {
  return m.split(/[,;]/)[0].replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim() || m;
}

// Короткий перевод (первое значение).
export function shortRu(lemma) {
  const f = FUNC[lemma];
  if (f) return f[0];
  const ms = meanings(lemma);
  return ms.length ? ms[0].short : '';
}
