// Reader for tutor_data/reference/video_index.json.
//
// The index maps R2Drew2's TMUA playlist onto the SAME vocabulary the classification
// index already uses — `topic`, `technique`, `trap_type` from tagindex.js — so a wrong
// answer tagged `necessary_confused_with_sufficient` can be answered with the video
// that covers that trap, rather than with the name of a playlist to go and search.
//
// HONESTY ABOUT WHAT IS IN THERE: every video id, title and duration in the seed was
// read from the live playlist, not invented. Timestamps were NOT: none of these videos
// publishes chapter markers or a timestamped description, so nothing in the seed
// claims a segment narrower than the whole video. `t_end: null` means "to the end".
// Real segment boundaries get added as videos are actually watched.
import fs from 'node:fs';
import path from 'node:path';
import { TUTOR_DATA } from './paths.js';

const INDEX = path.join(TUTOR_DATA, 'reference', 'video_index.json');

export const SCHEMA_VERSION = 1;

const EMPTY = { schema_version: SCHEMA_VERSION, videos: [] };

const cache = { mtimeMs: -1, data: EMPTY };

export function loadVideoIndex() {
  let mtimeMs = -1;
  try { mtimeMs = fs.statSync(INDEX).mtimeMs; } catch { return EMPTY; }
  if (mtimeMs === cache.mtimeMs) return cache.data;
  let data = EMPTY;
  try {
    const parsed = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
    data = { ...EMPTY, ...parsed, videos: Array.isArray(parsed.videos) ? parsed.videos : [] };
  } catch { data = EMPTY; }
  cache.mtimeMs = mtimeMs;
  cache.data = data;
  return data;
}

const lc = (v) => String(v ?? '').toLowerCase();
const hasTag = (arr, want) => Array.isArray(arr) && arr.some((x) => lc(x) === want);

/**
 * Flatten to segments. A video with no explicit segments contributes one segment
 * covering the whole thing, carrying the video's own tags.
 */
function segmentsOf(v) {
  const base = {
    videoId: v.id,
    title: v.title,
    kind: v.kind ?? 'concept',
    duration_s: v.duration_s ?? null,
    paper: v.paper ?? null,
    manifest_key: v.manifest_key ?? null,
  };
  const segs = Array.isArray(v.segments) && v.segments.length ? v.segments : [{ t_start: 0, t_end: null, label: null }];
  return segs.map((s) => ({
    ...base,
    t_start: Number.isFinite(s.t_start) ? s.t_start : 0,
    t_end: Number.isFinite(s.t_end) ? s.t_end : null,
    label: s.label ?? null,
    topic: s.topic ?? v.topic ?? [],
    technique: s.technique ?? v.technique ?? [],
    trap_type: s.trap_type ?? v.trap_type ?? [],
  }));
}

/**
 * Search the index. Every filter is optional and ANDed; `query` is a free-text match
 * on the title and segment label. Returns { total, segments }.
 */
export function findVideo({ topic, technique, trap, query, videoId, exam, year, paper, kind, limit = 8 } = {}) {
  const t = topic ? lc(topic) : null;
  const tech = technique ? lc(technique) : null;
  const tr = trap ? lc(trap) : null;
  const q = query ? lc(query) : null;

  const all = loadVideoIndex().videos.flatMap(segmentsOf);
  const hits = all.filter((s) => {
    if (videoId && s.videoId !== videoId) return false;
    if (kind && lc(s.kind) !== lc(kind)) return false;
    if (t && !hasTag(s.topic, t)) return false;
    if (tech && !hasTag(s.technique, tech)) return false;
    if (tr && !hasTag(s.trap_type, tr)) return false;
    if (exam && lc(s.paper?.exam) !== lc(exam)) return false;
    if (year != null && String(s.paper?.year ?? '') !== String(year)) return false;
    if (paper != null && String(s.paper?.paper ?? '') !== String(paper)) return false;
    if (q && !`${lc(s.title)} ${lc(s.label)}`.includes(q)) return false;
    return true;
  });

  // A tighter tag match is a better answer than a broad one.
  const score = (s) => (s.topic?.length ?? 0) + (s.technique?.length ?? 0) + 2 * (s.trap_type?.length ?? 0);
  hits.sort((a, b) => score(a) - score(b) || String(a.title).localeCompare(String(b.title)));
  return { total: hits.length, segments: hits.slice(0, Math.max(1, limit)) };
}

const clock = (s) => {
  if (!Number.isFinite(s)) return '?';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, '0')}`;
};

export function formatSegments(res, header) {
  if (!res.total) {
    return `${header}\nNothing indexed for that yet. The video index is tutor_data/reference/video_index.json — it grows as videos get watched, so an empty result means "not indexed", not "does not exist".`;
  }
  const lines = res.segments.map((s) => {
    const range = s.t_start === 0 && s.t_end == null
      ? 'whole video'
      : `${clock(s.t_start)}–${s.t_end == null ? 'end' : clock(s.t_end)}`;
    const tags = [...(s.topic ?? []), ...(s.technique ?? []), ...(s.trap_type ?? [])].join(', ');
    return `${s.videoId}  t=${Math.round(s.t_start)}  ${s.title}${s.label ? ` — ${s.label}` : ''} [${range}]${tags ? `\n    ${tags}` : ''}`;
  });
  const more = res.total > res.segments.length ? `\n(showing ${res.segments.length} of ${res.total})` : '';
  return `${header}\n${lines.join('\n')}${more}`;
}

/** True if the index knows this video id at all — used to refuse an invented id. */
export function knowsVideo(id) {
  return loadVideoIndex().videos.some((v) => v.id === id);
}
