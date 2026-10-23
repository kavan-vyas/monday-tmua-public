import json
import sys
from pathlib import Path

MISAKI_CHARSET = set('AIQWYabdfhijklmnpstuvwzðŋɑɒɔəɛɜɡɪɹʃʊʌʒʤʧˈˌːθᵊ')
VOWELS = set('AIQWYaɑɒɔəɛɜɪʊʌiuᵊ')

_DIGRAPHS = [
    ('dʒ', 'ʤ'), ('tʃ', 'ʧ'),
    ('eɪ', 'A'), ('aɪ', 'I'), ('əʊ', 'Q'), ('oʊ', 'Q'),
    ('aʊ', 'W'), ('ɔɪ', 'Y'), ('ɛə', 'ɛː'), ('eə', 'ɛː'),
]

_SINGLES = [('æ', 'a'), ('r', 'ɹ'), ('g', 'ɡ'), ('e', 'ɛ'), ('ɐ', 'ə'), ('ˑ', 'ː')]


def ipa_to_misaki(ipa):
    s = ipa
    for src, dst in _DIGRAPHS:
        s = s.replace(src, dst)
    for src, dst in _SINGLES:
        s = s.replace(src, dst)
    out = []
    i = 0
    while i < len(s):
        c = s[i]
        if c in 'ˈˌ':
            j = i + 1
            while j < len(s) and s[j] not in VOWELS and s[j] not in 'ˈˌ':
                j += 1
            if j < len(s) and s[j] in VOWELS:
                out.append(s[i + 1:j])
                out.append(c)
                out.append(s[j])
                i = j + 1
                continue
        out.append(c)
        i += 1
    ps = ''.join(out)
    if 'ˈ' not in ps:
        for i, c in enumerate(ps):
            if c in VOWELS:
                ps = ps[:i] + 'ˈ' + ps[i:]
                break
    return ps


def load_lexicon(path):
    raw = json.loads(Path(path).read_text(encoding='utf-8'))
    return {k: v for k, v in raw.items() if not k.startswith('_')}


def compile_lexicon(path):
    compiled = {}
    bad = []
    for word, ipa in load_lexicon(path).items():
        ps = ipa_to_misaki(ipa)
        stray = set(ps) - MISAKI_CHARSET
        if stray:
            bad.append((word, ps, stray))
            continue
        compiled[word] = ps
    return compiled, bad


def apply_lexicon(pipeline, path):
    lex = pipeline.g2p.lexicon
    gold = getattr(lex, 'golden', None)
    if gold is None:
        gold = lex.golds
    compiled, bad = compile_lexicon(path)
    for word, ps in bad:
        print(f'lexicon: skipped {word!r} (unmappable phonemes {ps!r})', file=sys.stderr)
    for word, ps in compiled.items():
        gold[word] = ps
        gold[word.lower()] = ps
        gold[word.capitalize()] = ps
    return len(compiled)
