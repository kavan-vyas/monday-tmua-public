// Analytics that ACT. The dashboard reports topic accuracy; this turns each weak
// topic into a concrete next move: the exact index questions to drill (with their PDF
// paths resolved) and the R2Drew video segment that teaches it. Pure code, no tokens.
import fs from 'node:fs';
import path from 'node:path';
import { TUTOR_DATA } from './paths.js';
import { queryIndex, resolvePaths } from './tagindex.js';
import { findVideo } from './video.js';
import { canonicalFromIndexId, canonicalFromAttempt, canonicalId } from './canonical.js';

const MEMORY = path.join(TUTOR_DATA, 'memory', 'session_memory.json');
const BACKLOG = path.join(TUTOR_DATA, 'backlog.json');
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

function readMem() {
  try { return JSON.parse(fs.readFileSync(MEMORY, 'utf8')); } catch { return {}; }
}

/**
 * Everything he has already sat, as canonical ids.
 *
 * Recommending a question he has already done is worse than recommending nothing: he has
 * seen the answer, so it measures memory rather than method, and the backlog already owns
 * the ones he got wrong. Both stores are consulted because a question can be in either.
 */
function alreadySeen(mem) {
  const seen = new Set();
  for (const row of mem.questions_attempted ?? []) {
    const c = canonicalFromAttempt(row);
    if (c && !c.includes('?')) seen.add(c);
  }
  let backlog = { items: [] };
  try { backlog = JSON.parse(fs.readFileSync(BACKLOG, 'utf8')); } catch { /* no backlog yet */ }
  for (const item of backlog.items ?? []) {
    const c = item.cid || canonicalId(item.exam, item.ref);
    if (c && !c.includes('?')) seen.add(c);
  }
  return seen;
}

/**
 * The papers he has already sat, as canonical prefixes ("TMUA-2018-P2", "HER-1-P1").
 *
 * A drill pulled from a paper he has never sat costs him that paper as a future mock — the
 * same objection he raised about revision notes quoting unsat questions. So drills come
 * from papers already used up, and only fall back to fresh ones when a topic has nothing
 * else to offer.
 */
function papersSat(seen) {
  const papers = new Set();
  for (const c of seen) {
    const m = /^(.*)-(?:Q\d{1,2}|[A-J])$/.exec(c);
    if (m) papers.add(m[1]);
  }
  return papers;
}

/**
 * For every topic below the accuracy threshold, recommend drill questions + a video.
 * Sorted worst-first. Each drill carries a resolved paper_path so the UI can open it.
 */
export function buildRecommendations({ threshold = 75, perTopic = 4, includeSeen = false } = {}) {
  const mem = readMem();
  const seen = includeSeen ? new Set() : alreadySeen(mem);
  const sat = papersSat(alreadySeen(mem));
  const stats = mem.topic_stats && typeof mem.topic_stats === 'object' ? mem.topic_stats : {};

  const weak = Object.entries(stats)
    .map(([topic, v]) => ({ topic, attempted: Number(v.attempted ?? 0), correct: Number(v.correct ?? 0) }))
    .filter((t) => t.attempted >= 1)
    .map((t) => ({ ...t, accuracy: pct(t.correct, t.attempted) }))
    .filter((t) => t.accuracy < threshold)
    .sort((a, b) => a.accuracy - b.accuracy);

  const recommendations = weak.map((t) => {
    // Drill: verified index questions in this topic, easiest first, official over mock.
    const hits = queryIndex({ topic: t.topic, limit: 120 }).questions ?? [];
    const withCanon = hits.map((q) => ({ q, c: canonicalFromIndexId(q.id) }));
    const fresh = withCanon.filter(({ c }) => !c || !seen.has(c));
    // Questions he has not done, from papers he has already used up. That is the ideal
    // drill: new to him, and it costs nothing he was saving.
    const preferred = fresh.filter(({ c }) => {
      const m = c && /^(.*)-(?:Q\d{1,2}|[A-J])$/.exec(c);
      return m && sat.has(m[1]);
    });
    // If a topic has nothing left in the papers he has sat, fall back — first to any
    // unseen question, then to a re-sit. Better than silence, and the flag says which.
    const pool = (preferred.length ? preferred : fresh.length ? fresh : withCanon).map(({ q }) => q);
    const spendsFreshPaper = preferred.length === 0 && fresh.length > 0;
    const ranked = pool
      .slice()
      .sort((a, b) => (a.difficulty ?? 3) - (b.difficulty ?? 3))
      .slice(0, perTopic)
      .map((q) => {
        const r = resolvePaths(q.id);
        const topics = Array.isArray(q.topic) ? q.topic : [q.topic].filter(Boolean);
        return {
          id: q.id,
          // The topic this question was recommended FOR, not whichever tag happens to be
          // first: a question tagged [algebra, functions] offered under "functions" used to
          // announce itself as algebra, which read like a bug in the recommendation.
          topic: t.topic,
          topics,
          difficulty: q.difficulty ?? null,
          description: q.description ?? null,
          paper_path: r?.paper ?? null,
          search_label: r?.search_label ?? null,
          unseen: fresh.length > 0,
          from_unsat_paper: spendsFreshPaper,
        };
      });
    // Video: the best R2Drew segment for this topic.
    const vids = (findVideo({ topic: t.topic, limit: 2 }).segments ?? []).map((v) => ({
      id: v.videoId, title: v.title, label: v.label ?? null, start: Math.round(v.t_start ?? 0),
    }));
    return {
      topic: t.topic, accuracy: t.accuracy, attempted: t.attempted, correct: t.correct,
      pool: hits.length, unseen_pool: fresh.length, unseen_in_sat_papers: preferred.length,
      drill: ranked, videos: vids,
    };
  });

  return { generated: new Date().toISOString().slice(0, 10), threshold, recommendations };
}
