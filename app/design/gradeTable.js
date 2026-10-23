// ═══════════════ MONDAY — raw mark → TMUA grade table ═══════════════
// Private conversion table. Values are VERBATIM from the source table — this
// is not derived from a formula and it is not "cleaned up". In particular:
//   - 13 and 12 BOTH map to "2.0–2.2" in the source. That is not a typo here;
//     it is a typo (or a genuine plateau) IN THE SOURCE, and it is preserved.
//   - Bands overlap at their boundaries (e.g. 27→"5.9–6.0" and 28→"6.0–6.1"
//     both touch 6.0). Also preserved.
// Do not "fix" either of these without going back to the source table.
//
// Shape: [rawMark, gradeLabel]. gradeLabel is a string because several bands
// are ranges ("8.5–8.6") rather than single values — there is no clean numeric
// type that holds both a point value and a range without losing information,
// so the label stays a string everywhere and callers parse the low end when
// they need a sortable/comparable number (see gradeLow()).
export const GRADE_TABLE = [
  [40, '9.0'],
  [39, '9.0'],
  [38, '9.0'],
  [37, '8.9'],
  [36, '8.7'],
  [35, '8.5–8.6'],
  [34, '8.1–8.3'],
  [33, '7.6–7.8'],
  [32, '7.3–7.5'],
  [31, '6.9–7.1'],
  [30, '6.6–6.7'],
  [29, '6.3–6.4'],
  [28, '6.0–6.1'],
  [27, '5.9–6.0'],
  [26, '5.8'],
  [25, '5.6–5.7'],
  [24, '5.4–5.5'],
  [23, '5.2–5.3'],
  [22, '4.9–5.1'],
  [21, '4.5–4.7'],
  [20, '3.8–4.1'],
  [19, '3.6–3.8'],
  [18, '3.3–3.5'],
  [17, '3.0–3.2'],
  [16, '2.8–3.0'],
  [15, '2.5–2.7'],
  [14, '2.2–2.4'],
  [13, '2.0–2.2'],
  [12, '2.0–2.2'],
  [11, '1.8'],
  [10, '1.7'],
  [9, '1.5'],
  [8, '1.4'],
  [7, '1.3'],
  [6, '1.2'],
  [5, '1.0'],
  [4, '1.0'],
  [3, '1.0'],
  [2, '1.0'],
  [1, '1.0'],
  [0, '1.0'],
];

/** mark (0-40) → grade label, or null if out of range. */
export function gradeForMark(mark) {
  const row = GRADE_TABLE.find(([m]) => m === mark);
  return row ? row[1] : null;
}

/** A grade label ("8.5–8.6" or "9.0") → its lowest numeric value, for sorting
 *  and comparisons. A range takes its low end because that is the grade you
 *  are GUARANTEED at that mark — the honest number to reason with. */
export function gradeLow(label) {
  if (typeof label !== 'string') return NaN;
  const first = label.split('–')[0].trim();
  return Number(first);
}

/** The minimum raw mark whose grade reaches at least `targetGrade` (numeric).
 *  GRADE_TABLE is stored high-mark-first, so the first row (scanning from the
 *  bottom) whose low-end grade clears the target is the minimum mark needed.
 *  Returns null if no mark in the table reaches it. */
export function minMarkForGrade(targetGrade) {
  const target = Number(targetGrade);
  if (!Number.isFinite(target)) return null;
  // scan from lowest mark to highest, first row that clears the target wins
  for (let i = GRADE_TABLE.length - 1; i >= 0; i--) {
    const [mark, label] = GRADE_TABLE[i];
    if (gradeLow(label) >= target) return mark;
  }
  return null;
}

/** Marks needed above `mark` to reach the next-higher grade band. Returns 0
 *  at the very top of the table (40) since there is no higher band. Returns
 *  null for an out-of-range mark. */
export function marksToNextBand(mark) {
  const idx = GRADE_TABLE.findIndex(([m]) => m === mark);
  if (idx === -1) return null;
  const currentLow = gradeLow(GRADE_TABLE[idx][1]);
  // walk upward (toward index 0, higher marks) until the grade actually increases
  for (let i = idx - 1; i >= 0; i--) {
    if (gradeLow(GRADE_TABLE[i][1]) > currentLow) {
      return GRADE_TABLE[i][0] - mark;
    }
  }
  return 0;
}

export const MAX_MARK = 40;
export const MIN_MARK = 0;
export const TOP_BAND_FLOOR = 38; // 38-40 all read 9.0
