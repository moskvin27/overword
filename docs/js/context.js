// Ищем в переводе предложения то слово, которое соответствует кликнутому английскому.
// Сравниваем русские слова перевода с вариантами из словаря (по основе слова)
// и учитываем, где слово стоит в предложении.

const RU_WORD = /[А-Яа-яЁё]+(?:-[А-Яа-яЁё]+)*/g;
const norm = (s) => s.toLowerCase().replace(/ё/g, 'е');

export function tokenizeRu(text) {
  const out = [];
  RU_WORD.lastIndex = 0;
  let m;
  while ((m = RU_WORD.exec(text))) out.push({ start: m.index, end: m.index + m[0].length, word: m[0], n: norm(m[0]) });
  return out;
}

function stemOf(w) {
  const len = w.length;
  const cut = len <= 4 ? 1 : len <= 6 ? 2 : 3;
  return w.slice(0, Math.max(3, len - cut));
}

function same(token, cand) {
  if (cand.length <= 3 || token.length <= 3) return token === cand;
  const st = stemOf(cand);
  return token.startsWith(st) && token.length <= cand.length + 4;
}

// meanings: [{ text, short }], relPos: где английское слово в предложении (0..1)
export function findMatch(ruText, relPos, meanings) {
  const tokens = tokenizeRu(ruText);
  if (!tokens.length || !meanings.length) return null;
  const total = ruText.length || 1;
  let best = null;
  meanings.forEach((m, mi) => {
    const pieces = m.text.replace(/\([^)]*\)/g, ' ').split(/[,;]/).map((p) => p.trim()).filter(Boolean);
    for (const piece of pieces) {
      const words = piece.split(/\s+/).map(norm).filter(Boolean);
      const shortPiece = words.length === 1 && words[0].length <= 3;
      for (const cw of words) {
        if (cw.length <= 3 && !shortPiece) continue; // предлоги внутри длинных значений не считаем
        tokens.forEach((t, ti) => {
          if (!same(t.n, cw)) return;
          const rel = (t.start + t.end) / 2 / total;
          const dist = Math.abs(rel - relPos);
          if (cw.length <= 3 && dist > 0.3) return; // короткие слова — только рядом по смыслу позиции
          const score = 10 - Math.min(mi, 10) * 0.35 + Math.min(cw.length, 8) * 0.2 - dist * 6;
          if (!best || score > best.score) {
            // надпись: весь кусок значения, если все его слова есть в переводе, иначе само слово
            const allIn = words.every((w) => w.length <= 3 || tokens.some((x) => same(x.n, w)));
            const label = allIn && words.length <= 3 ? piece : cw;
            best = { score, token: ti, start: t.start, end: t.end, meaning: mi, label };
          }
        });
      }
    }
  });
  return best;
}
