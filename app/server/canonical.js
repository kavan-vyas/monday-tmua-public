// The ONE canonical id for a question, shared by every store so they stop drifting.
//
// The app's backlog (backlog.json) and the dashboard's per-question engine
// (session_memory.questions_attempted + review_queue) grew separate id schemes, so the
// same question could sit in both with a different topic and no way to line them up —
// which is why the board and the app could disagree. Everything now derives its join
// key from here.
//
// Pure. No IO.

const pad = (n) => String(n).padStart(2, '0');

/** Canonical id from an exam + a human ref ("2018 P1 Q16", "2007 Q1J", "Chen Q11"). */
export function canonicalId(exam, ref) {
  const r = String(ref ?? '').toLowerCase();
  const ex = String(exam ?? '').toUpperCase();
  // James Chen's custom papers: two in 2025, two more in 2026. Until the 2026 pair arrived
  // there was only one Chen paper, so its questions were "CHEN-11" with no year or paper —
  // and it was referred to in half the stores as "the JAM test", a name that belongs to
  // nothing. Both spellings still resolve, and both land on the 2025 Paper 1 they meant:
  // an unqualified Chen reference cannot mean a paper that did not exist when it was made.
  if (/chen|\bjam\b|\bjc\b/.test(r) || ex === 'CHEN' || ex === 'JC') {
    const yr = (r.match(/\b(?:20)?(25|26)\b/) || [])[1] ?? '25';
    const p = (r.match(/p(?:aper)?\s*([12])/) || [])[1] ?? '1';
    const q = (r.match(/q\s*(\d+)/) || [])[1];
    return `JC-${yr}-P${p}-Q${q ? pad(q) : '??'}`;
  }
  // Heracles, whose files arrived spelled Hercules. Both spellings resolve to one id, for
  // the same reason the JZ and Rosie branches exist: without it these fall through to the
  // official-TMUA branch and every one of the 120 questions mints TMUA-????-P?-Q??.
  if (/heracl|hercul/.test(r) || ex === 'HERACLES' || ex === 'HERCULES') {
    const set = (r.match(/\bs(?:et)?\s*([1-3])\b/) || [])[1] ?? '?';
    const p = (r.match(/p(?:aper)?\s*([12])/) || [])[1] ?? '1';
    const q = (r.match(/q\s*(\d+)/) || [])[1];
    return `HER-${set}-P${p}-Q${q ? pad(q) : '??'}`;
  }
  // Euclid's four sets, plus a one-off "R2Drew edition" Paper 1 that has no mark scheme.
  // The R2Drew edition is a separate paper, not set 5: its questions must not collide with
  // a numbered set, so it gets its own set token rather than a number.
  if (/euclid|\br2\s*d(?:rew|2)\b/.test(r) || ex === 'EUCLID') {
    const set = /r2\s*d/.test(r) ? 'R2D' : /sample/.test(r) ? 'SAMPLE' : ((r.match(/\bs(?:et)?\s*([1-4])\b/) || [])[1] ?? '?');
    const p = (r.match(/p(?:aper)?\s*([12])/) || [])[1] ?? '1';
    const q = (r.match(/q\s*(\d+)/) || [])[1];
    return `EUC-${set}-P${p}-Q${q ? pad(q) : '??'}`;
  }
  // Daniel J Smith: current sets A-C, his original Set A ("A0"), and Custom α. Checked
  // before Tyler and JZ so "djs sa p2" never reaches a branch that reads a bare set letter.
  if (/\bdjs\b|daniel\s*j\.?\s*smith|danieljsmith/.test(r) || ex === 'DJS') {
    const set = /alpha|α/.test(r) ? 'ALPHA'
      : ((r.match(/\bs(?:et)?\s*(a0|[a-c])\b/) || [])[1]?.toUpperCase()
        ?? (/original/.test(r) ? 'A0' : '?'));
    const p = (r.match(/p(?:aper)?\s*([12])/) || [])[1] ?? (set === 'ALPHA' ? '2' : '1');
    const q = (r.match(/q\s*(\d+)/) || [])[1];
    return `DJS-${set}-P${p}-Q${q ? pad(q) : '??'}`;
  }
  if (/tyler/.test(r)) {
    // Sets A-D: all four are on disk and C and D are both attempted. When this read [ab]
    // only, every SC and SD reference silently collapsed onto set A and shared its ids.
    // The set letter must be anchored to an s/set marker or to the word "tyler" itself:
    // a bare [a-d] match also fires on the "a" in "tmua", which is how the dashboard's
    // "TMUA-mock nullTyler SC P1 Q18" rows were every one of them filed under set A.
    const set = (r.match(/\bs(?:et)?\s*([a-d])\b/) || r.match(/\btyler\s*(?:mock\s*)?s?\s*([a-d])\b/) || [])[1]?.toUpperCase() ?? '?';
    const p = (r.match(/p\s*([12])/) || [])[1] ?? '1';
    const q = (r.match(/q\s*(\d+)/) || [])[1];
    return `TYLER-${set}-P${p}-Q${q ? pad(q) : '??'}`;
  }
  if (ex === 'MAT') { const y = (r.match(/(\d{4})/) || [])[1]; const l = (r.match(/q?1?\s*([a-j])\b/) || [])[1]; return `MAT-${y ?? '????'}-${l ? l.toUpperCase() : '?'}`; }
  // Asher Falcon's mock. Same reason as the Rosie branch below: without it these fall
  // through to the TMUA-official branch and mint TMUA-????-P1-Qnn, one id shared by
  // every unrecognised paper.
  if (/asher|falcon|\baf\b/.test(r)) {
    const p = (r.match(/p\s*([12])/) || [])[1] ?? '1';
    const q = (r.match(/q\s*(\d+)/) || [])[1];
    return `AF-P${p}-Q${q ? pad(q) : '??'}`;
  }
  // JZMaths mock sets A-E, two papers each. Without this every JZ question falls through to
  // the TMUA-official branch, finds no year, and mints TMUA-????-P?-Q?? — one id shared by
  // all 200. "JZ SA P1 Q01" (what the simulator writes) and "JZ Set A Paper 1 Q7" carry an
  // s/set marker; a human typing "jz b p2 q13" does not, hence the second pattern.
  if (/\bjz\b|jzmaths/.test(r)) {
    const set = (r.match(/\bs(?:et)?\s*([a-e])\b/) || r.match(/\bjz(?:maths)?\s*(?:mock\s*)?([a-e])\b/) || [])[1]?.toUpperCase() ?? '?';
    const p = (r.match(/p(?:aper)?\s*([12])/) || [])[1] ?? '1';
    const q = (r.match(/q\s*(\d+)/) || [])[1];
    return `JZ-${set}-P${p}-Q${q ? pad(q) : '??'}`;
  }
  // Rosie's practice sets. Without this they fall through to the TMUA-official branch,
  // which finds no year and mints TMUA-????-P1-Qnn — one id shared by every unrecognised
  // paper. Set letters are Greek on the paper ("Set alpha"); normalise to a letter.
  if (/rosie/.test(r)) {
    const set = (r.match(/\bs\s*([a-z])\b/) || [])[1]?.toUpperCase()
      ?? (/alpha/.test(r) ? 'A' : /beta/.test(r) ? 'B' : '?');
    const p = (r.match(/p\s*([12])/) || [])[1] ?? '1';
    const q = (r.match(/q\s*(\d+)/) || [])[1];
    return `ROSIE-${set}-P${p}-Q${q ? pad(q) : '??'}`;
  }
  // TMUA official
  const y = (r.match(/(\d{4})/) || [])[1] ?? (r.includes('practice') ? 'PRAC' : r.includes('spec') ? 'SPEC' : '????');
  const p = (r.match(/p\s*([12])/) || [])[1] ?? '?';
  const q = (r.match(/q\s*(\d+)/) || [])[1];
  return `TMUA-${y}-P${p}-Q${q ? pad(q) : '??'}`;
}

/** Canonical id from a questions_attempted row (may carry qid, or paper+year+part). */
export function canonicalFromAttempt(row) {
  if (row?.qid) {
    // mock rows: qid like "Chen Q11" / "Tyler SA P1 Q17"
    const exam = /chen|\bjam\b/i.test(row.qid) ? 'CHEN' : /tyler/i.test(row.qid) ? 'TMUA' : (row.paper ?? 'TMUA');
    return canonicalId(exam, row.qid);
  }
  const paper = String(row?.paper ?? 'MAT').toUpperCase();
  if (paper.startsWith('MAT')) return canonicalId('MAT', `${row.year} Q1${row.part}`);
  return canonicalId('TMUA', `${row.year} ${row.part}`); // part like "P1 Q7"
}

/** Canonical id from a tag-index question object (id like TMUA2017P1Q19, MAT2007J, CHEN_Q11). */
export function canonicalFromIndexId(id) {
  const s = String(id ?? '').toUpperCase().replace(/[_\s-]/g, '');
  let m;
  if ((m = s.match(/^MAT(\d{4})([A-J])$/))) return `MAT-${m[1]}-${m[2]}`;
  if ((m = s.match(/^TMUA(\d{4})P([12])Q(\d+)/))) return `TMUA-${m[1]}-P${m[2]}-Q${pad(m[3])}`;
  // "JC_25_P1_Q07" in the question files strips to JC25P1Q07. The bare CHENQnn form is the
  // pre-2026 index id for what is now James Chen 2025 Paper 1; it maps onto that paper so a
  // stored id from before the rename still joins to its classification.
  if ((m = s.match(/^JC(25|26)P([12])Q(\d+)/))) return `JC-${m[1]}-P${m[2]}-Q${pad(m[3])}`;
  if ((m = s.match(/^CHENQ(\d+)/))) return `JC-25-P1-Q${pad(m[1])}`;
  if ((m = s.match(/^TYLER(?:S)?([A-D])P([12])Q(\d+)/))) return `TYLER-${m[1]}-P${m[2]}-Q${pad(m[3])}`;
  if ((m = s.match(/^ROSIE(?:S)?([A-Z])P([12])Q(\d+)/))) return `ROSIE-${m[1]}-P${m[2]}-Q${pad(m[3])}`;
  // "JZ_SA_P1_Q01" in the question files, which the strip above turns into JZSAP1Q01.
  if ((m = s.match(/^JZ(?:S)?([A-E])P([12])Q(\d+)/))) return `JZ-${m[1]}-P${m[2]}-Q${pad(m[3])}`;
  if ((m = s.match(/^HER(?:S)?([1-3])P([12])Q(\d+)/))) return `HER-${m[1]}-P${m[2]}-Q${pad(m[3])}`;
  if ((m = s.match(/^EUC(?:S)?(R2D|[1-4])P([12])Q(\d+)/))) return `EUC-${m[1]}-P${m[2]}-Q${pad(m[3])}`;
  if ((m = s.match(/^AFP([12])Q(\d+)/))) return `AF-P${m[1]}-Q${pad(m[2])}`;
  if ((m = s.match(/^DJS(?:S)?(ALPHA|A0|[A-C])P([12])Q(\d+)/))) return `DJS-${m[1]}-P${m[2]}-Q${pad(m[3])}`;
  return null;
}
