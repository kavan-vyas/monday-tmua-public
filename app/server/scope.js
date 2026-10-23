// Scope gate: a hard backstop so an off-topic question never reaches the tutor.
//
// The prompt already forbids answering non-maths questions. This exists because a
// prompt rule is only as strong as the model's compliance on the day, and it already
// failed once — a cooking question got a full recipe mid-session.
//
// Design bias is deliberately toward LETTING THINGS THROUGH. A tutor that refuses a
// legitimate maths question is far worse than one that occasionally passes an odd
// message along, so:
//   - short messages are never gated ("yes", "c", "next", "done")
//   - anything carrying maths or study signal is never gated
//   - only longer prose with no study signal at all is classified
//   - the classifier must be confident to block; ambiguity passes through
//   - an explicit override phrase always passes
import { query } from '@anthropic-ai/claude-agent-sdk';

const OVERRIDE = /\b(pause tutor mode|resume session|override scope|i know it's off topic, answer anyway)\b/i;

// Anything that smells of maths, the exams, the records, or the app itself.
const STUDY = new RegExp([
  'math', 'tmua', 'mat\\b', 'step\\b', 'paper', 'question', '\\bq\\d', 'exam', 'mark ?scheme',
  'solution', 'answer', 'topic', 'backlog', 'revis', 'session', 'log', 'drill', 'practice',
  'algebra', 'calculus', 'integrat', 'different', 'trig', 'logarith', 'geometr', 'graph',
  'sequence', 'series', 'probab', 'combinator', 'proof', 'logic', 'polynomial', 'quadratic',
  'equation', 'inequal', 'function', 'vector', 'matri', 'modul', 'factor', 'root', 'derivat',
  'tangent', 'circle', 'triangle', 'binomial', 'induction', 'contradiction', 'counterexample',
  'homework', 'timer', 'schedule', 'dashboard', 'score', 'grade', 'stuck',
  // App actions — commands to drive the tutor's own tools. Without these, bare
  // navigation like "open in a new tab", "pull it up", "scroll", "next" fell
  // through to the off-topic classifier and got refused as "not what I'm here for".
  'open', 'pdf', 'scroll', '\\btab', 'viewer', 'pane', 'show', 'pull ?up', 'next',
  'page', 'mock', 'tyler', 'chen', 'due', 'list', 'sheet', 'annotat', 'video', 'r2drew',
  'explain', 'how do i solve', 'working', 'method', 'formula', 'theorem',
  'tired', 'ill\\b', 'sick', 'busy', 'stress', 'sleep',
  // The exam simulator's own vocabulary. A debrief straight after a sitting ("the
  // navigator still said four incomplete", "I flagged six and ran out of time") can
  // carry no maths at all, and without these words it reaches the haiku classifier —
  // which is exactly the shape of message this gate exists to let THROUGH.
  'navigator', 'flag', 'review screen', 'simulator', 'sitting', 'mock exam',
  'time remaining', 'unseen', 'incomplete', 'end exam', 'jz\\b', 'jzmaths',
  // Deliberately NOT here: "why", "time", "wrong", "correct". They are common enough
  // outside maths ("why is that team best", "what time is it") that they waved real
  // off-topic messages straight through. Losing them costs one cheap classifier call
  // on a few genuine maths questions, which is the right trade.
].join('|'), 'i');

const MATHSY = /[=+\-×÷^√∫∑π]|\d\s*[a-z]\b|\b[a-z]\s*[=<>]|\bx\^|\bdx\b|\bf\(x\)/i;

// Questions about Monday itself. This gate predates Monday, and its STUDY list has no
// idea the assistant now has a name, a build it can describe, and a memory of its own
// teaching. Without this, "what are you and what can't you do" reaches the haiku
// classifier, which called it a "Technical backend query" and blocked it outright at
// 0.92 confidence — the app refusing to talk about itself, which is the one thing
// plangamma B1 layer 3 explicitly requires it to do.
const SELF = new RegExp([
  '\\bmonday\\b', '\\byourself\\b', '\\bmonday_(self|recall|note)\\b', '\\bmcp__tutor__',
  '\\b(what|who|how)\\s+(are|is)\\s+you\\b',
  "\\byou(r|'re)?\\s+(build|model|tools?|memory|name|voice|prompt|version|effort|limits?)\\b",
  "\\bcan'?t you do\\b", '\\btools?\\b', '\\bremember\\b', '\\bknow about me\\b',
  '\\bcontext\\b.{0,15}\\b(left|window|usage|remaining|used|tokens?)\\b',
].join('|'), 'i');

/** Cheap local pass. Returns 'allow' or 'check'. */
export function preScreen(text) {
  const t = (text ?? '').trim();
  // 15, not 25: "how to cook jollof rice" is 23 characters, and it is the exact
  // message this gate exists for. Real short replies ("yes", "next", "c", "no idea",
  // "im stuck") all sit comfortably below 15.
  if (t.length < 15) return 'allow';
  if (OVERRIDE.test(t)) return 'allow';
  if (STUDY.test(t) || MATHSY.test(t) || SELF.test(t)) return 'allow';
  return 'check';
}

async function classify(text) {
  const q = query({
    prompt: `A student is messaging a tutor app that ONLY covers maths (TMUA/MAT/STEP admissions tests and A-level maths), the student's exam preparation, their study records and schedule, and how the app works.

Message: """${text.slice(0, 800)}"""

Is this message within that scope? Anything about maths, their papers, their progress, their revision, their wellbeing as it affects study, or the app itself is IN scope. The app's assistant is called Monday: questions about what it is, what it runs on, what it can and cannot do, its tools, its memory of the student, or how much context it has left are all IN scope — it is designed to answer them. Recipes, coding help, general knowledge, other school subjects, entertainment, news are OUT of scope.

Reply with one line of JSON only:
{"in_scope":true|false,"confidence":0.0-1.0,"topic":"<3 words>"}`,
    options: { model: 'haiku', maxTurns: 1, allowedTools: [] },
  });
  let out = '';
  for await (const msg of q) {
    if (msg.type === 'assistant') for (const b of msg.message.content) if (b.type === 'text') out += b.text;
    if (msg.type === 'result') break;
  }
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/**
 * @returns {Promise<{blocked: boolean, topic?: string, confidence?: number}>}
 * Fails open: any error, any hesitation from the classifier, and the message goes to
 * the tutor as normal.
 */
export async function checkScope(text) {
  if (preScreen(text) === 'allow') return { blocked: false };
  try {
    const r = await classify(text);
    if (!r || r.in_scope !== false) return { blocked: false };
    if ((r.confidence ?? 0) < 0.8) return { blocked: false };
    return { blocked: true, topic: r.topic ?? 'that', confidence: r.confidence };
  } catch {
    return { blocked: false };
  }
}

/** The refusal the student sees. One line, no lecture, names the next piece of work. */
export function redirectLine(nextWork) {
  return nextWork
    ? `Not what I'm here for — I only do your maths and your prep. ${nextWork}`
    : `Not what I'm here for — I only do your maths and your prep. What do you want to work on?`;
}
