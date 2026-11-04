"""Собирает англо-русский словарь Мюллера (7-е изд., GPL) в компактный JSON для сайта.

Запуск:  python3 tools/build_dict.py путь/к/mueller-base  docs/data/dict.json

Формат результата:
{
  "w": { "слово": ["ipa", [["сущ.", ["значение", ...]], ...]] , ... },
  "f": { "форма": "лемма", ... }   # ran -> run, children -> child, was -> be
}
"""
import json
import re
import sys

IPA = {
    "'": "ˈ", ",": "ˌ", ":": "ː", "I": "ɪ", "э": "ə", "O": "ɔ", "Э": "æ",
    "S": "ʃ", "A": "ʌ", "N": "ŋ", "з": "ʒ", "Ф": "θ", "E": "ɛ", "З": "ð",
}

POS = {
    "n": "сущ.", "v": "глаг.", "a": "прил.", "adv": "нареч.", "prep": "предл.",
    "pron": "мест.", "cj": "союз", "int": "межд.", "num": "числ.", "part": "част.",
}

# Неправильные формы, которых нет отдельными статьями
EXTRA_FORMS = {
    "was": "be", "were": "be", "is": "be", "are": "be", "am": "be", "been": "be", "being": "be",
    "has": "have", "had": "have", "having": "have", "does": "do", "did": "do", "done": "do",
    "i'm": "i", "an": "a",
}

LATIN = re.compile(r"[A-Za-z]")
LABEL = re.compile(r"_[^\s.,;:()]+\.?")
NUM_SENSE = re.compile(r"^\s*(\d+)\)\s*")
NUM_POS = re.compile(r"^\s*(\d+)\.\s*")
REF = re.compile(r"(?:_p\.|_p-p\.|_pl\.|_pres-p\.|_comp\.|_superl\.|_sing\.)[^\n]*?\sот\s+([A-Za-z][A-Za-z'\- ]*?)(?:\s+(?:[IVX]+|\d+))?(?:\s*[;.,{(]|\s*$)")
EQ = re.compile(r"^\s*(?:_[^\s]+\s+)*=\s*([A-Za-z][A-Za-z'\-]*)")


def to_ipa(s):
    return "".join(IPA.get(ch, ch) for ch in s)


def clean_meanings(text):
    """Из текста значения оставляем только русские варианты перевода без примеров."""
    text = re.sub(r"\{[^}]*\}", "", text)
    text = re.sub(r"\([^)]*[A-Za-z][^)]*\)", "", text)  # (smb.), (of all ...)
    out = []
    for seg in re.split(r"[;]", text):
        seg = LABEL.sub("", seg)
        seg = re.sub(r"(?:^|\s)[а-е]\)\s*", " ", seg)
        seg = re.sub(r"\((?:полная|редуцированная)[^)]*\)", "", seg)
        seg = re.sub(r"\s+", " ", seg).strip(" ,.:—-")
        if not seg or LATIN.search(seg):
            continue
        if len(seg) > 60:
            continue
        for part in seg.split(","):
            p = part.strip(" .:")
            if p and p not in out and not re.fullmatch(r"[\d\s\-]+", p):
                out.append(p)
        if len(out) >= 4:
            break
    return out[:4]


def parse_body(body):
    """Возвращает (ipa, [[pos, [значения]]...])."""
    m = re.search(r"\[([^\]]+)\]", body)
    ipa = to_ipa(m.group(1)) if m else ""
    groups = []
    current_pos = ""
    current = []
    flat = re.sub(r"\n\s+", " \n", body)
    lines = [ln for ln in body.split("\n")]
    # Склеиваем перенесённые строки внутри одного пункта
    chunks = []
    buf = ""
    for ln in lines:
        s = ln.strip()
        if not s:
            if buf:
                chunks.append(buf)
                buf = ""
            continue
        buf = (buf + " " + s).strip()
    if buf:
        chunks.append(buf)

    def flush():
        nonlocal current
        if current:
            groups.append([current_pos, current[:5]])
        current = []

    for ch in chunks:
        ch = re.sub(r"^(?:[IVX]+\s+)?\[[^\]]+\]\s*", "", ch)  # транскрипция в начале
        mp = NUM_POS.match(ch)
        if mp:
            flush()
            ch = ch[mp.end():]
        pos_m = re.match(r"_([a-z\-]+)\.", ch)
        if pos_m:
            if mp is None and current:
                flush()
            current_pos = POS.get(pos_m.group(1), current_pos)
            ch = ch[pos_m.end():]
        ms = NUM_SENSE.match(ch)
        if ms:
            ch = ch[ms.end():]
        if ch.startswith("*)"):
            continue
        means = clean_meanings(ch)
        if means:
            current.append(", ".join(means[:3]))
    flush()
    groups = [g for g in groups if g[1]][:4]
    return ipa, groups


def main(src, dst):
    text = open(src, encoding="utf-8").read()
    words = {}
    forms = dict(EXTRA_FORMS)
    for entry in text.split("_____\n"):
        entry = entry.strip("\n")
        if not entry:
            continue
        head, _, body = entry.partition("\n")
        head = head.strip().lower()
        if not head or " " in head or not re.fullmatch(r"[a-z][a-z'\-]*", head):
            continue
        refm = REF.search(body)
        eqm = EQ.match(re.sub(r"^\s*(?:[IVX]+\s+)?\[[^\]]+\]", "", body.strip()).replace("\n", " "))
        ipa, groups = parse_body(body)
        if refm:
            target = refm.group(1).strip().lower().split()[0]
            if target != head:
                forms.setdefault(head, target)
        elif eqm and not groups:
            target = eqm.group(1).lower()
            if target != head:
                forms.setdefault(head, target)
        if groups:
            words.setdefault(head, [ipa, groups])
    # американские варианты с "=" (harbor = harbour): переводим ссылкой
    out = {"w": words, "f": {k: v for k, v in forms.items() if k not in words or k in EXTRA_FORMS}}
    with open(dst, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"слов: {len(words)}, форм: {len(out['f'])}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
