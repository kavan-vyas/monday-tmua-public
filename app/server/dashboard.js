// Dashboard derivation. Reads the source-of-truth record (session_memory.json) and
// regenerates tutor_data/dashboard-site/data/*.json in pure code — no model tokens.
// The tutor used to hand-write these files with ~8 tool calls per refresh; it no
// longer touches them at all.
//
// ANONYMITY: the published site is PUBLIC. Nothing here may emit the student's name,
// school or any PII. Only derived stats, question ids (year/part) and topic labels.
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, TUTOR_DATA } from './paths.js';
import { matQ1Tag } from './tagindex.js';
import { computeReadinessSync } from './readiness.js';
import { buildRecommendations } from './recommend.js';
import { canonicalId, canonicalFromAttempt } from './canonical.js';
import { listSittings } from './exam.js';
import { computeBoard } from './board.js';

const MEMORY = path.join(TUTOR_DATA, 'memory', 'session_memory.json');
const ACTIVITY = path.join(TUTOR_DATA, 'activity_log.json');

// Rest days — no work assumed on these. 0=Sun … 6=Sat.
const REST_DAYS = new Set([1, 3]); // Monday, Wednesday
const OUT = path.join(TUTOR_DATA, 'dashboard-site', 'data');

// Fields that must never reach the public site, whatever the schema grows into.
const PII_KEYS = new Set(['student', 'name', 'school', 'email', 'address', 'phone']);

const DEFAULT_EXAM_DATE = '2026-10-12';

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(name, obj) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(obj, null, 2));
}
const today = () => new Date().toISOString().slice(0, 10);
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
const qid = (q) => `${q.paper ?? 'MAT'} ${q.year}${q.part}`;

// Defence in depth: strip PII keys from anything we are about to publish.
function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (PII_KEYS.has(k.toLowerCase())) continue;
      out[k] = scrub(v);
    }
    return out;
  }
  return value;
}

// Backlog for the public board. Refs and topics only — the detail lines are the
// student's own error notes and stay private, like everything else personal.
function readBacklogForBoard() {
  const items = readJSON(path.join(TUTOR_DATA, 'backlog.json'), { items: [] }).items ?? [];
  const t = today();
  const open = items.filter((i) => i.status !== 'done');
  return {
    open: open.length,
    due: open.filter((i) => i.due && i.due <= t).length,
    cleared: items.filter((i) => i.status === 'done').length,
    byTier: [1, 7, 21].map((tier) => ({ tier, count: open.filter((i) => i.tier === tier).length })),
    byExam: ['TMUA', 'MAT', 'STEP', 'OTHER'].map((ex) => ({ exam: ex, count: open.filter((i) => i.exam === ex).length })).filter((e) => e.count > 0),
    items: open.map((i) => ({ exam: i.exam, ref: i.ref, topic: i.topic, tier: i.tier, due: i.due, bucket: i.bucket })),
  };
}

// Collapse repeat attempts into one current-state record per question, keeping history.
function buildQuestions(mem) {
  const rows = Array.isArray(mem.questions_attempted) ? mem.questions_attempted : [];
  const byId = new Map();
  for (const r of rows) {
    // MAT/TMUA official rows key on year+part; mock rows (Tyler/Chen) carry an
    // explicit qid instead, so they log per-question like everything else.
    const id = r.qid || (r?.year != null && r?.part ? qid(r) : null);
    if (!id) continue;
    if (!byId.has(id)) {
      byId.set(id, {
        id, paper: r.paper ?? 'MAT', year: r.year ?? null, part: r.part ?? null, topic: r.topic ?? 'unknown',
        attempts: [], first_date: r.date ?? null,
      });
    }
    const q = byId.get(id);
    q.topic = r.topic ?? q.topic;
    q.attempts.push({
      date: r.date ?? null,
      correct: r.correct === true,
      misconception: r.misconception ?? null,
      source: r.source ?? 'session',
      note: r.note ?? null,
      // The tracker's "m" — got it, but wants to see it again — rides on the row itself.
      // Dropping it here is what kept every such question showing as plain "solid".
      shaky: r.shaky === true,
      socratic_exchanges: r.socratic_exchanges ?? 0,
    });
  }

  const queue = Array.isArray(mem.review_queue) ? mem.review_queue : [];
  // A mock row has no year and carries the whole question reference in `part`, which is
  // exactly the id the attempts above are keyed on. Keying it as "<paper> null<part>"
  // instead — and hard-coding "MAT " for the shaky notes — meant no mock question ever
  // matched its own review-queue or shaky entry: they came back as duplicate ghost rows
  // with no open status and no note.
  const rowId = (r) => (r?.year == null && r?.part ? String(r.part) : `${r?.paper || 'MAT'} ${r?.year}${r?.part}`);
  const inQueue = new Set(queue.map(rowId));
  const shaky = new Map(
    (Array.isArray(mem.shaky_correct) ? mem.shaky_correct : []).map((s) => [rowId(s), s.note ?? ''])
  );

  const questions = [];
  for (const q of byId.values()) {
    q.attempts.sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')));
    const latest = q.attempts[q.attempts.length - 1];
    const everWrong = q.attempts.some((a) => !a.correct);
    const open = inQueue.has(q.id);

    // status drives the "good at / bad at" view
    let status;
    if (open) status = 'open';                                   // still in the review queue
    else if (latest.correct && everWrong) status = 'resolved';   // got it wrong, then fixed it
    // "Shaky" was recorded in two places that never agreed: a separate shaky_correct
    // list, and a `shaky` flag on the attempt row itself, which is what the tracker's
    // "m" (maybe / revisit) marks become. Reading only the list meant every m marked
    // since the tracker import showed on the board as plain "solid" — right, no doubt
    // attached — which is the opposite of what he wrote down.
    else if (latest.correct && (shaky.has(q.id) || q.attempts.some((a) => a.shaky))) status = 'shaky';
    else if (latest.correct) status = 'solid';
    else status = 'open';

    questions.push({
      id: q.id, paper: q.paper, exam: String(q.paper ?? 'MAT').toUpperCase(),
      year: q.year, part: q.part, topic: q.topic,
      status,
      attempts: q.attempts.length,
      correct: latest.correct,
      ever_wrong: everWrong,
      first_date: q.attempts[0]?.date ?? null,
      last_date: latest.date ?? null,
      misconception: latest.misconception ?? q.attempts.find((a) => a.misconception)?.misconception ?? null,
      note: latest.note ?? null,
      shaky_note: shaky.get(q.id)
        ?? (q.attempts.some((a) => a.shaky) ? 'marked "maybe / revisit" on his tracker' : null),
      source: latest.source,
    });
  }

  // questions that only exist in the review queue (never itemised as an attempt)
  for (const r of queue) {
    const id = rowId(r);
    if (byId.has(id)) continue;
    questions.push({
      id, paper: r.paper || 'MAT', exam: String(r.paper || 'MAT').toUpperCase(), year: r.year, part: r.part, topic: r.topic ?? 'unknown',
      status: 'open', attempts: 1, correct: false, ever_wrong: true,
      first_date: null, last_date: null,
      misconception: r.misconception ?? null, note: null, shaky_note: null, source: 'review_queue',
    });
  }

  // Every part in mat_q1_used that was never itemised was a clean first-time correct
  // (the import note: parts marked "y" are Category 4, recorded in mat_q1_used only).
  // Without these the board shows only the problem questions, which is not the record.
  const seen = new Set(questions.map((q) => q.id));
  for (const paper of Array.isArray(mem.mat_q1_used) ? mem.mat_q1_used : []) {
    for (const part of paper.parts ?? []) {
      const id = `MAT ${paper.year}${part}`;
      if (seen.has(id)) continue;
      const tag = matQ1Tag(paper.year, part) ?? {};
      questions.push({
        id, paper: 'MAT', exam: 'MAT', year: paper.year, part, topic: tag.topic ?? 'unknown',
        status: 'clean', attempts: 1, correct: true, ever_wrong: false,
        first_date: null, last_date: null,
        misconception: null, note: tag.description ?? null, shaky_note: null,
        source: 'self_study',
      });
      seen.add(id);
    }
  }

  // fill in topics/descriptions for itemised rows too, where the index knows better
  for (const q of questions) {
    const tag = matQ1Tag(q.year, q.part);
    if (!tag) continue;
    if (!q.topic || q.topic === 'unknown') q.topic = tag.topic ?? q.topic;
    q.description = tag.description ?? null;
  }

  // Cross-reference the app's backlog by canonical id, so the board shows the same
  // rework state (tier / due / notes) the app does — one truth, two surfaces.
  const backlog = readJSON(path.join(TUTOR_DATA, 'backlog.json'), { items: [] }).items ?? [];
  const blByCanon = new Map(backlog.map((i) => [i.cid || canonicalId(i.exam, i.ref), i]));
  for (const q of questions) {
    const cid = q.year == null
      // Route mocks by their REF, not by a hard-coded exam. This used to force every
      // TMUA-MOCK row to CHEN, which was harmless while Chen and Tyler were the only
      // mocks and became wrong the moment a third arrived — Rosie SA P1 Q6 was being
      // filed as CHEN-06 and colliding with Chen's own Q6 in the backlog join.
      ? canonicalId(q.exam === 'OTHER' || q.exam === 'TMUA-MOCK' ? 'TMUA' : q.exam, q.id)
      : canonicalFromAttempt({ paper: q.paper, year: q.year, part: q.part });
    q.canonical_id = cid;
    const b = blByCanon.get(cid);
    // An empty monday array is still an array, so the old truthiness test reported notes
    // on every item that had none.
    const noteCount = (v) => (Array.isArray(v) ? v.length : v ? 1 : 0);
    if (b) q.backlog = { tier: b.tier, due: b.due, status: b.status, bucket: b.bucket, has_notes: noteCount(b.notes?.student) + noteCount(b.notes?.monday) > 0 };
  }

  questions.sort((a, b) => (a.year || 0) - (b.year || 0) || String(a.id).localeCompare(String(b.id)));
  return questions;
}

function buildTopics(mem, questions) {
  // topic_stats carries the true totals (bulk self-study imports were never itemised),
  // so prefer it for accuracy and use the itemised rows for the detail counts.
  const stats = mem.topic_stats && typeof mem.topic_stats === 'object' ? mem.topic_stats : {};
  const itemised = new Map();
  for (const q of questions) {
    const t = itemised.get(q.topic) ?? { open: 0, resolved: 0, shaky: 0, solid: 0, clean: 0, listed: 0 };
    t[q.status] = (t[q.status] ?? 0) + 1;
    t.listed += 1;
    itemised.set(q.topic, t);
  }

  const topics = [];
  const names = new Set([...Object.keys(stats), ...itemised.keys()]);
  for (const name of names) {
    const s = stats[name] ?? {};
    const attempted = Number(s.attempted ?? 0);
    const correct = Number(s.correct ?? 0);
    const d = itemised.get(name) ?? { open: 0, resolved: 0, shaky: 0, solid: 0, listed: 0 };
    if (attempted === 0 && d.listed === 0) continue;
    topics.push({
      topic: name,
      attempted, correct,
      accuracy: pct(correct, attempted),
      open: d.open, resolved: d.resolved, shaky: d.shaky, solid: d.solid, clean: d.clean,
      listed: d.listed,
      strength: Array.isArray(mem.strengths) && mem.strengths.includes(name),
    });
  }
  topics.sort((a, b) => b.attempted - a.attempted || a.topic.localeCompare(b.topic));
  return topics;
}

function buildStats(mem, questions, topics) {
  const sessions = Array.isArray(mem.sessions) ? mem.sessions : [];
  const attempted = Number(mem.total_questions_attempted ?? 0);
  const correct = Number(mem.total_correct ?? 0);
  const accuracy = mem.overall_accuracy != null ? Number(mem.overall_accuracy) : pct(correct, attempted);
  const open = questions.filter((q) => q.status === 'open').length;

  const exam = mem.exam_date || DEFAULT_EXAM_DATE;
  const days = Math.max(0, Math.round((new Date(exam) - new Date(today())) / 86400000));

  return {
    generated: today(),
    generator: 'server-derived',
    headline: [
      { label: 'Questions', value: attempted, sub: 'attempted', tone: 'blue' },
      { label: 'Accuracy', value: `${accuracy}%`, sub: `${correct} correct`, tone: accuracy >= 80 ? 'green' : 'amber' },
      { label: 'Open backlog', value: open, sub: 'in review queue', tone: open === 0 ? 'green' : open > 5 ? 'red' : 'amber' },
      { label: 'Days to exam', value: days, sub: new Date(exam).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }), tone: 'orange' },
    ],
    secondary: [
      { label: 'Sessions', value: sessions.length },
      { label: 'Topics tracked', value: topics.length },
      { label: 'Questions logged', value: questions.length },
      { label: 'Resolved', value: questions.filter((q) => q.status === 'resolved').length },
      { label: 'Shaky', value: questions.filter((q) => q.status === 'shaky').length },
      { label: 'Solid', value: questions.filter((q) => q.status === 'solid').length },
    ],
  };
}

// Contribution calendar.
//   level 1 = assumed practice day (every day except Mon/Wed, from the first recorded
//             activity to today) — the working pattern, not a logged event.
//   level 2-4 = actually recorded work, darker with volume.
// Recorded days always beat the assumption.
function buildActivity(mem, log) {
  const byDate = new Map();
  const put = (date, count, kind, detail) => {
    if (!date) return;
    const d = String(date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    const cur = byDate.get(d) ?? { date: d, count: 0, kind, details: [] };
    cur.count += count;
    if (detail) cur.details.push(detail);
    if (kind === 'session') cur.kind = 'session';
    byDate.set(d, cur);
  };

  for (const s of Array.isArray(mem.sessions) ? mem.sessions : []) {
    const attempted = Number(String(s.score ?? '0/0').split('/')[1] || 0);
    const label = s.mode === 'self_study_import' ? 'Self-study' : `Session ${s.session_number}`;
    put(s.date, attempted || 1, s.mode === 'self_study_import' ? 'self_study' : 'session',
      `${label} — ${s.score ?? ''}`.trim());
  }
  for (const q of Array.isArray(mem.questions_attempted) ? mem.questions_attempted : []) {
    if (q.date) put(q.date, 0, 'question', null); // dates already counted via sessions
  }
  const sessionDates = new Set((Array.isArray(mem.sessions) ? mem.sessions : []).map((s) => String(s.date).slice(0, 10)));
  for (const e of Array.isArray(log.entries) ? log.entries : []) {
    if (e.type === 'self_report') {
      // Only skip when a session row already covers that day; otherwise surface it,
      // so a self-reported sitting never silently vanishes from the board.
      const d = String(e.ts).slice(0, 10);
      if (sessionDates.has(d)) continue;
      put(e.ts, 1, 'session', (e.detail ?? 'Self-reported work').slice(0, 60));
      continue;
    }
    put(e.ts, 1, 'log', `${e.type}${e.topic ? ` · ${e.topic}` : ''}`);
  }

  const recorded = [...byDate.keys()].sort();
  const end = today();
  const start = recorded[0] ?? end;

  const days = [];
  for (let d = new Date(start + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    const hit = byDate.get(iso);
    if (hit && hit.count > 0) {
      const level = hit.count >= 15 ? 4 : hit.count >= 5 ? 3 : 2;
      days.push({ date: iso, count: hit.count, level, kind: hit.kind,
        detail: hit.details.filter(Boolean).slice(0, 4).join(' · ') || 'Work recorded' });
    } else if (!REST_DAYS.has(d.getUTCDay())) {
      days.push({ date: iso, count: 0, level: 1, kind: 'assumed', detail: 'Practice day' });
    } else {
      days.push({ date: iso, count: 0, level: 0, kind: 'rest', detail: 'Rest day' });
    }
  }

  const worked = days.filter((x) => x.level > 0).length;
  return {
    generated: today(),
    start, end,
    rest_days: ['Monday', 'Wednesday'],
    totals: {
      days_in_range: days.length,
      days_worked: worked,
      days_recorded: days.filter((x) => x.level >= 2).length,
    },
    days,
  };
}

function buildElements(mem, questions, topics) {
  const el = [];
  const day = today();
  const push = (id, type, title, data, span = 1) => el.push({ id, date: day, type, title, span, data });

  // topic accuracy — the headline "what am I good/bad at"
  const ranked = topics.filter((t) => t.attempted > 0).slice().sort((a, b) => b.accuracy - a.accuracy);
  push('topic-acc', 'bars', 'Topic accuracy', {
    unit: '%',
    items: ranked.map((t) => ({
      label: t.topic.replace(/_/g, ' '),
      value: t.accuracy,
      sub: `${t.correct}/${t.attempted}`,
      tone: t.accuracy >= 85 ? 'green' : t.accuracy >= 65 ? 'amber' : 'red',
    })),
  }, 2);

  // strongest / weakest, explicit
  const strong = ranked.filter((t) => t.accuracy >= 85 && t.attempted >= 2);
  const weak = ranked.filter((t) => t.accuracy < 70 && t.attempted >= 1).reverse();
  push('good-at', 'list', 'Good at', {
    items: strong.map((t) => ({ text: `${t.topic.replace(/_/g, ' ')} — ${t.accuracy}% (${t.correct}/${t.attempted})`, tone: 'green' })),
  });
  push('bad-at', 'list', 'Needs work', {
    items: weak.map((t) => ({ text: `${t.topic.replace(/_/g, ' ')} — ${t.accuracy}% (${t.correct}/${t.attempted})`, tone: t.accuracy < 50 ? 'red' : 'amber' })),
  });

  // open backlog — every question still unresolved
  const open = questions.filter((q) => q.status === 'open');
  push('backlog', 'table', `Open backlog (${open.length})`, {
    columns: ['Question', 'Topic', 'What went wrong'],
    rows: open.map((q) => [q.id, q.topic.replace(/_/g, ' '), q.misconception ?? '—']),
    tone: open.length === 0 ? 'green' : 'red',
  }, 2);

  // wins — questions that were wrong and are now fixed
  const resolved = questions.filter((q) => q.status === 'resolved');
  push('resolved', 'table', `Resolved (${resolved.length})`, {
    columns: ['Question', 'Topic', 'How it was fixed'],
    rows: resolved.map((q) => [q.id, q.topic.replace(/_/g, ' '), q.note ?? 'second attempt correct']),
    tone: 'green',
  }, 2);

  // right but fragile
  const shaky = questions.filter((q) => q.status === 'shaky');
  push('shaky', 'table', `Correct but shaky (${shaky.length})`, {
    columns: ['Question', 'Topic', 'Why it is fragile'],
    rows: shaky.map((q) => [q.id, q.topic.replace(/_/g, ' '), q.shaky_note ?? '—']),
    tone: 'amber',
  }, 2);

  // every question, current state — the full record
  push('all-questions', 'table', `All questions (${questions.length})`, {
    columns: ['Question', 'Topic', 'Status', 'Attempts'],
    rows: questions.map((q) => [q.id, q.topic.replace(/_/g, ' '), q.status, String(q.attempts)]),
    scroll: true,
  }, 4);

  // recurring patterns, as written by the tutor
  push('patterns', 'list', 'Recurring patterns', {
    items: (Array.isArray(mem.misconceptions) ? mem.misconceptions : []).map((m) => ({
      text: m,
      tone: /RESOLVED/i.test(m) ? 'green' : 'amber',
    })),
  }, 2);

  // paper coverage
  const used = Array.isArray(mem.mat_q1_used) ? mem.mat_q1_used : [];
  push('coverage', 'grid', 'MAT Q1 coverage', {
    items: used.map((u) => ({ label: String(u.year), value: `${(u.parts ?? []).length}/10`,
      tone: (u.parts ?? []).length === 10 ? 'green' : 'amber' })),
  }, 2);

  // homework
  const hw = Array.isArray(mem.homework_set) ? mem.homework_set : [];
  const done = Array.isArray(mem.homework_done) ? mem.homework_done : [];
  if (hw.length) {
    push('homework', 'list', 'Homework', {
      items: hw.map((h, i) => ({
        text: `MAT ${h.year}${h.part} — ${(h.topic ?? '').replace(/_/g, ' ')}`,
        tone: done[i] ? 'green' : 'amber',
      })),
    });
  }

  return { generated: today(), elements: el };
}

// ── deep analysis, all pure code from the records Monday keeps as it logs ──────
// This is what analytics.json used to be, except derived here every rebuild instead
// of written by the model every third session — so it is never stale and costs nothing.
function buildAnalysis(mem, log) {
  const sessions = Array.isArray(mem.sessions) ? mem.sessions : [];
  const qa = Array.isArray(mem.questions_attempted) ? mem.questions_attempted : [];
  const tstats = mem.topic_stats && typeof mem.topic_stats === 'object' ? mem.topic_stats : {};
  const misc = Array.isArray(mem.misconceptions) ? mem.misconceptions : [];
  const weak = Array.isArray(mem.weak_areas) ? mem.weak_areas : [];

  // accuracy trend, one point per session in order
  const trend = sessions
    .filter((x) => x && x.date)
    .map((x) => ({
      session: x.session_number, date: x.date, mode: x.mode,
      score: x.score ?? null,
      accuracy: x.accuracy_pct != null ? Number(x.accuracy_pct) : null,
      topics: Array.isArray(x.topics_covered) ? x.topics_covered : [],
    }));

  // per-topic mastery table
  const missByTopic = Object.fromEntries(weak.map((w) => [w.topic, w]));
  const topics = Object.entries(tstats).map(([topic, v]) => {
    const att = Number(v.attempted ?? 0);
    const cor = Number(v.correct ?? 0);
    const w = missByTopic[topic];
    return {
      topic, attempted: att, correct: cor, accuracy: pct(cor, att),
      miss_rate: w?.miss_rate != null ? Math.round(w.miss_rate * 1000) / 10 : pct(att - cor, att),
      last_seen: w?.last_seen ?? null,
      note: w?.note ?? null,
    };
  }).sort((a, b) => a.accuracy - b.accuracy);

  // misconception health: how many are resolved vs still live
  const resolved = misc.filter((m) => /RESOL/i.test(String(m))).length;

  // volume + pace, from dated attempts
  const dates = qa.map((q) => q.date).filter(Boolean).sort();
  let perWeek = null;
  if (dates.length > 1) {
    const span = (new Date(dates[dates.length - 1]) - new Date(dates[0])) / (7 * 86400000);
    perWeek = span > 0 ? Math.round((qa.length / span) * 10) / 10 : null;
  }

  let readiness = null;
  try {
    readiness = computeReadinessSync({ examDate: mem.exam_date });
    // Coarsen the millisecond stamp to the day. The live readiness pane wants the
    // real instant, but a published file that differs on every rebuild makes the
    // publish step think there is always something to ship — so "nothing changed"
    // could never be true and the diff never meant anything.
    if (readiness?.generatedAt) readiness = { ...readiness, generatedAt: readiness.generatedAt.slice(0, 10) };
  } catch { /* readiness is best-effort */ }

  let recommendations = [];
  try { recommendations = buildRecommendations().recommendations; } catch { /* best-effort */ }

  return {
    generated: today(),
    generator: 'server-derived',
    trend,
    topics,
    misconceptions: { total: misc.length, resolved, live: misc.length - resolved },
    volume: { total_attempts: qa.length, per_week: perWeek, first: dates[0] ?? null, last: dates[dates.length - 1] ?? null },
    strengths: Array.isArray(mem.strengths) ? mem.strengths : [],
    weaknesses: weak,
    readiness,
    recommendations,
  };
}

// Regenerate every published file except journal.json, which is prose the tutor writes
// through the journal_note tool (one cheap call) rather than by editing JSON.
/**
 * Simulator sittings for the board. A timed paper is the only place the record carries
 * pace at all — everything else in this project is untimed practice — so it gets its own
 * file rather than being flattened into one activity row.
 */
function buildSittings() {
  const rows = listSittings({ limit: 100 }).filter((s) => s.status === 'finished');
  const marked = rows.filter((s) => s.score?.raw != null);
  const timed = rows.filter((s) => s.timing !== 'untimed');
  return {
    generated: today(),
    count: rows.length,
    marked: marked.length,
    timed: timed.length,
    best: marked.length ? Math.max(...marked.map((s) => s.score.raw)) : null,
    sittings: rows.map((s) => ({
      id: s.id,
      paper: s.title,
      paper_id: s.paperId,
      date: String(s.startedAt).slice(0, 10),
      timing: s.timing,
      minutes: s.durationSec == null ? null : Math.round(s.durationSec / 60),
      extra_time: s.extraTime,
      raw: s.score?.raw ?? null,
      out_of: s.score?.outOf ?? null,
      percent: s.score?.percent ?? null,
      grade: s.score?.gradeLabel ?? null,
      equivalent_40: s.score?.equivalentRaw40 ?? null,
      answered: s.answered,
      flagged: s.flagged,
      total_time_sec: s.score?.totalTimeSec ?? null,
      avg_per_question_sec: s.score?.avgPerQuestionSec ?? null,
      reason: s.reason,
    })),
  };
}

/**
 * The "recently done" feed: everything that actually happened, newest first, in one
 * stream — reworks off the backlog, sittings in the simulator, and the notes and
 * insights written into the activity log. Kept as one list on purpose: the board used to
 * show each of these separately, so a day of work looked like three unrelated trickles.
 */
function buildRecent(log, limit = 60) {
  const out = [];

  const backlog = readJSON(path.join(TUTOR_DATA, 'backlog.json'), { items: [] });
  for (const it of backlog.items ?? []) {
    for (const h of it.history ?? []) {
      if (!h?.date) continue;
      out.push({
        kind: 'rework',
        at: h.at ?? `${h.date}T12:00`,
        date: h.date,
        exam: it.exam,
        ref: it.ref,
        topic: it.topic,
        result: h.result,
        tier: h.tier ?? null,
        seconds: h.seconds ?? null,
        pace: h.pace ?? null,
      });
    }
    // No separate "closed" event: a close is bookkeeping, and the rework that earned it
    // is already in the feed. Emitting both made a migration look like a day's work.
  }

  const sittingsDir = path.join(TUTOR_DATA, 'exams', 'sittings');
  if (fs.existsSync(sittingsDir)) {
    for (const f of fs.readdirSync(sittingsDir)) {
      if (!f.endsWith('.json')) continue;
      const s = readJSON(path.join(sittingsDir, f), null);
      if (!s?.startedAt || s.status !== 'finished') continue;
      const sc = s.summary?.score ?? {};
      out.push({
        kind: 'sitting',
        at: s.finishedAt ?? s.startedAt,
        date: String(s.startedAt).slice(0, 10),
        paper: s.paperId,
        raw: sc.raw ?? null,
        out_of: sc.outOf ?? null,
        grade: sc.gradeLabel ?? null,
        minutes: sc.totalTimeSec != null ? Math.round(sc.totalTimeSec / 60) : null,
        reason: s.reason ?? null,
        timing: s.timing ?? null,
      });
    }
  }

  for (const e of log.entries ?? []) {
    if (!e?.ts) continue;
    out.push({ kind: 'note', at: e.ts, date: String(e.ts).slice(0, 10), type: e.type, topic: e.topic ?? null, detail: e.detail ?? '', source: e.source ?? null });
  }

  out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { generated: today(), count: out.length, items: out.slice(0, limit) };
}

export function buildDashboard() {
  const mem = scrub(readJSON(MEMORY, {}));
  const log = readJSON(ACTIVITY, { entries: [] });

  const questions = buildQuestions(mem);
  const topics = buildTopics(mem, questions);

  const activity = buildActivity(mem, log);
  const sittings = buildSittings();
  writeJSON('stats', buildStats(mem, questions, topics));
  writeJSON('analysis', buildAnalysis(mem, log));
  writeJSON('activity', activity);
  writeJSON('elements', buildElements(mem, questions, topics));
  writeJSON('sittings', sittings);
  // The board the site now leads with: the improved-% model (board.js).
  writeJSON('board', computeBoard({
    questions,
    backlog: readJSON(path.join(TUTOR_DATA, 'backlog.json'), { items: [] }).items ?? [],
    reviewQueue: Array.isArray(mem.review_queue) ? mem.review_queue : [],
    activityDays: activity.days,
    sittings: sittings.sittings,
    today: today(),
    examDate: mem.exam_date || DEFAULT_EXAM_DATE,
  }));
  writeJSON('recent', buildRecent(log));
  writeJSON('questions', {
    generated: today(),
    questions,
    topics,
    review_queue: (Array.isArray(mem.review_queue) ? mem.review_queue : []).map((r) => ({
      id: `${r.paper || 'MAT'} ${r.year}${r.part}`, topic: r.topic, misconception: r.misconception,
      review_date: r.review_date, times_reviewed: r.times_reviewed ?? 0,
    })),
    // per-exam split — TMUA, MAT and STEP are separate exams and must never be pooled
    exams: ['TMUA', 'MAT', 'STEP', 'TMUA-MOCK'].map((ex) => {
      const qs = questions.filter((q) => q.exam === ex);
      const st = (s) => qs.filter((q) => q.status === s).length;
      const done = qs.filter((q) => q.status !== 'open').length;
      return {
        exam: ex, total: qs.length,
        clean: st('clean'), solid: st('solid'), resolved: st('resolved'),
        shaky: st('shaky'), open: st('open'),
        accuracy: pct(done, qs.length),
        topics: [...new Set(qs.map((q) => q.topic))].sort(),
      };
    }).filter((e) => e.total > 0),
    backlog: readBacklogForBoard(),
    summary: {
      total: questions.length,
      clean: questions.filter((q) => q.status === 'clean').length,
      solid: questions.filter((q) => q.status === 'solid').length,
      resolved: questions.filter((q) => q.status === 'resolved').length,
      shaky: questions.filter((q) => q.status === 'shaky').length,
      open: questions.filter((q) => q.status === 'open').length,
    },
  });

  // journal.json: create an empty shell if missing so the site never 404s
  const jf = path.join(OUT, 'journal.json');
  if (!fs.existsSync(jf)) writeJSON('journal', { entries: [] });

  return { questions: questions.length, topics: topics.length };
}

// Append one narrative entry (newest first). Used by the journal_note tool.
export function appendJournal(title, body, date = today()) {
  const jf = path.join(OUT, 'journal.json');
  const j = readJSON(jf, { entries: [] });
  if (!Array.isArray(j.entries)) j.entries = [];
  j.entries.unshift({ date, title, body });
  j.entries = j.entries.slice(0, 60);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(jf, JSON.stringify(j, null, 2));
  return j.entries.length;
}
