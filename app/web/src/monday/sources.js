// Which collection a backlog row came from, and whether it is an official paper or a mock.
//
// Kept out of App.jsx so it can be exercised directly: the classification decides what the
// Source filter shows, and a rule that silently stops matching would quietly empty a menu.

/**
 * Which collection a backlog row came from, and whether that collection is an official
 * paper or a mock.
 *
 * The distinction matters for revision: a wrong answer on a real TMUA paper is worth more
 * than one on a mock written to be harder than the real thing, and "show me only the
 * official ones" was impossible to ask for. Read from the canonical id where there is one,
 * because that is the field that survived every rename; the reference text is the fallback.
 */
export const SOURCES = [
  { key: 'tmua', label: 'TMUA official', official: true, cid: /^TMUA-(\d{4}|PRAC|SPEC)-/, ref: /^\s*(\d{4}|practice|specimen)/i },
  { key: 'mat', label: 'MAT official', official: true, cid: /^MAT-/, ref: /\bmat\b/i },
  { key: 'euclid', label: 'Euclid', official: false, cid: /^EUC-/, ref: /euclid|\br2\s*d(?:rew|2)\b/i },
  { key: 'jz', label: 'JZ Maths', official: false, cid: /^JZ-/, ref: /\bjz\b|jzmaths/i },
  { key: 'heracles', label: 'Heracles', official: false, cid: /^HER-/, ref: /heracl|hercul/i },
  { key: 'tyler', label: 'Tyler Tutoring', official: false, cid: /^TYLER-/, ref: /tyler/i },
  { key: 'chen', label: 'James Chen', official: false, cid: /^JC-/, ref: /chen|\bjam\b/i },
  { key: 'rosie', label: 'Rosie', official: false, cid: /^ROSIE-/, ref: /rosie/i },
  { key: 'af', label: 'Asher Falcon', official: false, cid: /^AF-/, ref: /asher|falcon/i },
  { key: 'djs', label: 'Daniel J Smith', official: false, cid: /^DJS-/, ref: /\bdjs\b|daniel\s*j\.?\s*smith/i },
  { key: 'step', label: 'STEP', official: true, cid: /^STEP-/, ref: /\bstep\b/i },
];

export function sourceOf(item) {
  const cid = String(item.cid ?? '');
  const ref = String(item.ref ?? '');
  for (const s of SOURCES) {
    if (cid && s.cid.test(cid)) return s;
    if (!cid && s.ref.test(ref)) return s;
  }
  for (const s of SOURCES) if (s.ref.test(ref)) return s;
  return { key: 'other', label: 'Other', official: false };
}

