// Озвучка через голоса браузера: Google-голоса Chrome при наличии сети, иначе системные (Windows/Mac).

let voices = [];
const listeners = [];

function refresh() {
  if (!('speechSynthesis' in window)) return;
  voices = speechSynthesis.getVoices().filter((v) => /^en(-|_|$)/i.test(v.lang));
  listeners.forEach((fn) => fn(voices));
}

if ('speechSynthesis' in window) {
  refresh();
  speechSynthesis.addEventListener('voiceschanged', refresh);
}

export function onVoices(fn) {
  listeners.push(fn);
  if (voices.length) fn(voices);
}

export const supported = () => 'speechSynthesis' in window;

function score(v) {
  let s = 0;
  if (/en-US/i.test(v.lang)) s += 3;
  if (/en-GB/i.test(v.lang)) s += 2;
  if (/google/i.test(v.name) && navigator.onLine) s += 6;
  if (/google/i.test(v.name) && !navigator.onLine) s -= 10;
  if (v.localService) s += 1;
  if (/(premium|enhanced|natural|neural)/i.test(v.name)) s += 4;
  if (/^(samantha|daniel|karen|moira|ava|evan|zoe|allison|tom)/i.test(v.name)) s += 3;
  if (/(aria|jenny|guy|zira|david|mark)/i.test(v.name)) s += 2;
  if (/(novelty|bells|bubbles|whisper|zarvox|trinoids|bad news|good news|albert|jester|organ|cellos|hysterical|boing|wobble|bahh|deranged|pipe|superstar)/i.test(v.name)) s -= 20;
  return s;
}

export function pickVoice(preferredName) {
  if (!voices.length) refresh();
  if (preferredName) {
    const v = voices.find((x) => x.name === preferredName);
    if (v && !(/google/i.test(v.name) && !navigator.onLine)) return v;
  }
  return voices.slice().sort((a, b) => score(b) - score(a))[0] || null;
}

export function speak(text, { voiceName = '', rate = 0.9 } = {}) {
  if (!supported() || !text) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice(voiceName);
    if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = 'en-US'; }
    u.rate = rate;
    speechSynthesis.speak(u);
  } catch (e) {
    console.warn('speech', e);
  }
}

export function listVoices() {
  return voices.slice().sort((a, b) => score(b) - score(a));
}
