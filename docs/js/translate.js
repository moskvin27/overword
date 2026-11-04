// Перевод предложения целиком встроенным переводчиком Chrome (Translator API, работает на компе без интернета).

let translator = null;
let creating = null;
const cache = new Map();

export function supported() {
  return 'Translator' in self;
}

export async function status() {
  if (!supported()) return 'unsupported';
  try {
    return await self.Translator.availability({ sourceLanguage: 'en', targetLanguage: 'ru' });
  } catch (e) {
    return 'unavailable';
  }
}

async function getTranslator(onProgress) {
  if (translator) return translator;
  if (!creating) {
    creating = self.Translator.create({
      sourceLanguage: 'en',
      targetLanguage: 'ru',
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => onProgress && onProgress(e.loaded));
      },
    }).then((t) => { translator = t; return t; })
      .catch((e) => { creating = null; throw e; });
  }
  return creating;
}

export async function translateSentence(text, onProgress) {
  const key = text.trim();
  if (!key) return '';
  if (cache.has(key)) return cache.get(key);
  if (!supported()) throw new Error('unsupported');
  const t = await getTranslator(onProgress);
  const out = await t.translate(key);
  cache.set(key, out);
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return out;
}
