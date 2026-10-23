import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { lazy, Suspense } from 'react';

// The computer-based test exam simulator is a separate route, a separate stylesheet and a separate
// chunk — lazily imported so none of it (or its font) loads for the ordinary workspace.
const ExamApp = lazy(() => import('./exam/ExamApp.jsx'));
const ExamReport = lazy(() => import('./exam/Report.jsx'));
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

import MondayOrb from './monday/MondayOrb.jsx';
import StatusLine from './monday/StatusLine.jsx';
import { SOURCES, sourceOf } from './monday/sources.js';
import { colSize, growWeights, healLayout, clampPair } from './monday/layout.js';
import Settings from './monday/Settings.jsx';
import SettingsPane from './monday/SettingsPane.jsx';
import ModeSelector, { ExamBanner, ExamFrame, PauseBanner } from './monday/ModeSelector.jsx';
import ReadinessTab from './monday/ReadinessTab.jsx';
import GradesTab from './monday/GradesTab.jsx';
import VideoTab from './monday/VideoTab.jsx';
import PdfAnnotator from './monday/PdfAnnotator.jsx';
import { audio } from './monday/audio.js';
import PaperFlowTab from './monday/PaperFlowTab.jsx';
import TargetTab from './monday/TargetTab.jsx';
import { useAttention } from './monday/attention.js';
import {
  DEFAULT_PROACTIVE, DEFAULT_VOICE, DEFAULT_SPEECH, DEFAULT_APPEARANCE, DEFAULT_RATE_LIMIT_MIN,
  MODELS, EFFORTS,
  clock, moodColor, moodInk, resolveTheme, setMoodColors, toolCaption,
} from './monday/constants.js';

const NOTES = 'tutor_data/session_notes.md';
const DASHBOARD = 'tutor_data/dashboard.html';

// Claude emits \( \) / \[ \] math delimiters; remark-math only parses $ / $$.
// \[ \] is display (own line, boxed). \( \) stays INLINE — flowing in the sentence.
// Previously both became $$…$$, so "let \(a\) be real" exploded into three
// full-width blocks and a sentence became unreadable.
const mathify = (t = '') =>
  t
    // display first, or the inline rule would eat the inner content of \[ \]
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, m) => `\n\n$$\n${m.trim()}\n$$\n\n`)
    // inline: single $…$, newlines flattened so it stays on one line
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, m) => `$${m.trim().replace(/\s*\n\s*/g, ' ')}$`);

const Md = ({ text }) => (
  <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
    {mathify(text)}
  </ReactMarkdown>
);


// ═══════════════ LaTeX verification fixture (?latex=1) ═══════════════
// Renders every maths case the redesign had to prove through the SAME <Md>
// pipeline the transcript uses. Not reachable from the UI; dev tool only.
const LATEX_CASES = [
  ['inline in a sentence',
   'For the curve $f(x) = \\frac{x^2-1}{x-2}$ the stationary points satisfy $f\'(x)=0$, so we solve it directly.'],
  // NOTE the newline form. remark-math only treats $$ as DISPLAY when the
  // delimiters sit on their own lines — `$$x$$` on one line produces no math
  // node at all. mathify() always emits this form, so Claude's real output is
  // fine; a hand-pasted single-line $$…$$ would not be.
  ['display equation',
   'Evaluating the integral:\n\n$$\n\\int_0^1 \\sqrt{x}\\,dx = \\frac{2}{3}\n$$\n\nwhich is the standard result.'],
  ['long equation — must scroll inside its band, not break the layout',
   '$$\n\\sum_{k=0}^{n} \\binom{n}{k} x^k y^{n-k} = (x+y)^n \\quad\\text{and}\\quad \\int_{-\\infty}^{\\infty} e^{-a x^2}\\,dx = \\sqrt{\\frac{\\pi}{a}} \\quad\\text{and}\\quad \\lim_{n\\to\\infty}\\left(1+\\frac{1}{n}\\right)^n = e\n$$'],
  ['tall display — a nested fraction must not clip at the top',
   '$$\n\\frac{\\dfrac{a}{b} + \\dfrac{c}{d}}{\\dfrac{e}{f} - \\dfrac{g}{h}} = \\sqrt[3]{\\frac{x^2+1}{x^2-1}}\n$$'],
  ['maths in a list item',
   '- First, note $a^2 + b^2 = c^2$ holds.\n- Then $\\frac{d}{dx}\\left(\\frac{1}{x}\\right) = -\\frac{1}{x^2}$.\n- Finally $\\log_a b = \\frac{\\ln b}{\\ln a}$.'],
  ['maths in a table cell',
   '| function | derivative |\n| --- | --- |\n| $x^n$ | $nx^{n-1}$ |\n| $\\sin x$ | $\\cos x$ |\n| $\\frac{1}{x}$ | $-\\frac{1}{x^2}$ |'],
  ["Claude's own delimiters, normalised by mathify()",
   'Let \\(a\\) be real. Then \\[ a^2 \\geq 0 \\] for every such \\(a\\).'],
];

function LatexCheck() {
  // ?theme=light|dark — the harness sets it explicitly so both themes are
  // reachable headlessly, where prefers-color-scheme would otherwise decide.
  const t = new URLSearchParams(window.location.search).get('theme');
  useEffect(() => {
    document.documentElement.dataset.theme = t === 'light' || t === 'dark' ? t : 'light';
  }, [t]);
  return (
    <div className="latex-check">
      <h2>KaTeX verification</h2>
      {LATEX_CASES.map(([label, text]) => (
        <div className="latex-case" key={label}>
          <span className="eyebrow">{label}</span>
          <div className="turn-body"><Md text={text} /></div>
        </div>
      ))}
      <div className="latex-case">
        <span className="eyebrow">a fraction at the narrowest column width supported</span>
        <div className="latex-narrow">
          <div className="turn-body"><Md text={'Solve $\\frac{x^2-1}{x-2} = \\frac{3}{4}$ for $x$.'} /></div>
        </div>
      </div>
    </div>
  );
}

let idc = 0;
const uid = () => `t${Date.now().toString(36)}${idc++}`;

// ═══════════════ files tab ═══════════════
// Folders that start expanded besides the roots. Still closable; they reopen on reload.
const OPEN_BY_DEFAULT = /\/major exams\/tmua$/;

function TreeNode({ node, onSelect, depth }) {
  const [open, setOpen] = useState(depth === 0 || OPEN_BY_DEFAULT.test(node.path));
  if (node.dir) {
    return (
      <div>
        <div className="tree-row dir" style={{ paddingLeft: depth * 12 }} onClick={() => setOpen(!open)}>
          {open ? '−' : '+'} {node.name}
        </div>
        {open && node.children.map((c) => <TreeNode key={c.path} node={c} onSelect={onSelect} depth={depth + 1} />)}
      </div>
    );
  }
  return (
    <div className="tree-row file" style={{ paddingLeft: depth * 12 + 14 }} onClick={() => onSelect(node)} title={node.path}>
      {node.name}
    </div>
  );
}

// Send a PDF to the paper intake. Everything after this is automatic: identify, file
// under "major exams", register, classify, index. Progress arrives over the websocket.
export function uploadPaper(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const [, data] = reader.result.split(',');
    fetch('/api/paper', { method: 'POST', body: JSON.stringify({ name: file.name, data }) });
  };
  reader.readAsDataURL(file);
}

function FilesTab({ onSelect, refreshKey }) {
  const [tree, setTree] = useState([]);
  const [dropped, setDropped] = useState(null);
  const load = useCallback(() => fetch('/api/tree').then((r) => r.json()).then((d) => setTree(d.tree)), []);
  // refreshKey ticks on every file_changed broadcast, so filing, renaming or moving
  // a paper appears here immediately instead of needing the app restarted.
  useEffect(() => { load(); }, [load, refreshKey]);

  function onDrop(e) {
    e.preventDefault();
    for (const file of e.dataTransfer.files) {
      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        uploadPaper(file);
        setDropped(`${file.name} → inbox — tell Monday if it's a paper`);
        setTimeout(() => setDropped(null), 6000);
        continue;
      }
      if (!file.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = async () => {
        const [, data] = reader.result.split(',');
        const r = await fetch('/api/inbox', { method: 'POST', body: JSON.stringify({ media_type: file.type, data }) }).then((x) => x.json());
        setDropped(r.path?.split('/').pop() ?? 'saved');
        setTimeout(() => setDropped(null), 4000);
        load();
      };
      reader.readAsDataURL(file);
    }
  }

  return (
    <div className="tab-fill files-tab">
      <div className="tree-scroll">
        <button className="btn tiny" onClick={load}>Reload</button>
        {tree.map((n) => <TreeNode key={n.path} node={n} onSelect={onSelect} depth={0} />)}
      </div>
      <div className="dropzone" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        {dropped ? `${dropped}` : 'Drop a PDF to file it · screenshot to inbox'}
      </div>
    </div>
  );
}

// ═══════════════ chat tab ═══════════════
const QUICK = [
  { label: 'Start', text: 'Start TMUA session' },
  { label: 'Log practice', text: 'Log external practice I just did: I did ', prefill: true },
  { label: 'Teach me', text: 'Teach me this topic from scratch, then test me: ', prefill: true },
  { label: 'Random question', text: 'Give me one random exam-level question on my weakest topic and drill me on it.' },
  { label: 'End', text: 'End session' },
];
// PERSONAS is gone. Monday is not a persona you pick; its tone is measured from
// the student's real state every turn (see monday_state / app/server/mood.js).

function ChatTab({
  msgs, pending, pendingMood, busy, onSend, onInterrupt, config, onConfig,
  inboxNew, onCheckInbox, onEmail, theme, mode, onTyping, onReplay,
}) {
  const [input, setInput] = useState('');
  const [images, setImages] = useState([]);
  const bottomRef = useRef(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs, pending]);

  function attachFile(file) {
    // A dropped PDF is a paper: hand it straight to the intake pipeline, which
    // identifies, files, classifies and indexes it. Images stay attachments.
    if (file?.type === 'application/pdf' || /\.pdf$/i.test(file?.name ?? '')) return uploadPaper(file);
    if (!file?.type?.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      const [, data] = reader.result.split(',');
      setImages((imgs) => [...imgs, { media_type: file.type, data }]);
    };
    reader.readAsDataURL(file);
  }

  function send() {
    if (!input.trim() && images.length === 0) return;
    onSend(input, images);
    setInput('');
    setImages([]);
  }

  return (
    <div className={`tab-fill chat-tab ${mode === 'EXAM' ? 'exam' : ''}`}>
      <div className="chat-scroll">
        {msgs.map((m, i) => {
          // Tool calls read as Monday narrating itself, not as a machine log line.
          if (m.role === 'tool') {
            return (
              <div key={i} className="tool-chip"><span className="tc-mark">▸</span><span>{m.text}</span></div>
            );
          }
          // A proactive nudge is Monday starting the conversation — it must not
          // look like an answer to something the student asked.
          if (m.role === 'proactive') {
            const pc = moodColor(m.mood ?? 'focused', theme);
            return (
              <div key={i} className="turn proactive" style={{ color: pc }}>
                <div className="turn-tag">
                  <span className="tag-name" style={{ background: pc, color: moodInk(m.mood ?? 'focused', theme) }}>MONDAY</span>
                  <span className="tag-note">unprompted · {String(m.trigger ?? '').replace(/_/g, ' ')}</span>
                </div>
                <div className="turn-body"><Md text={m.text} /></div>
              </div>
            );
          }
          const isAssistant = m.role === 'assistant';
          const tint = isAssistant ? moodColor(m.mood ?? 'focused', theme) : null;
          return (
            // The gutter rule inherits `color`, so the turn carries its mood as
            // currentColor and nothing tints the message block itself.
            <div key={i} className={`turn ${m.role}`} style={isAssistant ? { color: tint } : undefined}>
              <div className="turn-tag">
                {isAssistant ? (
                  <>
                    <span className="tag-name" style={{ background: tint, color: moodInk(m.mood ?? 'focused', theme) }}>MONDAY</span>
                    {m.mood && <span className="tag-note">{m.mood}</span>}
                    {m.text?.trim() && (
                      <button className="tag-play" title="hear that again" onClick={() => onReplay(m.utts, m.text, m.mood)}>▶</button>
                    )}
                  </>
                ) : (
                  <span className="tag-name">You</span>
                )}
              </div>
              <div className="turn-body">
                {m.imageCount > 0 && <div className="img-note">[IMG ×{m.imageCount}]</div>}
                <Md text={m.text} />
              </div>
            </div>
          );
        })}
        {pending && (
          <div className="turn assistant streaming" style={{ color: moodColor(pendingMood ?? 'focused', theme) }}>
            <div className="turn-tag">
              <span className="tag-name" style={{ background: moodColor(pendingMood ?? 'focused', theme), color: moodInk(pendingMood ?? 'focused', theme) }}>MONDAY</span>
              <span className="tag-note">thinking</span>
            </div>
            <div className="turn-body"><Md text={pending} /></div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      {images.length > 0 && (
        <div className="paste-strip">
          {images.map((img, i) => (
            <span key={i} className="paste-thumb">
              <img src={`data:${img.media_type};base64,${img.data}`} alt="" />
              <button onClick={() => setImages(images.filter((_, j) => j !== i))}>×</button>
            </span>
          ))}
        </div>
      )}
      <div className="quick-row">
        {QUICK.map((q) => (
          <button key={q.label} className="btn tiny" disabled={busy && !q.prefill} onClick={() => (q.prefill ? setInput(q.text) : onSend(q.text, []))}>{q.label}</button>
        ))}
        <button className="btn tiny" disabled={busy} onClick={onCheckInbox}>
          Inbox{inboxNew > 0 ? ` · ${inboxNew}` : ''}
        </button>
        <button className="btn tiny" onClick={onEmail} title="draft an email from the latest session report">Email</button>
        {busy && <button className="btn tiny stop" onClick={onInterrupt}>Stop</button>}
        <span className="quick-spacer" />
        <select className="sel" value={config.model} title="model" onChange={(e) => onConfig({ model: e.target.value })}>
          {MODELS.map(([m]) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select className="sel" value={config.effort} title="reasoning effort" onChange={(e) => onConfig({ effort: e.target.value })}>
          {EFFORTS.map(([m]) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
      <div className="chat-input">
        <textarea
          value={input}
          placeholder={mode === 'EXAM' ? 'Exam conditions — answers only, no hints.' : 'Ask Monday… paste or drop screenshots'}
          onChange={(e) => { setInput(e.target.value); onTyping?.(); }}
          onPaste={(e) => { for (const it of e.clipboardData.items) if (it.type.startsWith('image/')) { e.preventDefault(); attachFile(it.getAsFile()); } }}
          onDrop={(e) => { e.preventDefault(); for (const f of e.dataTransfer.files) attachFile(f); }}
          onDragOver={(e) => e.preventDefault()}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
        />
        <button className="btn" onClick={send}>Send</button>
      </div>
    </div>
  );
}

// ═══════════════ file (md/json/txt) tab — editable ═══════════════
function FileTab({ path, refreshKey }) {
  const [text, setText] = useState('');
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (editing && dirty) return; // don't clobber edits
    fetch(`/api/file?path=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then((d) => { setText(d.text ?? d.error ?? ''); if (!dirty) setDraft(d.text ?? ''); });
  }, [path, refreshKey, editing]); // eslint-disable-line

  async function save() {
    await fetch('/api/save', { method: 'POST', body: JSON.stringify({ path, text: draft }) });
    setText(draft);
    setDirty(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  const isJson = path.endsWith('.json');
  return (
    <div className="tab-fill file-tab">
      <div className="file-toolbar">
        <button className={`btn tiny ${!editing ? 'on' : ''}`} onClick={() => setEditing(false)}>View</button>
        <button className={`btn tiny ${editing ? 'on' : ''}`} onClick={() => { setDraft(text); setEditing(true); }}>Edit</button>
        {editing && <button className="btn tiny save" disabled={!dirty} onClick={save}>{saved ? 'Saved ✓' : 'Save'}</button>}
        {dirty && <span className="dirty">●</span>}
      </div>
      {editing ? (
        <textarea
          className="editor"
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setDirty(true); }}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); } }}
          spellCheck={false}
        />
      ) : (
        <div className="ws-body">{isJson ? <pre>{text}</pre> : <Md text={text} />}</div>
      )}
    </div>
  );
}

// ═══════════════ pdf tab — pdf.js canvas + annotation overlay ═══════════════
// The rendering guts live in monday/PdfAnnotator.jsx; this wrapper keeps the
// props/onProps contract (zoom/page/tool survive tab drags) and the empty state.
function PdfTab({ props, onProps, annBump }) {
  const pdf = props ?? {};
  if (!pdf.path) return <div className="tab-fill pdf-empty">MONDAY PUTS QUESTIONS HERE.<br />OR PICK A PDF IN FILES.</div>;
  return <PdfAnnotator pdf={pdf} onProps={onProps} annBump={annBump} />;
}

// ═══════════════ floating timer ═══════════════
// Tiny draggable widget: park it anywhere (position persists), click to set a
// timer in two taps. Also displays timers Claude starts via start_timer.
// Total active time on the app for the calendar day — NOT the countdown timer.
// Accumulates real elapsed ms while the app is "active" (focused, or Monday is
// speaking, or EXAM), persisted per day so a reload or a new chat continues the
// same running total, and it naturally resets at midnight because the storage key
// is the date. This is "how long did I actually work today", pause/play automatic.
const dayKey = () => `monday-daily-${new Date().toLocaleDateString('en-CA')}`; // YYYY-MM-DD local
const IDLE_MS = 6 * 60 * 1000;
const SITTING_GAP_MS = 25 * 60 * 1000; // same rule as the server: 25 idle minutes ends a sitting // focused but untouched this long and you have wandered off

function DailyTime({ mode, timer }) {
  const [ms, setMs] = useState(() => { try { return Number(localStorage.getItem(dayKey())) || 0; } catch { return 0; } });
  const [live, setLive] = useState(true);
  const msRef = useRef(ms);
  const lastRef = useRef(null); // timestamp of the last counted tick, or null when paused
  const keyRef = useRef(dayKey());
  const idleRef = useRef(Date.now()); // last real interaction with the window
  // Read through refs so the ticking effect is never torn down and rebuilt — a remount
  // drops the current tick and loses up to a second every time a timer or mode changes.
  const modeRef = useRef(mode);
  const timerRef = useRef(timer);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { timerRef.current = timer; }, [timer]);

  // Any of these means you are still here. Kept cheap: they only stamp a timestamp.
  useEffect(() => {
    const touch = () => { idleRef.current = Date.now(); };
    const evs = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'];
    evs.forEach((e) => window.addEventListener(e, touch, { passive: true, capture: true }));
    return () => evs.forEach((e) => window.removeEventListener(e, touch, { capture: true }));
  }, []);

  useEffect(() => {
    // "Work is being done" is wider than "this window has focus". A running countdown
    // counts wherever you are — annotating the PDF in Preview is still the session —
    // and so does EXAM and Monday talking. Otherwise you must be looking at the window
    // AND have touched it recently, so a focused window left open overnight adds nothing.
    const active = () => {
      const t = timerRef.current;
      if (t && t.endsAt > Date.now()) return true;
      if (audio.speaking || modeRef.current === 'EXAM') return true;
      return document.hasFocus() && !document.hidden && Date.now() - idleRef.current < IDLE_MS;
    };
    const flush = () => { try { localStorage.setItem(keyRef.current, String(Math.round(msRef.current))); } catch {} };

    const iv = setInterval(() => {
      // Roll over at midnight without a reload: new key, counter restarts at 0.
      const k = dayKey();
      if (k !== keyRef.current) { flush(); keyRef.current = k; msRef.current = 0; setMs(0); lastRef.current = null; }

      const now = Date.now();
      const on = active();
      setLive(on);
      if (on) {
        if (lastRef.current != null) {
          // Real elapsed, not a fixed +1s — survives background throttling. Skip
          // absurd gaps (sleep/wake) so a shut lid does not count as study time.
          const d = now - lastRef.current;
          if (d > 0 && d < 5000) { msRef.current += d; setMs(msRef.current); }
        }
        lastRef.current = now;
      } else {
        lastRef.current = null; // paused
      }
    }, 1000);

    const onHide = () => { if (document.hidden) flush(); };
    window.addEventListener('blur', flush);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onHide);
    return () => { clearInterval(iv); flush(); window.removeEventListener('blur', flush); window.removeEventListener('pagehide', flush); window.removeEventListener('beforeunload', flush); document.removeEventListener('visibilitychange', onHide); };
  }, []);

  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60);
  const label = h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
  return (
    <span
      className={`daily-time${live ? '' : ' paused'}`}
      title={`Active time on the app today — resets at midnight.\nCounts while you are working in the window, while a timer runs (even in another app), in EXAM, and while Monday talks.${live ? '' : '\nPaused: no timer running and the window has been idle.'}`}
    >
      {live ? '◷' : '⏸'} {label}
    </span>
  );
}

// ── duration input ──────────────────────────────────────────────────────────
// "3" → 3:00, "3:45" → 3m 45s, "1:45:00" → 1h 45m. A bare number is minutes
// because that is what gets typed nine times out of ten; a colon means you are
// being precise, and the last field is always seconds. Two colons means hours.
function parseDuration(raw) {
  const parts = String(raw ?? '').trim().split(':').map((p) => p.trim());
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  const n = parts.map(Number);
  const secs = parts.length === 1 ? n[0] * 60
    : parts.length === 2 ? n[0] * 60 + n[1]
    : n[0] * 3600 + n[1] * 60 + n[2];
  return secs > 0 ? Math.round(secs) : null;
}
// h:mm:ss past an hour, m:ss below it — so a 75-minute paper reads 1:15:00.
function fmtClock(sec) {
  const t = Math.max(0, Math.round(sec));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return `${h ? `${h}:` : ''}${h ? String(m).padStart(2, '0') : m}:${String(s).padStart(2, '0')}`;
}
const fmtPreset = (sec) => (sec % 60 === 0 ? `${sec / 60}m` : fmtClock(sec));

const FT_PRESETS = [60, 120, 180, 225, 300, 600, 1800]; // 3:45 is a TMUA question's budget
const FT_SIZES = [12, 14, 16, 19, 23]; // base px the whole widget scales from
const FT_WIDTH = 210;                  // assumed width before the first measure
const FT_KEEP = 44;                    // px of the widget that must stay on screen

function FloatTimer({ timer, setTimer, mode }) {
  const boxRef = useRef(null);
  const [pos, setPos] = useState(() => {
    try {
      const p = JSON.parse(localStorage.getItem('tmua-float-timer'));
      // A position stored from a wider window puts the widget past the edge — that is
      // the "my timer vanished after the window changed shape" bug. Drop it and re-home.
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0
        && p.x < window.innerWidth - FT_KEEP && p.y < window.innerHeight - 30) return p;
    } catch {}
    return { x: Math.max(8, window.innerWidth - FT_WIDTH - 16), y: 96 };
  });
  const [size, setSize] = useState(() => {
    const n = Number(localStorage.getItem('tmua-float-timer-size'));
    return Number.isInteger(n) && n >= 0 && n < FT_SIZES.length ? n : 2;
  });
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const [popping, setPopping] = useState(false);
  const [, tick] = useState(0);
  const moved = useRef(false);
  // The timer holds a wall-clock deadline, so it used to keep counting while the app
  // sat in the background — you would come back from another window to find minutes
  // gone that you never spent on the question. It now only advances while this window
  // has focus: blurring freezes the clock, focusing pushes the deadline forward by
  // exactly the time away, so the remaining time is untouched.
  const pausedAtRef = useRef(null);
  const [focused, setFocused] = useState(() => typeof document === 'undefined' || (document.hasFocus() && !document.hidden));
  const [speaking, setSpeaking] = useState(false);

  const savePos = (p) => { try { localStorage.setItem('tmua-float-timer', JSON.stringify(p)); } catch {} return p; };
  // Never let a drag or a window resize push the widget where it cannot be grabbed.
  // Only the top FT_KEEP px is guaranteed visible, so an open panel may hang off the
  // bottom rather than yanking the whole thing upwards while you are reading it.
  const clampPos = useCallback((p) => ({
    x: Math.min(Math.max(8, p.x), Math.max(8, window.innerWidth - (boxRef.current?.offsetWidth || FT_WIDTH) - 8)),
    y: Math.min(Math.max(8, p.y), Math.max(8, window.innerHeight - FT_KEEP)),
  }), []);

  // Put it back in the top right and flash it. Bound to ⌥T as well as the ⌖ button,
  // because the one time you need this is when the widget is nowhere to be clicked.
  const respawn = useCallback(() => {
    const w = boxRef.current?.offsetWidth || FT_WIDTH;
    setPos(savePos({ x: Math.max(8, window.innerWidth - w - 16), y: 96 }));
    setPopping(true);
    setTimeout(() => setPopping(false), 700);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      // e.code, not e.key: macOS turns Option+T into "†".
      if (e.code === 'KeyT' && e.altKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); respawn(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [respawn]);

  // Reflow on any viewport change — resize, orientation flip, entering full screen.
  useEffect(() => {
    const onResize = () => setPos((p) => savePos(clampPos(p)));
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => { window.removeEventListener('resize', onResize); window.removeEventListener('orientationchange', onResize); };
  }, [clampPos]);

  useEffect(() => {
    if (!timer) return;
    const iv = setInterval(() => tick((t) => t + 1), 500);
    return () => clearInterval(iv);
  }, [timer]);

  // Focus and speech are tracked separately, then combined into one rule below.
  useEffect(() => {
    const sync = () => setFocused(document.hasFocus() && !document.hidden);
    window.addEventListener('blur', sync);
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', sync);
    sync();
    return () => {
      window.removeEventListener('blur', sync);
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);

  useEffect(() => {
    setSpeaking(audio.speaking);
    return audio.onChange((a) => setSpeaking(a.speaking));
  }, []);

  // One rule, so every transition is handled the same way regardless of which input
  // changed. The timer runs while you are looking at it, while Monday is talking —
  // clicking away mid-sentence still counts as attention, and it keeps running until
  // the voice stops — and always in EXAM, because a real exam does not pause when you
  // look away. Anything else and the clock is held.
  const shouldRun = focused || speaking || mode === 'EXAM';

  useEffect(() => {
    if (shouldRun) {
      const since = pausedAtRef.current;
      pausedAtRef.current = null;
      if (since === null) return;
      const owed = Date.now() - since;
      // Credit only the time actually held, so remaining time is never lost or gained.
      if (owed > 0) setTimer((t) => (t ? { ...t, endsAt: t.endsAt + owed } : t));
    } else if (pausedAtRef.current === null) {
      pausedAtRef.current = Date.now();
    }
  }, [shouldRun, setTimer]);

  function onPointerDown(e) {
    // Everything is a drag handle except the controls themselves — grab the face, the
    // panel's background, the gaps between buttons.
    if (e.target.closest('button, input')) return;
    e.preventDefault();
    moved.current = false;
    const sx = e.clientX - pos.x;
    const sy = e.clientY - pos.y;
    const ox = e.clientX, oy = e.clientY;
    function mv(ev) {
      // 3px of slop, so a shaky click still opens the panel instead of counting as a drag.
      if (Math.abs(ev.clientX - ox) > 3 || Math.abs(ev.clientY - oy) > 3) moved.current = true;
      setPos(clampPos({ x: ev.clientX - sx, y: ev.clientY - sy }));
    }
    function up() {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      setPos(savePos);
    }
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  }

  const resize = (d) => setSize((s) => {
    const n = Math.min(FT_SIZES.length - 1, Math.max(0, s + d));
    try { localStorage.setItem('tmua-float-timer-size', String(n)); } catch {}
    return n;
  });

  // `total` drives the progress bar; timers Claude starts carry it too.
  const start = (sec) => {
    if (!sec || sec <= 0) return;
    setTimer({ label: '', endsAt: Date.now() + sec * 1000, total: sec });
    setOpen(false);
    setCustom('');
  };

  // While away, read the clock from the moment of blur so the display is frozen too —
  // the deadline itself is only corrected once focus returns.
  const nowMs = pausedAtRef.current ?? Date.now();
  const left = timer ? Math.ceil((timer.endsAt - nowMs) / 1000) : null;
  const up = left !== null && left <= 0;
  const pending = custom.trim() ? parseDuration(custom) : null;
  const bad = custom.trim() !== '' && pending === null;
  const frac = timer?.total && left !== null ? Math.max(0, Math.min(1, left / timer.total)) : null;

  return (
    <div
      ref={boxRef}
      className={`float-timer${popping ? ' pop' : ''}`}
      style={{ left: pos.x, top: pos.y, fontSize: `${FT_SIZES[size]}px` }}
      onPointerDown={onPointerDown}
    >
      <div
        className={`ft-face ${up ? 'up' : left !== null && left <= 30 ? 'low' : ''}`}
        onClick={() => { if (!moved.current) setOpen((o) => !o); }}
        title="drag to move · click for controls · ⌥T brings it back"
      >
        <span className="ft-glyph">{left === null ? '⏱' : shouldRun ? '⏱' : '⏸'}</span>
        {timer?.label && <span className="ft-label">{timer.label}</span>}
        <span className="ft-time">{left === null ? '—:—' : up ? 'TIME UP' : fmtClock(left)}</span>
        {frac !== null && !up && <span className="ft-bar" style={{ transform: `scaleX(${frac})` }} />}
      </div>
      {open && (
        <div className="ft-panel">
          <div className="ft-head">
            <span className="ft-title">TIMER</span>
            <button className="ft-btn ghost" title="smaller" disabled={size === 0} onClick={() => resize(-1)}>−</button>
            <button className="ft-btn ghost" title="bigger" disabled={size === FT_SIZES.length - 1} onClick={() => resize(1)}>+</button>
            <button className="ft-btn ghost" title="back to the top right (⌥T)" onClick={respawn}>⌖</button>
          </div>
          <div className="ft-grid">
            {FT_PRESETS.map((s) => (
              <button key={s} className="ft-btn" onClick={() => start(s)}>{fmtPreset(s)}</button>
            ))}
          </div>
          <div className="ft-row">
            <input
              className={`ft-input${bad ? ' bad' : ''}`}
              value={custom}
              placeholder="3:45"
              inputMode="text"
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') start(parseDuration(custom)); }}
            />
            <button className="ft-btn go" disabled={pending === null} onClick={() => start(pending)}>GO</button>
            {timer && <button className="ft-btn stop" onClick={() => { setTimer(null); setOpen(false); }}>CLEAR</button>}
          </div>
          <div className="ft-hint">{pending !== null ? `→ ${fmtClock(pending)}` : '3 → 3:00 · 3:45 → 3m45s · 1:45:00 → 1h45m'}</div>
        </div>
      )}
    </div>
  );
}

// ═══════════════ layout ═══════════════
// The exam opens full screen in its own Chrome window (server/examwindow.js); a plain tab
// only when that is not possible.
const openExam = (path = '/exam') => fetch('/api/exam/open', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }),
}).then((r) => r.json()).then((r) => { if (!r.ok) throw new Error(r.error); })
  .catch(() => window.open(path, '_blank'));

const TITLES = { files: 'Files', chat: 'MONDAY', pdf: 'PDF', schedule: 'Schedule', backlog: 'Backlog', readiness: 'Readiness', settings: 'Settings', grades: 'Grades', video: 'Video', inbox: 'Inbox', paperflow: '🎬 JZ flow', target85: '8.5+' };

// ═══════════════ backlog tab — spaced revision, +1 / +7 / +21 days ═══════════════
const BUCKET_LABEL = { didnt_know: "didn't know", slipped: 'slipped', timing: 'timing' };

// Per-question notes, autosaved. Student writes freely; Monday's note (written via its
// own tool) shows read-only above. One live note per side, so the two can read each other.
function NoteEditor({ item }) {
  const asStr = (v) => (typeof v === 'string' ? v : '');
  const [val, setVal] = useState(asStr(item.notes?.student));
  const [saved, setSaved] = useState(true);
  const timer = useRef();
  const mondayNote = asStr(item.notes?.monday);
  useEffect(() => () => clearTimeout(timer.current), []);
  const save = (text) => fetch('/api/backlog/note', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: item.id, author: 'student', text }),
  }).then(() => setSaved(true)).catch(() => {});
  const onChange = (e) => {
    const text = e.target.value;
    setVal(text); setSaved(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => save(text), 700);
  };
  const onBlur = () => { clearTimeout(timer.current); if (!saved) save(val); }; // flush the moment you leave
  // Markdown, rendered when you are not typing in it. Notes are where the actual
  // learning gets written down, and a wall of unformatted text is not re-readable three
  // weeks later — which is exactly when a tier-21 question comes back.
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState(() => {
    const n = Number(localStorage.getItem('bk-note-rows'));
    return Number.isFinite(n) && n >= 2 ? n : 4;
  });
  const grow = (n) => { setRows(n); try { localStorage.setItem('bk-note-rows', String(n)); } catch { /* private mode */ } };

  return (
    <div className="bk-notes">
      {mondayNote && <div className="bk-note-monday">🤖 <Md text={mondayNote} /></div>}
      {editing || !val.trim() ? (
        <textarea className="bk-note-input" value={val} rows={rows} autoFocus={editing}
          placeholder="Notes on this question — markdown and $maths$ both render. Autosaves…"
          /* onFocus matters: an empty note shows the textarea without `editing` being set,
             so without this the first keystroke makes the note non-empty, the branch flips
             to the rendered preview, and the textarea unmounts mid-word. */
          onFocus={() => setEditing(true)}
          onChange={onChange} onBlur={() => { onBlur(); setEditing(false); }} />
      ) : (
        <div className="bk-note-md" onClick={() => setEditing(true)} title="click to edit">
          <Md text={val} />
        </div>
      )}
      <span className="bk-note-status">
        {saved ? 'saved ✓' : 'saving…'}
        <button className="btn tiny" onClick={() => grow(Math.max(2, rows - 2))} title="smaller">−</button>
        <button className="btn tiny" onClick={() => grow(Math.min(24, rows + 2))} title="taller">+</button>
      </span>
    </div>
  );
}

// The full insight the tag index holds for a question — technique, traps, difficulty,
// worked-description and cross-linked questions. Pulled straight from the classified
// indexes, so every official paper carries its max context right in the backlog.
function Insight({ ins }) {
  if (!ins) return null;
  return (
    <div className="bk-insight">
      {ins.description && <div className="bk-desc">{ins.description}</div>}
      <div className="bk-chips">
        {ins.difficulty != null && <span className="bk-chip diff">difficulty {ins.difficulty}/5</span>}
        {ins.technique?.map((t) => <span key={t} className="bk-chip tech">{t.replace(/_/g, ' ')}</span>)}
        {ins.trap?.map((t) => <span key={t} className="bk-chip trap">⚠ {t.replace(/_/g, ' ')}</span>)}
      </div>
      {ins.cross_links?.length > 0 && (
        <div className="bk-xlinks">similar: {ins.cross_links.join(' · ')}</div>
      )}
    </div>
  );
}

// Analytics that ACT: weak topics turned into a next move — the exact index questions
// to drill (click opens the paper) and the R2Drew segment that teaches it (click plays).
function RecommendPanel({ onOpenPaper, onOpenVideo }) {
  const [rec, setRec] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { fetch('/api/recommendations').then((r) => r.json()).then(setRec).catch(() => {}); }, []);
  const items = rec?.recommendations ?? [];
  if (!items.length) return null;
  return (
    <div className="rec-panel">
      <button className="rec-head" onClick={() => setOpen((v) => !v)}>
        🎯 Drill weak topics ({items.length}) {open ? '▾' : '▸'}
      </button>
      {open && (
        <div className="rec-body">
          {items.map((t) => (
            <div key={t.topic} className="rec-topic">
              <div className="rec-topic-head">
                <b>{t.topic.replace(/_/g, ' ')}</b>
                <span className="rec-acc">{t.accuracy}% ({t.correct}/{t.attempted})</span>
              </div>
              <div className="rec-drills">
                {t.drill.map((d) => (
                  <button key={d.id} className="rec-chip" disabled={!d.paper_path}
                    title={d.description || d.id} onClick={() => d.paper_path && onOpenPaper?.(d.paper_path, 1)}>
                    {d.id}{d.difficulty ? ` · d${d.difficulty}` : ''}
                  </button>
                ))}
              </div>
              {t.videos.length > 0 && (
                <div className="rec-vids">
                  {t.videos.map((v) => (
                    <button key={v.id} className="rec-vid" title={v.label || v.title}
                      onClick={() => onOpenVideo?.(v.id, v.start, v.title)}>▶ {v.title}</button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Inbox: one glance at what got dropped and is still pending vs what's already in the
// index — so PDFs never silently pile up. Dropping a file just opens it; it becomes a
// paper only when you tell Monday, and until then it sits here.
function InboxTab() {
  const [d, setD] = useState(null);
  useEffect(() => { fetch('/api/inbox').then((r) => r.json()).then(setD).catch(() => setD({ pending: [], coverage: {} })); }, []);
  return (
    <div className="tab-fill inbox-tab">
      <div className="bk-bar"><span className="bk-title">Inbox</span>
        <span className="quick-spacer" />
        {d && <span className="bk-count">{d.pending.length} pending</span>}</div>
      <div className="bk-body">
        {!d && <div className="bk-empty">Loading…</div>}
        {d && d.pending.length === 0 && (
          <div className="bk-empty">Nothing waiting. A dropped PDF opens straight away and waits here until you tell Monday it&rsquo;s a paper — nothing is filed or classified behind your back.</div>
        )}
        {d?.pending.map((p) => (
          <div key={p.name} className="bk-item">
            <div className="bk-head"><span className="bk-ref">{p.name}</span><span className="quick-spacer" /><span className="bk-due">dropped {p.dropped}</span></div>
            <div className="bk-detail">{p.summary}</div>
          </div>
        ))}
      </div>
      {d?.coverage && (
        <div className="bk-foot">Indexed and classified: {d.coverage.official ?? 0} official + {d.coverage.mock ?? 0} mock questions. Drop a PDF anywhere on the app to add it here.</div>
      )}
    </div>
  );
}

// Health strip: three dots the eye can read at a glance — is the live connection up,
// is the voice engine loaded, is the published dashboard fresh. Kills the recurring
// "is it broken or is it me" by making each subsystem's state visible.
function HealthStrip({ connection }) {
  const [h, setH] = useState(null);
  const poll = useCallback(() => fetch('/api/health').then((r) => r.json()).then(setH).catch(() => setH(null)), []);
  useEffect(() => {
    let live = true;
    const tick = () => { if (live) poll(); };
    tick();
    // Poll faster while the voice engine is mid-recovery, so the retry countdown is live.
    const t = setInterval(tick, 20000);
    return () => { live = false; clearInterval(t); };
  }, [poll]);
  const conn = connection === 'connected' ? 'ok' : connection === 'connecting' ? 'warn' : 'bad';
  const v = h?.voice;
  const voice = !h ? 'warn' : v?.ready ? 'ok' : v?.status === 'degraded' ? 'bad' : 'warn';
  // Degraded self-heals; the label shows the countdown so it's clearly recovering, not dead.
  const voiceLabel = v?.status === 'degraded' && v?.retryInSeconds != null ? `voice ⟳${v.retryInSeconds}s` : 'voice';
  const voiceTitle = !v ? 'Voice engine: …'
    : `Voice engine: ${v.status}${v.device ? ` (${v.device})` : ''}${v.reason ? ` — ${v.reason}` : ''}`
      + (v.status !== 'ready' ? '  ·  click to restart' : '');
  const dash = !h ? 'warn' : h.dashboard?.fresh ? 'ok' : 'warn';
  const restart = () => fetch('/api/voice/restart', { method: 'POST' }).then(() => setTimeout(poll, 500)).catch(() => {});
  const Dot = ({ tone, label, title, onClick }) => (
    <span className={`hs-dot ${tone}${onClick ? ' click' : ''}`} title={title} onClick={onClick}>{label}</span>
  );
  return (
    <span className="health-strip">
      <Dot tone={conn} label="live" title={`Connection: ${connection}`} />
      <Dot tone={voice} label={voiceLabel} title={voiceTitle} onClick={v && v.status !== 'ready' ? restart : undefined} />
      <Dot tone={dash} label="board" title={`Dashboard data: ${h?.dashboard?.generated ?? '?'}${h?.dashboard?.ageMin != null ? ` · ${h.dashboard.ageMin}m old` : ''}`} />
    </span>
  );
}

// Driven "Do backlog" workout: walks the queue one question at a time, per-question
// timer running, your old note/fix hidden until you've had a go (rework cold), then
// pass/fail auto-schedules the next tier. Turns the list into reps.
function DoBacklogSession({ queue, onDone, onOpenPaper, mode }) {
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  // A stopwatch from zero says how long you took. A countdown from the question's own
  // budget says whether you are going to finish the paper, which is the only thing the
  // exam asks. Past zero it keeps running upward instead of stopping — the overrun is
  // the number worth feeling, and hiding it behind "TIME UP" throws it away.
  const [endsAt, setEndsAt] = useState(null);
  const [, tick] = useState(0);
  // Same pause rule as FloatTimer, for the same reason and then some: this clock is
  // WRITTEN TO THE RECORD. A doorbell mid-question would otherwise inflate the elapsed
  // seconds and mark a question he actually knew as slow, permanently and silently.
  const pausedAtRef = useRef(null);
  const it = queue[idx];
  const budget = Number(it?.budget) > 0 ? Number(it.budget) : 225;

  const shouldRun = useAttention(mode);

  useEffect(() => {
    setRevealed(false);
    setEndsAt(Date.now() + budget * 1000);
    // Re-stamp the pause clock with the new question. Carrying a blur from the previous
    // question across would credit that whole gap to this one the moment focus returns.
    pausedAtRef.current = shouldRun ? null : Date.now();
    // shouldRun is read once, at the question change; the effect below owns it after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, budget]);

  useEffect(() => {
    const iv = setInterval(() => tick((t) => t + 1), 500);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    if (shouldRun) {
      const since = pausedAtRef.current;
      pausedAtRef.current = null;
      if (since === null) return;
      const owed = Date.now() - since;
      // Credit exactly the time held, so elapsed counts attention and nothing else.
      if (owed > 0) setEndsAt((e) => (e === null ? e : e + owed));
    } else if (pausedAtRef.current === null) {
      pausedAtRef.current = Date.now();
    }
  }, [shouldRun]);

  if (!it) return null;
  // Frozen display while away, matching the frozen deadline.
  const nowMs = pausedAtRef.current ?? Date.now();
  const left = endsAt === null ? budget : Math.ceil((endsAt - nowMs) / 1000);
  const over = left <= 0;
  const elapsedOf = (l) => Math.max(0, budget - l);
  const advance = async (result) => {
    const secs = elapsedOf(endsAt === null ? budget : Math.ceil((endsAt - (pausedAtRef.current ?? Date.now())) / 1000));
    // One request, one history entry: elapsed and verdict have to be joined or the
    // seconds belong to no particular attempt. Skip has no verdict to join to, so it
    // still goes to /time, which only ever touches the lifetime roll-up.
    if (result) {
      await fetch('/api/backlog/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: it.id, result, seconds: secs || null }) }).catch(() => {});
    } else if (secs > 0) {
      await fetch('/api/backlog/time', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: it.id, seconds: secs }) }).catch(() => {});
    }
    if (idx + 1 < queue.length) setIdx(idx + 1); else onDone(true);
  };
  return (
    <div className="bk-session">
      <div className="bk-sess-top">
        <span className="bk-sess-prog">{idx + 1} / {queue.length}</span>
        <span className={`bk-sess-timer ${over ? 'up' : left <= 30 ? 'low' : ''}`}>
          {shouldRun ? '⏱' : '⏸'} {over ? `+${fmtClock(-left)}` : fmtClock(left)}
        </span>
        <span className="bk-sess-budget">of {fmtClock(budget)}</span>
        <span className="quick-spacer" />
        <button className="btn tiny" onClick={() => advance(null)}>Skip →</button>
        <button className="btn tiny stop" onClick={() => onDone(false)}>End</button>
      </div>
      <div className="bk-sess-card">
        <div className="bk-sess-ref"><span className={`bk-exam x-${it.exam.toLowerCase()}`}>{it.exam}</span> <b>{it.ref}</b></div>
        <div className="bk-sess-topic">{String(it.topic).replace(/_/g, ' ')} · {BUCKET_LABEL[it.bucket] ?? it.bucket}</div>
        {it.paper_path
          ? <>
              <button className="btn" {...studyClick(it, it.paper_path, 'qp', onOpenPaper)}>📄 Open paper</button>
              {it.ms_path && revealed && <button className="btn" {...studyClick(it, it.ms_path, 'ms', onOpenPaper)}>🔑 Mark scheme</button>}
            </>
          : <span className="bk-sess-nopdf">no linked PDF (mock — open manually)</span>}
        {!revealed
          ? <button className="btn tiny reveal" onClick={() => setRevealed(true)}>Rework it cold, then reveal your past note ▾</button>
          : (
            <>
              {it.detail && <div className="bk-detail">{it.detail}</div>}
              {it.correction && <div className="bk-fix">→ {it.correction}</div>}
              <Insight ins={it.insight} />
              <NoteEditor item={it} />
            </>
          )}
      </div>
      <div className="bk-sess-acts">
        <button className="btn save" onClick={() => advance('pass')}>✓ Reworked cold</button>
        <button className="btn stop" onClick={() => advance('fail')}>✗ Still stuck</button>
      </div>
    </div>
  );
}

// Open a paper AT the question rather than at page 1. The server works the page out per
// click — scanning a PDF's text costs a tenth of a second and most rows are never opened
// — and a paper it cannot place simply opens where it always did.
async function openAt(item, path, kind, onOpenPaper, opts = {}) {
  let page = 1;
  try {
    const q = new URLSearchParams({ path, ref: item.ref ?? '', exam: item.exam ?? '', kind });
    const d = await (await fetch(`/api/question-page?${q}`)).json();
    if (Number.isFinite(Number(d?.page)) && Number(d.page) > 0) page = Number(d.page);
  } catch { /* the paper still opens, just at the top */ }
  onOpenPaper?.(path, page, kind === 'ms' ? 'ms' : 'q', opts);
}

// Left click: the usual single reused study tab. Middle click: a NEW tab beside it, so
// you can keep one paper open while looking at another. mousedown is cancelled so the
// browser's autoscroll cursor doesn't appear.
const studyClick = (item, path, kind, onOpenPaper) => ({
  onClick: () => openAt(item, path, kind, onOpenPaper),
  onMouseDown: (e) => { if (e.button === 1) e.preventDefault(); },
  onAuxClick: (e) => { if (e.button === 1) { e.preventDefault(); openAt(item, path, kind, onOpenPaper, { newTab: true }); } },
});

/**
 * The "N due" badge in the header, and what is behind it.
 *
 * It used to be a shortcut that dumped you in the backlog pane on whatever filter it was
 * last left on, so the number told you nothing about what the work actually was. Clicking
 * now breaks the number down — by exam first, because "21 TMUA" and "15 MAT" are different
 * evenings, then by topic — and each row opens the pane already filtered to it.
 *
 * The breakdown is fetched when the popover opens rather than held in state: it is one
 * small request, and a stale count in a menu you are about to act on is worse than a
 * spinner.
 */
/**
 * One filter menu. A native select on purpose: it is keyboard-navigable, it works on a
 * phone, and it needs no popup of its own to maintain — the row of toggle buttons it
 * replaces had grown to eighteen and wrapped onto three lines.
 */
function Picker({ label, value, onChange, options, title }) {
  const active = options.find((o) => o.value === value);
  const isDefault = options[0]?.value === value;
  return (
    <label className={`bk-pick${isDefault ? '' : ' on'}`} title={title ?? label}>
      <span className="bk-pick-label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}{o.count != null ? `  (${o.count})` : ''}
          </option>
        ))}
      </select>
      {active?.hint ? <span className="bk-pick-hint">{active.hint}</span> : null}
    </label>
  );
}

function BacklogBadge({ count, onPick }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setErr(false);
    fetch('/api/backlog?due=1')
      .then((r) => r.json())
      .then((d) => { if (live) setData(d); })
      .catch(() => { if (live) setErr(true); });
    return () => { live = false; };
  }, [open]);

  // Close on outside click and on Escape, the way every other transient pane here behaves.
  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (!e.target.closest?.('.bk-badge-wrap')) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const byExam = Object.entries(data?.summary?.byExam ?? {})
    .map(([exam, v]) => ({ exam, due: v.due ?? 0, open: v.open ?? 0 }))
    .filter((r) => r.due > 0)
    .sort((a, b) => b.due - a.due);

  const byTopic = Object.entries(
    (data?.items ?? []).reduce((acc, i) => {
      const k = i.topic || 'unlabelled';
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {}),
  ).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const overdue = data?.summary?.overdue ?? 0;
  const go = (f) => { setOpen(false); onPick({ ...f, at: Date.now() }); };

  return (
    <span className="bk-badge-wrap">
      <button className={`btn tiny bk-badge${open ? ' on' : ''}`} aria-expanded={open}
        title={`${count} revision item(s) due — click for the breakdown`}
        onClick={() => setOpen((o) => !o)}>
        {count} due
      </button>
      {open && (
        <div className="bk-pop" role="menu">
          <div className="bk-pop-head">
            <b>{count} due today</b>
            {overdue > 0 && <span className="bk-pop-late">{overdue} overdue</span>}
          </div>

          {err && <div className="bk-pop-empty">could not load the breakdown</div>}
          {!err && !data && <div className="bk-pop-empty">loading…</div>}

          {byExam.length > 0 && <div className="bk-pop-label">By exam</div>}
          {byExam.map((r) => (
            <button key={r.exam} className="bk-pop-row" role="menuitem"
              onClick={() => go({ exam: r.exam, scope: 'due' })}>
              <span className="bk-pop-name">{r.exam}</span>
              <span className="bk-pop-n">{r.due}</span>
              <span className="bk-pop-sub">of {r.open} open</span>
            </button>
          ))}

          {byTopic.length > 0 && <div className="bk-pop-label">By topic</div>}
          {byTopic.map(([topic, n]) => (
            <button key={topic} className="bk-pop-row" role="menuitem"
              onClick={() => go({ exam: 'ALL', scope: 'due' })}>
              <span className="bk-pop-name">{topic.replace(/_/g, ' ')}</span>
              <span className="bk-pop-n">{n}</span>
            </button>
          ))}

          <div className="bk-pop-foot">
            <button className="bk-pop-row" role="menuitem" onClick={() => go({ exam: 'ALL', scope: 'due' })}>
              <span className="bk-pop-name">Everything due</span><span className="bk-pop-n">{count}</span>
            </button>
            <button className="bk-pop-row" role="menuitem" onClick={() => go({ exam: 'ALL', scope: 'open' })}>
              <span className="bk-pop-name">Whole backlog</span>
              <span className="bk-pop-n">{data?.summary?.open ?? ''}</span>
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

const BK_FILTER_DEFAULTS = {
  source: 'ALL',     // ALL | OFFICIAL | MOCK | one of SOURCES.key
  topic: 'ALL',
  bucket: 'ALL',     // didnt_know | slipped | timing
  tier: 'ALL',       // 1 | 7 | 21
  notes: 'ALL',      // WITH | WITHOUT
};

function BacklogTab({ refreshKey, onCount, onOpenPaper, onOpenVideo, mode, focus }) {
  const [data, setData] = useState(null);
  const [exam, setExam] = useState(focus?.exam ?? 'ALL');
  // Opens on the whole open backlog, not just today's due items — the point of the
  // view is seeing everything that is still owed, with DUE one click away.
  const [scope, setScope] = useState(focus?.scope ?? 'open'); // due | open | slow | done | recent

  // Arriving from the header's due breakdown: the pane may already be open on another
  // filter, so follow the focus rather than ignoring it.
  useEffect(() => {
    if (!focus) return;
    if (focus.exam) setExam(focus.exam);
    if (focus.scope) setScope(focus.scope);
  }, [focus?.exam, focus?.scope, focus?.at]);
  const [expanded, setExpanded] = useState({});
  // Notes open by default: the note IS the question's context, and a pane that hides it
  // behind a click made every rework start with the same click.
  const [allOpen, setAllOpen] = useState(true);
  // The filter row is remembered: re-opening the pane on "all open, everything" when you
  // had been working through MAT integration is a small theft of your place.
  const [filters, setFilters] = useState(() => {
    try { return { ...BK_FILTER_DEFAULTS, ...JSON.parse(localStorage.getItem('bk-filters') || '{}') }; }
    catch { return { ...BK_FILTER_DEFAULTS }; }
  });
  const setFilter = (k, v) => setFilters((f) => {
    const next = { ...f, [k]: v };
    try { localStorage.setItem('bk-filters', JSON.stringify(next)); } catch { /* private mode */ }
    return next;
  });
  const resetFilters = () => {
    setFilters({ ...BK_FILTER_DEFAULTS });
    try { localStorage.removeItem('bk-filters'); } catch { /* private mode */ }
  };
  const [sessionOn, setSessionOn] = useState(false); // driven "Do backlog" workout
  // urgent = overdue then soonest due (the old fixed order, still the default)
  // overdue = deepest in the red first · stale = untouched longest · random = pick for me
  const [sort, setSort] = useState('urgent');
  const [shuffleKey, setShuffleKey] = useState(0);
  // Every band on this pane collapses, and the choice sticks: on a laptop the stats,
  // takeaways and recommendations can push the actual questions off the screen.
  const [bands, setBands] = useState(() => {
    try { return JSON.parse(localStorage.getItem('bk-bands') || '{}'); } catch { return {}; }
  });
  const toggleBand = (k) => setBands((b) => {
    const next = { ...b, [k]: !b[k] };
    try { localStorage.setItem('bk-bands', JSON.stringify(next)); } catch { /* private mode */ }
    return next;
  });

  const load = useCallback(() => {
    const q = new URLSearchParams();
    if (exam !== 'ALL') q.set('exam', exam);
    if (scope === 'due') q.set('due', '1');
    if (scope === 'done') q.set('done', '1');
    if (scope === 'recent') q.set('recent', '1');
    if (scope === 'slow') q.set('slow', '1');
    fetch(`/api/backlog?${q}`).then((r) => r.json()).then((d) => {
      setData(d);
      onCount?.(d.summary?.due ?? 0);
    }).catch(() => {});
  }, [exam, scope, onCount]);
  useEffect(() => { load(); }, [load, refreshKey]);

  async function mark(id, result) {
    await fetch('/api/backlog/complete', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, result }),
    });
    load();
  }

  // Takes back the most recent pass/fail and restores the tier and due date it had.
  async function undo(id) {
    await fetch('/api/backlog/undo', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    load();
  }

  const s = data?.summary;
  const today = s?.today ?? new Date().toISOString().slice(0, 10);
  // Most urgent first: overdue, then soonest due, then the longest-standing tier.
  const hasNotes = (i) => (typeof i.notes?.student === 'string' && i.notes.student.trim())
    || (typeof i.notes?.monday === 'string' && i.notes.monday.trim());
  const matchesSource = (i) => {
    if (filters.source === 'ALL') return true;
    const src = sourceOf(i);
    if (filters.source === 'OFFICIAL') return src.official === true;
    if (filters.source === 'MOCK') return src.official === false;
    return src.key === filters.source;
  };
  const shown = (data?.items ?? [])
    .filter((i) => scope !== 'done' || i.status === 'done')
    .filter(matchesSource)
    .filter((i) => filters.topic === 'ALL' || (i.topic ?? 'unlabelled') === filters.topic)
    .filter((i) => filters.bucket === 'ALL' || i.bucket === filters.bucket)
    .filter((i) => filters.tier === 'ALL' || String(i.tier ?? '') === filters.tier)
    .filter((i) => filters.notes === 'ALL'
      || (filters.notes === 'WITH' ? hasNotes(i) : !hasNotes(i)));
  // The recent view arrives newest-action-first from the server; re-sorting it by due
  // date would scatter the very thing you opened it to find.
  // When was this question last actually worked, as opposed to when it is next due?
  const lastTouched = (i) => {
    const h = i.history?.length ? i.history[i.history.length - 1] : null;
    return h?.at ?? h?.date ?? i.created ?? '';
  };
  const daysOverdue = (i) => (i.due ? Math.round((new Date(today) - new Date(i.due)) / 86400000) : -9999);

  const byUrgency = (a, b) => {
    const la = a.due && a.due < today ? 0 : 1;
    const lb = b.due && b.due < today ? 0 : 1;
    return la - lb || String(a.due ?? '').localeCompare(String(b.due ?? '')) || (b.tier ?? 0) - (a.tier ?? 0);
  };
  // Counts are over everything the server returned for the current scope and exam, so a
  // menu entry says how many rows choosing it would leave — including zero, which is worth
  // seeing rather than discovering by choosing it.
  const pool = (data?.items ?? []).filter((i) => scope !== 'done' || i.status === 'done');
  const countBy = (fn) => pool.reduce((acc, i) => {
    const k = fn(i);
    if (k != null) acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  const bySource = countBy((i) => sourceOf(i).key);
  const byTopic = countBy((i) => i.topic ?? 'unlabelled');
  const byBucket = countBy((i) => i.bucket);
  const byTier = countBy((i) => i.tier);
  const officialCount = pool.filter((i) => sourceOf(i).official).length;
  const notesCount = pool.filter(hasNotes).length;
  const sourceOpts = [
    { value: 'ALL', label: 'Every source', count: pool.length },
    { value: 'OFFICIAL', label: 'Official papers only', count: officialCount },
    { value: 'MOCK', label: 'Unofficial mocks only', count: pool.length - officialCount },
    ...SOURCES
      .filter((src) => bySource[src.key])
      .map((src) => ({ value: src.key, label: `   ${src.label}`, count: bySource[src.key] })),
  ];
  const topicOpts = [
    { value: 'ALL', label: 'Every topic', count: pool.length },
    ...Object.entries(byTopic).sort((a, b) => b[1] - a[1])
      .map(([t, n]) => ({ value: t, label: t.replace(/_/g, ' '), count: n })),
  ];
  const bucketOpts = [
    { value: 'ALL', label: 'Any reason', count: pool.length },
    { value: 'didnt_know', label: 'Did not know it', count: byBucket.didnt_know ?? 0 },
    { value: 'slipped', label: 'Slipped', count: byBucket.slipped ?? 0 },
    { value: 'timing', label: 'Ran out of time', count: byBucket.timing ?? 0 },
  ];
  const tierOpts = [
    { value: 'ALL', label: 'Any stage', count: pool.length },
    { value: '1', label: 'First revisit (1 day)', count: byTier[1] ?? 0 },
    { value: '7', label: 'Second revisit (7 days)', count: byTier[7] ?? 0 },
    { value: '21', label: 'Final revisit (21 days)', count: byTier[21] ?? 0 },
  ];
  const notesOpts = [
    { value: 'ALL', label: 'Notes or not', count: pool.length },
    { value: 'WITH', label: 'With notes', count: notesCount },
    { value: 'WITHOUT', label: 'Without notes', count: pool.length - notesCount },
  ];
  const filtersActive = Object.entries(BK_FILTER_DEFAULTS).some(([k, v]) => filters[k] !== v);

  const SORTS = {
    urgent: byUrgency,
    overdue: (a, b) => daysOverdue(b) - daysOverdue(a) || byUrgency(a, b),
    stale: (a, b) => String(lastTouched(a)).localeCompare(String(lastTouched(b))),
  };
  const items = scope === 'recent' && sort === 'urgent'
    // The recent view arrives newest-action-first from the server; re-sorting it by due
    // date would scatter the very thing you opened it to find.
    ? shown
    : sort === 'random'
      // Deterministic per shuffle, so the list does not reorder under you while you read
      // it — a new order costs one deliberate click.
      ? shown.map((i, n) => [Math.sin((n + 1) * 9301 + shuffleKey * 49297) % 1, i])
        .sort((a, b) => a[0] - b[0]).map(([, i]) => i)
      : shown.slice().sort(SORTS[sort] ?? byUrgency);

  // Workout queue: due items first, else the whole open backlog. Ignores the notes/exam
  // view filters — a session is about clearing what's owed, not what's on screen.
  const openAll = (data?.items ?? []).filter((i) => i.status !== 'done');
  const dueAll = openAll.filter((i) => i.due && i.due <= today);
  const sessionQueue = (dueAll.length ? dueAll : openAll).slice()
    .sort((a, b) => String(a.due ?? '').localeCompare(String(b.due ?? '')) || (b.tier ?? 0) - (a.tier ?? 0));

  if (sessionOn) {
    return (
      <div className="tab-fill bk-tab">
        <DoBacklogSession queue={sessionQueue} onOpenPaper={onOpenPaper} mode={mode}
          onDone={() => { setSessionOn(false); load(); }} />
      </div>
    );
  }

  return (
    <div className="tab-fill bk-tab">
      <div className="bk-bar">
        <span className="bk-title">Backlog</span>

        <Picker label="Show" value={scope} onChange={setScope}
          title="Which slice of the backlog to list"
          options={[
            { value: 'open', label: 'All open' },
            { value: 'due', label: 'Due today' },
            { value: 'slow', label: 'Slow ones' },
            { value: 'recent', label: 'Recently reworked' },
            { value: 'done', label: 'Cleared' },
          ]} />

        <Picker label="Exam" value={exam} onChange={setExam}
          title="The exam a question came from"
          options={[
            { value: 'ALL', label: 'Every exam' },
            { value: 'TMUA', label: 'TMUA' },
            { value: 'MAT', label: 'MAT' },
            { value: 'STEP', label: 'STEP' },
            { value: 'OTHER', label: 'Other' },
          ]} />

        <Picker label="Source" value={filters.source} onChange={(v) => setFilter('source', v)}
          title="Official past papers, unofficial mocks, or one particular collection"
          options={sourceOpts} />

        <Picker label="Topic" value={filters.topic} onChange={(v) => setFilter('topic', v)}
          title="The topic tag on the question" options={topicOpts} />

        <Picker label="Reason" value={filters.bucket} onChange={(v) => setFilter('bucket', v)}
          title="Why it went into the backlog" options={bucketOpts} />

        <Picker label="Stage" value={filters.tier} onChange={(v) => setFilter('tier', v)}
          title="How far through the 1 / 7 / 21 day cycle it is" options={tierOpts} />

        <Picker label="Notes" value={filters.notes} onChange={(v) => setFilter('notes', v)}
          title="Whether the question carries written notes" options={notesOpts} />

        <Picker label="Sort" value={sort}
          onChange={(v) => { setSort(v); if (v === 'random') setShuffleKey((n) => n + 1); }}
          title="The order of the list"
          options={[
            { value: 'urgent', label: 'Urgent first', hint: 'overdue, then soonest due' },
            { value: 'overdue', label: 'Most overdue' },
            { value: 'stale', label: 'Longest untouched' },
            { value: 'random', label: 'Random', hint: 'pick again to reshuffle' },
          ]} />

        <span className="bk-sep" />
        <button className={`btn tiny ${allOpen ? 'on' : ''}`} onClick={() => setAllOpen((v) => !v)}>
          {allOpen ? 'Collapse all' : 'Expand all notes'}
        </button>
        {filtersActive && (
          <button className="btn tiny warn" onClick={resetFilters}
            title="Back to every source, topic, reason and stage">Clear filters</button>
        )}
        <span className="quick-spacer" />
        <span className="bk-count">
          {items.length} shown{items.length !== pool.length ? ` of ${pool.length}` : ''}
        </span>
        <button className="btn tiny save" disabled={!(data?.items?.length)}
          onClick={() => setSessionOn(true)} title="Walk today's due questions one at a time, timed">▶ Do backlog</button>
        <button className="btn tiny" onClick={load}>Refresh</button>
      </div>

      {s && (
        <button className="bk-band-toggle" onClick={() => toggleBand('stats')}>
          {bands.stats ? '▸' : '▾'} {s.due} due · {s.open} open{s.overdue ? ` · ${s.overdue} overdue` : ''}
        </button>
      )}
      {s && !bands.stats && (
        <div className="bk-stats">
          <span className={s.due ? 'bk-pill hot' : 'bk-pill ok'}>{s.due} DUE</span>
          {s.overdue > 0 && <span className="bk-pill late">{s.overdue} OVERDUE</span>}
          <span className="bk-pill">{s.open} OPEN</span>
          <span className="bk-pill">{s.done} CLEARED</span>
          {s.byTier.map((t) => <span key={t.tier} className="bk-pill dim">{t.tier}d: {t.count}</span>)}
        </div>
      )}

      {data?.takeaways?.length > 0 && (
        <button className="bk-band-toggle" onClick={() => toggleBand('takeaways')}>
          {bands.takeaways ? '▸' : '▾'} Takeaways ({data.takeaways.length})
        </button>
      )}
      {data?.takeaways?.length > 0 && !bands.takeaways && (
        <div className="bk-takeaways">
          <span className="bk-take-label">Takeaways</span>
          {data.takeaways.map((t, n) => <span key={n} className="bk-take">{t}</span>)}
        </div>
      )}

      <button className="bk-band-toggle" onClick={() => toggleBand('recommend')}>
        {bands.recommend ? '▸' : '▾'} What to do next
      </button>
      {!bands.recommend && <RecommendPanel onOpenPaper={onOpenPaper} onOpenVideo={onOpenVideo} />}

      <div className="bk-body">
        {items.length === 0 && (
          <div className="bk-empty">
            {scope === 'due'
              ? 'Nothing due. Backlog clear — do work early and it stays that way.'
              : scope === 'recent'
                ? 'Nothing marked in the last 30 days.'
                : scope === 'slow'
                  ? 'Nothing slow — every timed rework came in under its budget.'
                  : 'Nothing here yet. The tutor ranks each mistake 1 / 7 / 21 days as you make them.'}
          </div>
        )}
        {items.map((i) => {
          const overdue = i.due && i.due < today;
          const days = i.due ? Math.round((new Date(i.due) - new Date(today)) / 86400000) : null;
          const countdown = i.status === 'done' ? `closed ${i.closed}`
            : days == null ? 'no date'
            : days < 0 ? `${-days}d overdue`
            : days === 0 ? 'due today'
            : `due in ${days}d`;
          const last = i.history?.length ? i.history[i.history.length - 1] : null;
          const isOpen = allOpen || !!expanded[i.id];
          const notesN = (typeof i.notes?.student === 'string' && i.notes.student.trim() ? 1 : 0)
            + (typeof i.notes?.monday === 'string' && i.notes.monday.trim() ? 1 : 0);
          return (
            <div key={i.id} className={`bk-item ${overdue ? 'overdue' : ''} ${i.status === 'done' ? 'done' : ''}`}>
              <div className="bk-head">
                <span className={`bk-exam x-${i.exam.toLowerCase()}`}>{i.exam}</span>
                <span className="bk-ref">{i.ref}</span>
                <span className="bk-topic">{String(i.topic).replace(/_/g, ' ')}</span>
                <span className="bk-bucket">{BUCKET_LABEL[i.bucket] ?? i.bucket}</span>
                <span className="quick-spacer" />
                <span className="bk-tier">{i.tier}d</span>
                {i.pace && (
                  <span className={`bk-pace ${i.pace.band && i.pace.band !== 'clean' ? 'over' : ''}`}
                    title={`Last timed rework took ${fmtClock(i.pace.seconds)} against a ${fmtClock(i.pace.budget)} budget (${i.pace.ratio}x) — ${i.pace.band}.`}>
                    ⏱ {fmtClock(i.pace.seconds)} / {fmtClock(i.pace.budget)}
                  </span>
                )}
                <span className={`bk-due ${overdue ? 'late' : ''}`}>{countdown}</span>
              </div>
              {i.detail && <div className="bk-detail">{i.detail}</div>}
              {i.correction && <div className="bk-fix">→ {i.correction}</div>}
              <div className="bk-open">
                <button className="btn tiny" onClick={() => setExpanded((e) => ({ ...e, [i.id]: !e[i.id] }))}>
                  {isOpen ? 'notes ▾' : `notes${notesN ? ` (${notesN})` : ''} ▸`}
                </button>
                {i.paper_path && (
                  <button className="btn tiny" {...studyClick(i, i.paper_path, 'qp', onOpenPaper)}
                    title={i.paper_path}>📄 Paper</button>
                )}
                {i.ms_path && (
                  <button className="btn tiny" {...studyClick(i, i.ms_path, 'ms', onOpenPaper)}
                    title="the worked solutions, opened at this question">🔑 Mark scheme</button>
                )}
                {/* No YouTube API key here, so this cannot resolve a video id to embed in
                    the VIDEO pane. It opens the search for the paper instead, which is the
                    honest version of the same click. */}
                <button className="btn tiny" title={`Search YouTube for "${i.ref}"`}
                  onClick={() => window.open(`https://www.youtube.com/results?search_query=${encodeURIComponent(`${i.ref} ${i.exam} solution`)}`, '_blank', 'noopener')}>
                  ▶ Video
                </button>
              </div>
              {i.history?.length > 0 && (
                <div className="bk-hist">{i.history.map((h, n) => (
                  <span key={n} className={h.result === 'fail' ? 'h-fail' : 'h-pass'}
                    title={h.at ? new Date(h.at).toLocaleString() : h.date}>
                    {h.date}{h.at ? ` ${new Date(h.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''} {h.tier}d {h.result}
                    {/* Elapsed per entry, so 4:20 → 3:55 → 3:40 reads as a line rather
                        than three unrelated passes. Entries logged before timing existed
                        carry no seconds and show nothing — never a 0, which would read
                        as instant. */}
                    {h.seconds != null && <em className={h.pace && h.pace !== 'clean' ? 'h-over' : ''}> {fmtClock(h.seconds)}</em>}
                  </span>
                ))}</div>
              )}
              {isOpen && <Insight ins={i.insight} />}
              {isOpen && <NoteEditor item={i} />}
              {(i.status !== 'done' || scope === 'recent') && (
                <div className="bk-acts">
                  {scope === 'recent' && last && (
                    <button className="btn tiny undo" onClick={() => undo(i.id)}
                      title={`Take back the "${last.result}" logged ${last.at ? new Date(last.at).toLocaleString() : last.date}. Restores tier ${last.tier}d and the due date it had. Click again to undo the one before it.`}>
                      ↩ undo {last.result}
                    </button>
                  )}
                  {i.status !== 'done' && (
                    <>
                      <button className="btn tiny save" onClick={() => mark(i.id, 'pass')}>✓ REWORKED COLD</button>
                      <button className="btn tiny stop" onClick={() => mark(i.id, 'fail')}>✗ STILL STUCK</button>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="bk-foot">
        {scope === 'recent' && 'Everything marked in the last 30 days, newest first — open and cleared together. Undo takes back the last mark and puts the tier and due date back. '}
        {scope === 'slow' && 'Right, but not right fast enough: the last timed rework ran over its budget, or the mistake was logged as running out of time. Pace is recorded but does not yet move anything. '}
        Closes only when reworked correctly from a blank sheet, a day later, solution unseen.
        Pass promotes 1 → 7 → 21 → cleared. Fail resets to 1 day.
      </div>
    </div>
  );
}

// ═══════════════ schedule tab — Google Calendar, read-only ═══════════════
function ScheduleTab() {
  const [data, setData] = useState(null);
  const [days, setDays] = useState(7);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback((force) => {
    fetch(`/api/calendar?days=${days}${force ? '&force=1' : ''}`)
      .then((r) => r.json()).then(setData).catch(() => setErr('could not reach server'));
  }, [days]);
  useEffect(() => { load(false); }, [load]);
  useEffect(() => { const t = setInterval(() => load(true), 10 * 60 * 1000); return () => clearInterval(t); }, [load]);

  async function addCal() {
    if (!/^https?:\/\//.test(url.trim())) { setErr('paste the full https:// iCal address'); return; }
    setBusy(true); setErr('');
    // the server merges — we only ever send the new one, never the existing secrets
    const r = await fetch('/api/calendar/config', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ add: { name: name.trim() || 'Calendar', url: url.trim() } }),
    }).then((x) => x.json()).catch(() => null);
    setBusy(false);
    if (!r?.ok) { setErr('could not save'); return; }
    setUrl(''); setName(''); load(true);
  }

  const fmt = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const dayLabel = (d) => {
    const x = new Date(d + 'T00:00:00');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.round((x - today) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    return x.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' }).toUpperCase();
  };

  const grouped = [];
  for (const e of data?.events ?? []) {
    const last = grouped[grouped.length - 1];
    if (last && last.day === e.day) last.items.push(e);
    else grouped.push({ day: e.day, items: [e] });
  }

  return (
    <div className="tab-fill sched-tab">
      <div className="sched-bar">
        <span className="sched-title">Schedule</span>
        {[1, 7, 14].map((d) => (
          <button key={d} className={`btn tiny ${days === d ? 'on' : ''}`} onClick={() => setDays(d)}>
            {d === 1 ? 'Today' : `${d}d`}
          </button>
        ))}
        <span className="quick-spacer" />
        <button className="btn tiny" onClick={() => load(true)}>Refresh</button>
      </div>

      <div className="sched-body">
        {data && !data.configured && (
          <div className="sched-setup">
            <p className="sched-help">
              Connect a Google Calendar, read-only. In Google Calendar open
              <b> Settings → your calendar → Integrate calendar</b>, copy the
              <b> Secret address in iCal format</b>, and paste it here. Keep it private —
              anyone with that link can read the calendar.
            </p>
            <input className="sched-input" placeholder="calendar name (e.g. School)" value={name} onChange={(e) => setName(e.target.value)} />
            <input className="sched-input" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" value={url} onChange={(e) => setUrl(e.target.value)} />
            <button className="btn" disabled={busy} onClick={addCal}>{busy ? 'Saving…' : 'Connect'}</button>
            {err && <div className="sched-err">{err}</div>}
          </div>
        )}

        {data?.errors?.length > 0 && (
          <div className="sched-err">
            {data.errors.map((e, i) => <div key={i}>{e.calendar}: {e.error}</div>)}
          </div>
        )}

        {data?.configured && grouped.length === 0 && (
          <div className="sched-empty">Nothing scheduled in the next {data.days} days.</div>
        )}

        {grouped.map((g) => (
          <div key={g.day} className="sched-day">
            <div className="sched-dayhead">{dayLabel(g.day)}</div>
            {g.items.map((e, i) => (
              <div key={i} className={`sched-ev ${e.allDay ? 'allday' : ''}`}>
                <span className="sched-time">{e.allDay ? 'all day' : `${fmt(e.start)}–${fmt(e.end)}`}</span>
                <span className="sched-name">{e.title}</span>
                {e.location && <span className="sched-loc">{e.location}</span>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════ ⌘T new-tab launcher ═══════════════
// Views first, then the records worth opening directly, then every file in the
// project (fetched once from /api/tree) so a paper is two keystrokes away.
const LAUNCH_VIEWS = [
  { key: 'chat', label: 'Monday', hint: 'the conversation', type: 'chat' },
  { key: 'files', label: 'Files', hint: 'project browser', type: 'files' },
  { key: 'pdf', label: 'PDF viewer', hint: 'empty pane for papers', type: 'pdf' },
  { key: 'readiness', label: 'Readiness', hint: 'per-topic bars, projected score, countdown', type: 'readiness' },
  { key: 'schedule', label: 'Schedule', hint: 'what is on today', type: 'schedule' },
  { key: 'backlog', label: 'Backlog', hint: 'revision due — 1 / 7 / 21 days', type: 'backlog' },
  { key: 'grades', label: 'Grades', hint: 'raw mark to TMUA grade, private to you', type: 'grades' },
  { key: 'video', label: 'Video', hint: 'R2Drew tutorials beside the work', type: 'video' },
  { key: 'inbox', label: 'Inbox', hint: 'dropped PDFs — what is pending vs classified', type: 'inbox' },
  { key: 'settings', label: 'Settings', hint: 'voice, prosody, model, modes, appearance, study, data', type: 'settings' },
];
const LAUNCH_RECORDS = [
  ['tutor_data/memory/session_memory.json', 'Session memory', 'the master record'],
  ['tutor_data/activity_log.json', 'Activity log', 'raw event stream'],
  ['tutor_data/session_notes.md', 'Session notes', 'written reports'],
  ['tutor_data/homework/current_hw.json', 'Homework', 'current set'],
  ['tutor_data/analytics.json', 'Analytics', 'deeper stats'],
];

function Launcher({ onPick, onClose }) {
  const [q, setQ] = useState('');
  const [files, setFiles] = useState([]);
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    fetch('/api/tree').then((r) => r.json()).then((d) => {
      const out = [];
      const walk = (n) => {
        if (!n) return;
        if (Array.isArray(n)) return n.forEach(walk);
        if (n.children) { n.children.forEach(walk); return; }
        if (n.path) out.push(n.path);
      };
      walk(d.tree ?? d.children ?? d);
      setFiles(out);
    }).catch(() => {});
  }, []);

  const needle = q.trim().toLowerCase();
  const items = useMemo(() => {
    const views = LAUNCH_VIEWS
      .filter((v) => !needle || v.label.toLowerCase().includes(needle))
      .map((v) => ({ group: 'Views', label: v.label, hint: v.hint, run: () => onPick(v.type, null, null) }));
    const recs = LAUNCH_RECORDS
      .filter(([p, l]) => !needle || l.toLowerCase().includes(needle) || p.toLowerCase().includes(needle))
      .map(([p, l, h]) => ({ group: 'Records', label: l, hint: h, run: () => onPick('file', { path: p }, l.toUpperCase()) }));
    const fs = (needle ? files.filter((p) => p.toLowerCase().includes(needle)) : files.slice(0, 12))
      .slice(0, 40)
      .map((p) => {
        const name = p.split('/').pop();
        const isPdf = /\.pdf$/i.test(p);
        return {
          group: isPdf ? 'Papers' : 'Files',
          label: name,
          hint: p.replace(/^.*tmua_proj\//, ''),
          run: () => (isPdf ? onPick('pdf', { path: p, page: 1 }, name) : onPick('file', { path: p }, name.toUpperCase())),
        };
      });
    return [...views, ...recs, ...fs];
  }, [needle, files]); // eslint-disable-line

  useEffect(() => { setSel(0); }, [needle]);

  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); items[sel]?.run(); onClose(); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  let lastGroup = null;
  return (
    <div className="launcher-back" onMouseDown={onClose}>
      <div className="launcher" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="launcher-input"
          value={q}
          placeholder="Open a view, record, or any file…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="launcher-list">
          {items.length === 0 && <div className="launcher-empty">Nothing matches.</div>}
          {items.map((it, i) => {
            const head = it.group !== lastGroup ? ((lastGroup = it.group), it.group) : null;
            return (
              <div key={i}>
                {head && <div className="launcher-group">{head}</div>}
                <div
                  className={`launcher-row ${i === sel ? 'on' : ''}`}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => { it.run(); onClose(); }}
                >
                  <span className="launcher-label">{it.label}</span>
                  <span className="launcher-hint">{it.hint}</span>
                </div>
              </div>
            );
          })}
        </div>
        <div className="launcher-foot">↑↓ move · ↵ open · esc close — opens in the last-clicked pane</div>
      </div>
    </div>
  );
}

function defaultLayout() {
  return {
    columns: [
      { id: 'c1', size: 1, collapsed: false, active: 'tf', tabs: [{ id: 'tf', type: 'files', title: 'Files' }] },
      { id: 'c2', size: 2.2, collapsed: false, active: 'tc', tabs: [{ id: 'tc', type: 'chat', title: 'MONDAY' }] },
      {
        id: 'c3',
        size: 1.8,
        collapsed: false,
        active: 'tn',
        tabs: [
          { id: 'tn', type: 'file', title: 'session_notes.md', props: { path: NOTES } },
          { id: 'tr', type: 'readiness', title: 'Readiness' },
        ],
      },
      { id: 'c4', size: 2, collapsed: false, active: 'tp', tabs: [{ id: 'tp', type: 'pdf', title: 'PDF', props: null }] },
    ],
  };
}

function loadLayout() {
  try {
    const l = JSON.parse(localStorage.getItem('tmua-layout-v3'));
    // Healed on the way in, so a layout already broken on disk fixes itself the
    // next time the app opens rather than needing Reset layout.
    if (l?.columns?.length) return healLayout(l);
  } catch {}
  try {
    // migrate v2 (px widths) → v3 (flex weights)
    const l = JSON.parse(localStorage.getItem('tmua-layout-v2'));
    if (l?.columns?.length) {
      l.columns.forEach((c) => { c.size = (c.width ?? 300) / 300; delete c.width; });
      return healLayout(l);
    }
  } catch {}
  return defaultLayout();
}

// ═══════════════ monday: local persistence ═══════════════
// The switches live in `.state.json` on the server (plangamma.md §C4) and are
// pushed down on the `config` event, but they are ALSO mirrored to localStorage
// so the panel is honest about its own state before the first `config` arrives
// and if /api/config is unreachable.
function loadLS(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    if (v && typeof v === 'object') return { ...fallback, ...v };
    if (typeof v === typeof fallback && v != null) return v;
  } catch {}
  return fallback;
}

// ═══════════════ app ═══════════════
export default function App() {
  // ?latex=1 — the KaTeX verification harness (see LatexCheck above). Checked
  // before anything else so the fixture renders with no websocket and no config.
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('latex')) {
    return <LatexCheck />;
  }

  // /exam — the exam simulator. Same whole-window-takeover trick as ?latex=1: no
  // websocket, no header, no tiling layout, and none of this app's styling.
  if (typeof window !== 'undefined' && window.location.pathname === '/exam') {
    return <Suspense fallback={null}><ExamApp /></Suspense>;
  }
  // /exam/report — the analysis page a sitting ends on. House styling, not the driver's.
  if (typeof window !== 'undefined' && window.location.pathname === '/exam/report') {
    return <Suspense fallback={null}><ExamReport /></Suspense>;
  }

  // `theme` is the theme IN FORCE ('light' | 'dark'); appearance.theme is the
  // preference, which may be 'system'. Everything that paints — moodColor(),
  // the orb, the sparkline — wants the resolved one.
  const [theme, setTheme] = useState(() => resolveTheme(localStorage.getItem('tmua-theme') ?? 'system'));
  const [layout, setLayout] = useState(loadLayout);
  const [msgs, setMsgs] = useState([]);
  const [pending, setPending] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('connecting');
  const [cost, setCost] = useState(0);
  const [timer, setTimer] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [drag, setDrag] = useState(null); // {tabId, fromCol}
  const [hint, setHint] = useState(null); // {colId, zone}
  const [menu, setMenu] = useState(false);
  const [chatMenu, setChatMenu] = useState(false);
  const [help, setHelp] = useState(false);
  const [launcher, setLauncher] = useState(false); // ⌘T new-tab picker
  const [backlogDue, setBacklogDue] = useState(0);
  const [backlogKey, setBacklogKey] = useState(0);

  // The due count used to arrive only from the backlog pane, so the header badge was
  // missing entirely until that tab had been opened at least once — on a fresh window the
  // work due today was invisible, which is the one thing the badge exists to prevent.
  // It is a small request; the pane still updates the same state when it loads.
  useEffect(() => {
    let live = true;
    fetch('/api/backlog?due=1')
      .then((r) => r.json())
      .then((d) => { if (live && Number.isFinite(d?.summary?.due)) setBacklogDue(d.summary.due); })
      .catch(() => { /* the badge simply stays as it was */ });
    return () => { live = false; };
  }, [backlogKey]);
  // id of the column last clicked — ⌘T opens there, ⌘W closes its active tab
  const [focusCol, setFocusCol] = useState(null);
  const focusColRef = useRef(null);
  useEffect(() => { focusColRef.current = focusCol; }, [focusCol]);
  // the keydown listener is bound once, so it reads live layout through a ref
  const layoutRef = useRef(null);
  const [chats, setChats] = useState([]);
  const [config, setConfig] = useState({ model: 'sonnet', effort: 'high' });
  const [ctx, setCtx] = useState(null); // {tokens, max, pct}
  const [inboxNew, setInboxNew] = useState(0);
  const [paper, setPaper] = useState(null); // dropped-paper intake status
  const [annBump, setAnnBump] = useState(null); // last annotations_changed event
  const wsRef = useRef(null);
  const pendingRef = useRef('');
  const colsRef = useRef(null);

  // ── monday ────────────────────────────────────────────────────────────────
  const [monday, setMonday] = useState(null);        // MondayState, §C1
  const mondayAtRef = useRef(0);                     // when it landed, for the local clock
  const lastTouchRef = useRef(Date.now());            // last real interaction, for the sitting clock
  // Tell the server he is here — any click, key or scroll, at most once a minute — so the
  // sitting (and Monday's pacing) follows actual use, not chat messages alone.
  useEffect(() => {
    let lastSent = 0;
    const touch = () => {
      const now = Date.now();
      lastTouchRef.current = now;
      if (now - lastSent < 60000) return;
      lastSent = now;
      try { if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify({ type: 'activity' })); } catch { /* reconnecting */ }
    };
    const evs = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
    evs.forEach((e) => window.addEventListener(e, touch, { passive: true, capture: true }));
    return () => evs.forEach((e) => window.removeEventListener(e, touch, { capture: true }));
  }, []);
  const [moodHistory, setMoodHistory] = useState([]); // sparkline; local until B ships one
  const [readiness, setReadiness] = useState(null);
  const [mode, setMode] = useState('DRILL');
  // In the native macOS shell the title bar is transparent and content fills the
  // window, so the traffic lights would sit over the header. Stamp a class the CSS
  // uses to inset the header's left edge past them. Harmless in a browser (no handler).
  useEffect(() => {
    if (window.webkit?.messageHandlers?.videoPane) document.documentElement.classList.add('native-app');
  }, []);
  const [alertAt, setAlertAt] = useState(0);         // proactive double-flash
  const [speaking, setSpeaking] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false); // context can't run — needs a tap
  const [typing, setTyping] = useState(false);       // mute-while-typing
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [voice, setVoice] = useState(() => loadLS('monday-voice', DEFAULT_VOICE));
  const [speech, setSpeech] = useState(() => loadLS('monday-speech', DEFAULT_SPEECH));
  const [proactiveCfg, setProactiveCfg] = useState(() => loadLS('monday-proactive', DEFAULT_PROACTIVE));
  const [proactiveMaster, setProactiveMaster] = useState(() => loadLS('monday-proactive-master', true));
  const [rateLimitMin, setRateLimitMin] = useState(() => loadLS('monday-rate-limit', DEFAULT_RATE_LIMIT_MIN));
  const [appearance, setAppearance] = useState(() => loadLS('monday-appearance', DEFAULT_APPEARANCE));
  const [targetScore, setTargetScore] = useState(() => loadLS('monday-target', 9));
  const [, setClockTick] = useState(0);
  const moodRef = useRef('focused');                 // stamped onto each message
  const typingTimer = useRef(null);
  const msgsRef = useRef([]);

  // ── appearance ────────────────────────────────────────────────────────────
  // Theme, density and font size are all applied by stamping the root element;
  // app.css redefines the relevant TOKENS from there, so every pane follows
  // without knowing these settings exist.
  useEffect(() => {
    const pref = appearance.theme ?? 'system';
    localStorage.setItem('tmua-theme', pref);
    const apply = () => {
      const resolved = resolveTheme(pref);
      document.documentElement.dataset.theme = resolved;
      setTheme(resolved);
    };
    apply();
    if (pref !== 'system') return undefined;
    // Following the machine means following it while the app is open, too.
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    mq?.addEventListener?.('change', apply);
    return () => mq?.removeEventListener?.('change', apply);
  }, [appearance.theme]);

  useEffect(() => {
    document.documentElement.dataset.density = appearance.density ?? 'comfortable';
    document.documentElement.dataset.fontsize = appearance.fontSize ?? 'normal';
  }, [appearance.density, appearance.fontSize]);
  useEffect(() => {
    layoutRef.current = layout;
    localStorage.setItem('tmua-layout-v3', JSON.stringify(layout));
    // keep the focused column pointing at something that still exists
    if (!layout.columns.some((c) => c.id === focusColRef.current)) {
      setFocusCol(layout.columns[0]?.id ?? null);
    }
  }, [layout]);

  // warn before leaving — a closed tab kills the live view (server state survives)
  useEffect(() => {
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  // Arc-style shortcuts. Cmd/Ctrl+1..9 is browser-reserved, so columns use Option+1..9.
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') { setMenu(false); setChatMenu(false); setHelp(false); setLauncher(false); return; }
      if (e.altKey && !e.metaKey && !e.ctrlKey && /^[1-9]$/.test(e.code.replace('Digit', ''))) {
        e.preventDefault();
        focusColumn(Number(e.code.replace('Digit', '')) - 1);
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 't' && !e.shiftKey) {
        // new tab picker. preventDefault matters in the native wrapper too, or the
        // keystroke falls through to AppKit instead of reaching the app.
        e.preventDefault();
        setLauncher((v) => !v);
      } else if (k === 'w' && !e.shiftKey) {
        e.preventDefault();
        closeActiveTabInFocusedColumn();
      } else if (k === 's' && !e.shiftKey) {
        if (e.target?.classList?.contains('editor')) return; // editor saves itself
        e.preventDefault();
        toggleSidebar();
      } else if (k === 'd') {
        e.preventDefault();
        // Pins the theme rather than toggling the resolved value, so ⌘D out of
        // "system" lands somewhere it will stay.
        toggleTheme();
      } else if (k === ',') {
        e.preventDefault();
        openTab('settings', null, null, focusColRef.current);
      } else if (k === '/') {
        e.preventDefault();
        setHelp((h) => !h);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line

  // The keydown listener is bound once, so ⌘D reads the live appearance through
  // a ref rather than a stale closure.
  const appearanceRef = useRef(appearance);
  useEffect(() => { appearanceRef.current = appearance; }, [appearance]);
  function toggleTheme() {
    const a = appearanceRef.current ?? DEFAULT_APPEARANCE;
    const next = resolveTheme(a.theme) === 'light' ? 'dark' : 'light';
    onSettingsPatch({ appearance: { ...a, theme: next } });
  }

  // ---- layout ops ----
  const mutate = (fn) => setLayout((L) => { const copy = structuredClone(L); fn(copy); copy.columns = copy.columns.filter((c) => c.tabs.length); return copy; });

  function findTab(L, tabId) {
    for (const col of L.columns) {
      const i = col.tabs.findIndex((t) => t.id === tabId);
      if (i >= 0) return { col, i };
    }
    return null;
  }

  function closeTab(tabId) {
    mutate((L) => {
      const loc = findTab(L, tabId);
      if (!loc) return;
      loc.col.tabs.splice(loc.i, 1);
      if (loc.col.active === tabId) loc.col.active = loc.col.tabs[0]?.id;
    });
  }

  function moveTab(tabId, targetColId, zone) {
    mutate((L) => {
      const loc = findTab(L, tabId);
      if (!loc) return;
      const [tab] = loc.col.tabs.splice(loc.i, 1);
      if (loc.col.active === tabId) loc.col.active = loc.col.tabs[0]?.id;
      let ti = L.columns.findIndex((c) => c.id === targetColId);
      if (ti < 0) ti = L.columns.length - 1;
      if (zone === 'stack') {
        const target = L.columns[ti];
        target.tabs.push(tab);
        target.active = tab.id;
        target.collapsed = false;
      } else {
        // split: new column takes half the target's share — total width unchanged
        const target = L.columns[ti];
        const half = (target.size ?? 1) / 2;
        target.size = half;
        const newCol = { id: uid(), size: half, collapsed: false, active: tab.id, tabs: [tab] };
        L.columns.splice(zone === 'left' ? ti : ti + 1, 0, newCol);
      }
    });
  }

  // Close the active tab of whichever column was last clicked (⌘W).
  function closeActiveTabInFocusedColumn() {
    const L = layoutRef.current;
    if (!L) return;
    const col = L.columns.find((c) => c.id === focusColRef.current) ?? L.columns.find((c) => !c.collapsed);
    // A collapsed column's tab is out of sight; closing it would be a silent loss.
    if (col?.active && !col.collapsed) closeTab(col.active);
  }

  // `intoCol` forces the destination (the ⌘T launcher passes the focused column);
  // otherwise fall back to the last-clicked column, then the old heuristic.
  function openTab(type, props, title, intoCol) {
    setLayout((L) => {
      const copy = structuredClone(L);
      // reuse existing tab of same type (files/chat/pdf) or same file path
      for (const col of copy.columns) {
        for (const t of col.tabs) {
          const match = type === 'file' ? t.type === 'file' && t.props?.path === props?.path : t.type === type;
          if (match) {
            if ((type === 'pdf' || type === 'backlog') && props) t.props = props;
            col.active = t.id;
            col.collapsed = false;
            return copy;
          }
        }
      }
      const tab = { id: uid(), type, title: title ?? TITLES[type] ?? 'TAB', props: props ?? null };
      // Settings is a dense, wide pane: dropping it into whichever column was last
      // clicked lands it in the 220px file sidebar most of the time. It picks the
      // widest open column instead. Every other tab type keeps the old behaviour.
      const widest = copy.columns
        .filter((c) => !c.collapsed)
        .reduce((best, c) => (best && (best.size ?? 1) >= (c.size ?? 1) ? best : c), null);
      // The last-clicked column is only a sensible home while it is open. Clicking
      // a collapsed strip to peek, then opening a tab, used to stuff the tab into
      // that strip (usually Files) and fling it open.
      // Callers pass the focused column as `intoCol`, so the same rule applies to it.
      const openId = (id) => copy.columns.find((c) => c.id === id && !c.collapsed)?.id;
      const into = openId(intoCol) ?? openId(focusColRef.current) ?? widest?.id;
      const wanted = type === 'settings' ? (widest?.id ?? into) : into;
      const host = copy.columns.find((c) => c.id === wanted)
        ?? copy.columns[Math.min(2, copy.columns.length - 1)] ?? copy.columns[0];
      if (host) { host.tabs.push(tab); host.active = tab.id; host.collapsed = false; }
      else copy.columns.push({ id: uid(), size: 1, collapsed: false, active: tab.id, tabs: [tab] });
      return copy;
    });
  }

  function updateTabProps(tabId, props) {
    mutate((L) => { const loc = findTab(L, tabId); if (loc) loc.col.tabs[loc.i].props = props; });
  }

  // Each distinct PDF gets its own tab. Same path → re-page in place; an empty
  // PDF placeholder gets filled first; otherwise a new tab is stacked into the
  // column that already holds PDFs (so papers group together).
  function openPdf(path, page) {
    setLayout((L) => {
      const copy = structuredClone(L);
      const props = { path, page, ts: Date.now() }; // ts forces re-scroll even to same page
      const title = path.split('/').pop();
      let empty = null;
      let host = null;
      for (const col of copy.columns) {
        for (const t of col.tabs) {
          if (t.type !== 'pdf') continue;
          host = col;
          if (t.props?.path === path) { t.props = props; col.active = t.id; col.collapsed = false; return copy; }
          if (!t.props?.path && !empty) empty = { col, t };
        }
      }
      if (empty) { empty.t.props = props; empty.t.title = title; empty.col.active = empty.t.id; empty.col.collapsed = false; return copy; }
      const tab = { id: uid(), type: 'pdf', title, props };
      if (host) { host.tabs.push(tab); host.active = tab.id; host.collapsed = false; }
      else copy.columns.push({ id: uid(), size: 1.5, collapsed: false, active: tab.id, tabs: [tab] });
      return copy;
    });
  }

  // Backlog study flow: the question paper always lands in ONE tab in the middle column,
  // and its mark scheme in ONE tab in the right-most column beside it — created there if
  // it doesn't exist. Columns remember their job (`role`), so after the first click the
  // layout is stable: paper in the middle, answers on the right, every time.
  function openStudyPdf(path, page, role = 'q', { newTab = false } = {}) {
    setLayout((L) => {
      const copy = structuredClone(L);
      const props = { path, page, ts: Date.now(), role };
      const title = `${role === 'ms' ? '🔑 ' : '📄 '}${path.split('/').pop()}`;
      const cols = copy.columns;
      // Study columns hold only PDFs. An older version of this could tag a shared column
      // (chat, files) as the question column; untag those so they are never moved.
      const studyOnly = (c) => c.tabs.every((t) => t.type === 'pdf');
      for (const c of cols) if ((c.role === 'q' || c.role === 'ms') && !studyOnly(c)) delete c.role;
      let q = cols.find((c) => c.role === 'q');
      if (!q) { q = { id: uid(), size: 1.5, collapsed: false, active: null, tabs: [], role: 'q' }; cols.push(q); }
      let ms = cols.find((c) => c.role === 'ms' && c !== q);
      if (!ms && role === 'ms') ms = { id: uid(), size: 1, collapsed: false, active: null, tabs: [], role: 'ms' };
      // Fixed order on EVERY click, whatever the saved layout says: question column, then
      // mark-scheme column, as the two right-most columns. Stray study tabs are pulled in.
      for (const c of [q, ms]) { const i = cols.indexOf(c); if (c && i >= 0) cols.splice(i, 1); }
      cols.push(q); if (ms) cols.push(ms);
      for (const c of cols) {
        for (const want of [['q', q], ['ms', ms]]) {
          if (!want[1] || c === want[1]) continue;
          const i = c.tabs.findIndex((t) => t.type === 'pdf' && t.props?.role === want[0]);
          if (i >= 0) { const [t] = c.tabs.splice(i, 1); want[1].tabs.push(t); if (c.active === t.id) c.active = c.tabs[0]?.id ?? null; }
        }
      }
      const host = role === 'ms' ? ms : q;
      host.collapsed = false;
      // A middle-clicked (new-tab) open is not tagged with the role, so later normal
      // clicks keep reusing the main study tab and never overwrite it.
      if (newTab) {
        const t = { id: uid(), type: 'pdf', title, props: { path, page, ts: Date.now(), studyCol: role } };
        host.tabs.push(t); host.active = t.id;
        return copy;
      }
      const tab = host.tabs.find((t) => t.type === 'pdf' && t.props?.role === role);
      if (tab) { tab.props = props; tab.title = title; host.active = tab.id; }
      else { const t = { id: uid(), type: 'pdf', title, props }; host.tabs.push(t); host.active = t.id; }
      return copy;
    });
  }

  // ── JZ paper flow: video | paper / MS | panel ─────────────────────────────────
  // Three columns tagged by role, placed as the right-most three; every other column is
  // collapsed to a strip so the screen is just the flow. The layout from before is kept
  // and put back on exit. Running it again just refocuses.
  // The most recently touched unfinished JZ flow, for the header's one-click Continue.
  const [flowResume, setFlowResume] = useState(null);
  useEffect(() => {
    const load = () => fetch('/api/paperflow/list?collection=jz').then((r) => r.json()).then((d) => {
      const live = (d.papers ?? []).filter((p) => p.status === 'active' && (p.marked > 0 || (p.current ?? 1) > 1 || p.started));
      live.sort((a, b) => String(b.updated ?? '').localeCompare(String(a.updated ?? '')));
      setFlowResume(live[0] ?? null);
    }).catch(() => {});
    load();
    window.addEventListener('focus', load);
    const iv = setInterval(load, 30000);
    return () => { window.removeEventListener('focus', load); clearInterval(iv); };
  }, []);

  function openPaperFlow(paper = null) {
    setLayout((L) => {
      const copy = structuredClone(L);
      const cols = copy.columns;
      if (!cols.some((c) => c.role === 'pf-panel')) {
        try { localStorage.setItem('tmua-layout-pre-flow', JSON.stringify(L)); } catch { /* private mode */ }
      }
      const take = (role, size) => {
        const c = cols.find((x) => x.role === role);
        if (c) { cols.splice(cols.indexOf(c), 1); return c; }
        return { id: uid(), size, collapsed: false, active: null, tabs: [], role };
      };
      const v = take('pf-video', 1.2);
      const d = take('pf-pdf', 1.5);
      const p = take('pf-panel', 0.9);
      if (!v.tabs.some((t) => t.type === 'video')) {
        let moved = null;
        for (const c of cols) {
          const i = c.tabs.findIndex((t) => t.type === 'video');
          if (i >= 0) { [moved] = c.tabs.splice(i, 1); if (c.active === moved.id) c.active = c.tabs[0]?.id ?? null; break; }
        }
        v.tabs.push(moved ?? { id: uid(), type: 'video', title: TITLES.video, props: {} });
      }
      if (!d.tabs.some((t) => t.type === 'pdf' && t.props?.pf)) d.tabs.push({ id: uid(), type: 'pdf', title: 'Paper', props: { pf: true } });
      let panel = p.tabs.find((t) => t.type === 'paperflow');
      if (!panel) { panel = { id: uid(), type: 'paperflow', title: TITLES.paperflow, props: { paper } }; p.tabs.push(panel); }
      else if (paper) panel.props = { ...panel.props, paper };
      for (const c of cols) c.collapsed = true;
      v.active = v.tabs.find((t) => t.type === 'video').id;
      d.active = d.tabs.find((t) => t.type === 'pdf' && t.props?.pf).id;
      p.active = panel.id;
      for (const c of [v, d, p]) { c.collapsed = false; cols.push(c); }
      return copy;
    });
  }

  function flowPdf(path, page, kind) {
    mutate((L) => {
      const d = L.columns.find((c) => c.role === 'pf-pdf');
      const t = d?.tabs.find((x) => x.type === 'pdf' && x.props?.pf);
      if (!t) return;
      t.props = { path, page, ts: Date.now(), pf: true, zoom: 1 };   // JZ flow papers open at 100%
      t.title = `${kind === 'ms' ? '🔑 MS' : '📄 Paper'} · ${path.split('/').pop()}`;
      d.active = t.id; d.collapsed = false;
    });
  }

  function flowVideo(videoId, title) {
    mutate((L) => {
      const v = L.columns.find((c) => c.role === 'pf-video');
      const t = v?.tabs.find((x) => x.type === 'video');
      if (!t || t.props?.videoId === videoId) return;   // already playing: never restart it
      t.props = { videoId, t: 0, title, ts: Date.now() };
      v.active = t.id; v.collapsed = false;
    });
  }

  function closePaperFlow() {
    let prev = null;
    try { prev = JSON.parse(localStorage.getItem('tmua-layout-pre-flow')); } catch { /* none */ }
    try { localStorage.removeItem('tmua-layout-pre-flow'); } catch { /* ignore */ }
    if (prev?.columns?.length) { setLayout(prev); return; }
    mutate((L) => {
      L.columns = L.columns.filter((c) => !String(c.role ?? '').startsWith('pf-'));
      for (const c of L.columns) c.collapsed = false;
    });
  }

  function openVideo(videoId, t = 0, title = null) {
    setLayout((L) => {
      const copy = structuredClone(L);
      const props = { videoId, t, title, ts: Date.now() }; // ts re-seeks even the same video
      for (const col of copy.columns) {
        for (const tab of col.tabs) {
          if (tab.type !== 'video') continue;
          tab.props = props; col.active = tab.id; col.collapsed = false;
          return copy;
        }
      }
      const tab = { id: uid(), type: 'video', title: TITLES.video, props };
      const last = copy.columns[copy.columns.length - 1];
      if (last) { last.tabs.push(tab); last.active = tab.id; last.collapsed = false; }
      else copy.columns.push({ id: uid(), size: 1, collapsed: false, active: tab.id, tabs: [tab] });
      return copy;
    });
  }

  function focusTab(tabId) {
    mutate((L) => {
      const loc = findTab(L, tabId);
      if (loc) { loc.col.active = tabId; loc.col.collapsed = false; }
    });
  }

  function toggleSidebar() {
    setLayout((L) => {
      const copy = structuredClone(L);
      const col = copy.columns.find((c) => c.tabs.some((t) => t.type === 'files'));
      if (col) { col.collapsed = !col.collapsed; return copy; }
      // Files was closed: bring it back as a left rail rather than collapsing
      // whichever column happened to be first.
      const tab = { id: uid(), type: 'files', title: TITLES.files ?? 'Files', props: null };
      copy.columns.unshift({ id: uid(), size: 1, collapsed: false, active: tab.id, tabs: [tab] });
      return copy;
    });
  }

  function focusColumn(i) {
    const id = layoutRef.current?.columns[i]?.id;
    if (id) setFocusCol(id);
    mutate((L) => { const c = L.columns[i]; if (c) c.collapsed = false; });
  }

  // ---- ws events ----
  function applyEvent(ev, live) {
    switch (ev.type) {
      case 'user_message': setMsgs((m) => [...m, { role: 'user', text: ev.text, imageCount: ev.imageCount }]); if (live) setBusy(true); break;
      case 'assistant_delta': pendingRef.current += ev.text; setPending(pendingRef.current); break;
      case 'assistant_message': {
        pendingRef.current = '';
        setPending('');
        // The server stamps the turn id it spoke this reply under (session.js), so
        // the audio is associated exactly rather than by arrival order. Older
        // recorded transcripts have no id and simply get no ▶.
        setMsgs((m) => [...m, {
          role: 'assistant', text: ev.text,
          mood: ev.mood ?? moodRef.current,
          utts: ev.utteranceId ? [ev.utteranceId] : [],
        }]);
        break;
      }
      case 'tool_use':
        // Monday narrating itself, first person — see TOOL_VOICE in monday/constants.js
        setMsgs((m) => [...m, { role: 'tool', text: toolCaption(ev) }]);
        break;
      case 'turn_done': pendingRef.current = ''; setPending(''); setBusy(false); if (ev.cost) setCost((c) => c + ev.cost); break;
      case 'show_pdf': if (live) openPdf(ev.path, ev.page); break;
      case 'annotations_changed': if (live) setAnnBump({ path: ev.path, author: ev.author, n: Date.now() }); break;
      case 'show_video': if (live && mode !== 'EXAM') openVideo(ev.videoId, ev.t ?? 0, ev.title ?? ev.note ?? null); break;
      case 'timer': if (live) setTimer({ label: ev.label, endsAt: Date.now() + ev.seconds * 1000, total: ev.seconds }); break;
      case 'reset':
        setMsgs([]); setPending(''); pendingRef.current = ''; setBusy(false); setTimer(null); setCtx(null);
        audio.stopAll(); setAlertAt(0);
        break;
      case 'file_changed': setRefreshKey((k) => k + 1); break;
      case 'error': setMsgs((m) => [...m, { role: 'assistant', text: `⚠️ ${ev.text}` }]); setBusy(false); break;
      case 'chats': setChats(ev.chats); break;
      case 'backlog_changed': setBacklogKey((k) => k + 1); break;
      case 'backlog_due': setBacklogKey((k) => k + 1); break;
      // `persona` is gone (Monday replaced it). Voice / proactive / mode ride
      // along on the same event once D lands the §C4 config migration; until
      // then only model+effort are present and the rest keeps its local value.
      case 'config':
        // app/server/mood.js owns the palette; the copy in monday/constants.js is
        // only a fallback for the moment before the first `config` arrives.
        if (ev.moodColors) setMoodColors(ev.moodColors);
        setConfig({ model: ev.model, effort: ev.effort });
        if (ev.voice) setVoice((v) => ({ ...v, ...ev.voice }));
        // The server clamps and validates, then echoes back what it actually
        // stored — so these assignments are the correction, not a duplicate.
        if (ev.speech) setSpeech((sp) => ({ ...sp, ...ev.speech, prosody: { ...sp.prosody, ...(ev.speech.prosody ?? {}) } }));
        if (ev.proactive) setProactiveCfg((p) => ({ ...p, ...ev.proactive }));
        if (typeof ev.proactiveEnabled === 'boolean') setProactiveMaster(ev.proactiveEnabled);
        if (Number.isFinite(ev.proactiveRateLimitMin)) setRateLimitMin(ev.proactiveRateLimitMin);
        if (ev.appearance) setAppearance((a) => ({ ...a, ...ev.appearance }));
        if (Number.isFinite(ev.targetScore)) setTargetScore(ev.targetScore);
        if (ev.mode) setMode(ev.mode);
        break;
      case 'chat_switched': setMsgs([]); setPending(''); pendingRef.current = ''; setBusy(false); setCtx(null); ev.events.forEach((x) => applyEvent(x, false)); break;
      case 'compacted': setMsgs((m) => [...m, { role: 'tool', text: `context compacted ${Math.round((ev.pre_tokens ?? 0) / 1000)}k → ${Math.round((ev.post_tokens ?? 0) / 1000)}k tokens (${ev.trigger})` }]); break;
      case 'context_usage': if (live) setCtx({ tokens: ev.tokens, max: ev.max, pct: ev.pct }); break;
      case 'inbox_added': if (live) setInboxNew((n) => n + 1); break;
      // A dropped paper reports its own progress, so filing and classification are
      // visible instead of the app going quiet for several minutes.
      case 'paper_progress': if (live) setPaper({ file: ev.file, text: ev.text, done: false }); break;
      case 'paper_done':
        setPaper({ file: ev.file, text: ev.message, done: true, ok: ev.ok !== false });
        setRefreshKey((k) => k + 1);
        if (live) setTimeout(() => setPaper(null), 20000);
        break;
      case 'inbox_state': setInboxNew(ev.count ?? 0); break;

      // ═══ MONDAY — plangamma.md §C3 ═══
      // monday_state: MondayState. Drives the status line, the orb colour, the
      // mood popover, the mode chrome, and the mood stamped on the next message.
      case 'monday_state': applyMondayState(ev); break;
      // monday_boot: { greeting, state }. Orb wakes, boot line lands in the chat.
      case 'monday_boot':
        if (ev.state) applyMondayState(ev.state);
        if (ev.greeting) {
          setMsgs((m) => [...m, { role: 'assistant', text: ev.greeting, mood: ev.state?.mood ?? moodRef.current, utts: [], boot: true }]);
        }
        break;
      // audio_chunk: { utteranceId, seq, mime, b64, ms } — decoded and scheduled
      // gaplessly by monday/audio.js, which also owns the AnalyserNode the orb reads.
      case 'audio_chunk':
        audio.push(ev);
        break;
      case 'audio_end': if (ev.utteranceId) audio.end(ev.utteranceId); break;
      // proactive: { trigger, text, severity } — orb double-flashes, and the
      // nudge lands in the chat marked as unprompted.
      case 'proactive':
        setAlertAt(Date.now());
        setMsgs((m) => [...m, { role: 'proactive', text: ev.text, trigger: ev.trigger, severity: ev.severity, mood: moodRef.current }]);
        break;
      // readiness: the full report, incl. per-topic rows for the READINESS pane.
      // `target` and `trajectory` ride along because the target is a SETTING now —
      // picking four fields out of the report left the pane rendering the old
      // hard-coded 9.0 whatever Settings said.
      case 'readiness':
        setReadiness({
          overall: ev.overall, projected: ev.projected, weakest: ev.weakest, topics: ev.topics,
          target: ev.target, trajectory: ev.trajectory, onTrack: ev.onTrack,
          examDate: ev.examDate, daysToExam: ev.daysToExam,
        });
        break;
      default: break;
    }
  }

  /** One place that folds a MondayState into every piece of UI that depends on it. */
  function applyMondayState(s) {
    if (!s) return;
    mondayAtRef.current = Date.now();
    setMonday(s);
    if (s.mood) {
      moodRef.current = s.mood;
      // B keeps mood_history in tutor_data/monday/memory.json but the event
      // contract does not carry it, so the sparkline accumulates locally too.
      setMoodHistory((h) => {
        if (Array.isArray(s.moodHistory) && s.moodHistory.length) return s.moodHistory.slice(-200);
        if (h[h.length - 1]?.mood === s.mood) return h;
        return [...h, { ts: Date.now(), mood: s.mood }].slice(-200);
      });
    }
    if (s.mode) setMode(s.mode);
    if (s.readiness) setReadiness((r) => ({ ...(r ?? {}), ...s.readiness }));
  }

  useEffect(() => {
    let ws; let closed = false;
    function connect() {
      ws = new WebSocket(`ws://${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => setStatus('connected');
      ws.onclose = () => { setStatus('disconnected'); if (!closed) setTimeout(connect, 1500); };
      ws.onmessage = (e) => {
        let ev;
        try { ev = JSON.parse(e.data); } catch { return; } // a malformed frame must not kill the socket handler
        if (ev.type === 'replay') { setMsgs([]); ev.events.forEach((x) => applyEvent(x, false)); setBusy(false); }
        else applyEvent(ev, true);
      };
    }
    connect();
    return () => { closed = true; ws?.close(); };
  }, []); // eslint-disable-line

  // ═══════════════ monday: wiring ═══════════════
  useEffect(() => { msgsRef.current = msgs; }, [msgs]);

  // EXAM has to feel different, not just say a different word: the mode goes on
  // the root element and app.css repaints the whole shell from there.
  useEffect(() => { document.documentElement.dataset.mode = mode; }, [mode]);

  // Volume / mute. EXAM is silent by contract (modes.js gates the server side
  // too, but the client must not be the thing that leaks sound).
  const voiceOn = !!voice.enabled && mode !== 'EXAM';
  useEffect(() => { audio.setVolume(voice.volume ?? 0.9); }, [voice.volume]);
  useEffect(() => { audio.setMuted(!voiceOn); }, [voiceOn]);
  // Typing no longer ducks the voice. Ducking assumed typing meant attention had
  // moved off Monday, but the common case is typing an answer WHILE it explains —
  // and cutting the audio there loses the part you were listening for. Mute is
  // still available deliberately, via the speaker toggle.
  useEffect(() => { audio.setDucked(false); }, []);

  // The orb's `speaking` state must follow the real playback graph.
  useEffect(() => audio.onChange((a) => { setSpeaking(a.speaking); setAudioBlocked(a.blocked); }), []);

  // Mirror the switches locally so the panel is truthful before the first
  // `config` event and if /api/config is not there yet.
  useEffect(() => { localStorage.setItem('monday-voice', JSON.stringify(voice)); }, [voice]);
  useEffect(() => { localStorage.setItem('monday-proactive', JSON.stringify(proactiveCfg)); }, [proactiveCfg]);
  useEffect(() => { localStorage.setItem('monday-proactive-master', JSON.stringify(proactiveMaster)); }, [proactiveMaster]);
  useEffect(() => { localStorage.setItem('monday-speech', JSON.stringify(speech)); }, [speech]);
  useEffect(() => { localStorage.setItem('monday-rate-limit', JSON.stringify(rateLimitMin)); }, [rateLimitMin]);
  useEffect(() => { localStorage.setItem('monday-appearance', JSON.stringify(appearance)); }, [appearance]);
  useEffect(() => { localStorage.setItem('monday-target', JSON.stringify(targetScore)); }, [targetScore]);

  // Session clock in the status line ticks locally between monday_state events.
  useEffect(() => {
    if (!monday) return undefined;
    const iv = setInterval(() => setClockTick((t) => t + 1), 1000);
    return () => clearInterval(iv);
  }, [monday]);

  // A proactive nudge flashes the orb, then it goes back to whatever it was.
  useEffect(() => {
    if (!alertAt) return undefined;
    const t = setTimeout(() => setAlertAt(0), 1300);
    return () => clearTimeout(t);
  }, [alertAt]);

  // Mute while typing: duck immediately, release ~1.4 s after the last keystroke.
  const onTyping = useCallback(() => {
    setTyping(true);
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => setTyping(false), 1400);
  }, []);

  /** SETTINGS / mode writes. `/api/config` does NOT exist yet — D builds it
   *  (sparse patch: voice / proactive / proactiveEnabled / mode). Fails silently and
   *  the UI keeps its local value, which is the right degradation for switches. */
  const postConfig = useCallback((patch) => {
    fetch('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).catch(() => {});
  }, []);

  /** One writer for every control in the settings pane and popover. Optimistic
   *  locally so a slider does not lag the finger; the `config` event that comes
   *  back carries whatever the server actually agreed to store. */
  const onSettingsPatch = useCallback((patch) => {
    if (patch.voice) setVoice(patch.voice);
    if (patch.speech) setSpeech(patch.speech);
    if (patch.proactive) setProactiveCfg(patch.proactive);
    if (typeof patch.proactiveEnabled === 'boolean') setProactiveMaster(patch.proactiveEnabled);
    if (patch.proactiveRateLimitMin != null) setRateLimitMin(patch.proactiveRateLimitMin);
    if (patch.appearance) setAppearance(patch.appearance);
    if (patch.targetScore != null) setTargetScore(patch.targetScore);
    if (patch.model || patch.effort) setConfig((c) => ({ ...c, ...(patch.model ? { model: patch.model } : {}), ...(patch.effort ? { effort: patch.effort } : {}) }));
    if (patch.examDate) setReadiness((r) => (r ? { ...r, examDate: patch.examDate } : r));
    postConfig(patch);
  }, [postConfig]);

  const onMode = useCallback((m) => {
    setMode(m);                    // optimistic — the mode is a UI state as much as a server one
    postConfig({ mode: m });
    wsRef.current?.send(JSON.stringify({ type: 'set_mode', mode: m }));
    if (m === 'EXAM') audio.stopAll();
  }, [postConfig]);

  // Cached chunks replay instantly. After a reload the store is empty, so fall back
  // to asking the server to speak the text again — synthesis is cached server-side,
  // so a line heard before comes back in milliseconds.
  const onReplay = useCallback(async (utts, text, mood) => {
    audio.ensure();
    audio.flushPending();
    // Preferred path: ask the server to speak THIS message's own text. One utteranceId
    // covers a whole turn (several messages share it), so replaying cached chunks would
    // play the turn from its first line, not the clicked one — wrong granularity. The
    // server-side synthesis cache keeps a repeat press near-instant.
    const localFallback = () => { if (utts?.length && audio.hasAudio(utts)) audio.replay(utts); };
    if (!text) { localFallback(); return; }
    try {
      const r = await fetch('/api/speak', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, mood: mood ?? 'focused' }),
      });
      // Server unreachable or voice off/muted → fall back to locally cached chunks
      // (whole-turn, but audible) so ▶ still does something offline or while muted.
      if (!r.ok) localFallback();
    } catch { localFallback(); }
  }, []);

  const orbState = status !== 'connected' ? 'dormant'
    : alertAt ? 'alert'
    : speaking ? 'speaking'
    : busy ? 'thinking'
    : 'idle';

  // The sitting clock: only while a sitting is actually running. The server zeroes it after
  // 25 idle minutes, and the local tick stops on the same rule, so it can never drift into
  // counting the hours the window sat open (it used to read server uptime — "28 hours").
  const sittingLive = monday && (monday.sessionElapsedMs ?? 0) > 0 && Date.now() - lastTouchRef.current <= SITTING_GAP_MS;
  const elapsed = sittingLive ? clock((monday.sessionElapsedMs ?? 0) + (Date.now() - mondayAtRef.current)) : null;

  const onSend = (text, images) => wsRef.current?.send(JSON.stringify({ type: 'user_message', text, images }));
  const onInterrupt = () => wsRef.current?.send(JSON.stringify({ type: 'interrupt' }));
  const onNewChat = () => wsRef.current?.send(JSON.stringify({ type: 'new_chat' })); // old chat is archived, nothing lost
  const onSwitchChat = (id) => wsRef.current?.send(JSON.stringify({ type: 'switch_chat', id }));
  const onDeleteChat = (id) => { if (confirm('Delete this chat permanently?')) wsRef.current?.send(JSON.stringify({ type: 'delete_chat', id })); };
  const onConfig = (patch) => wsRef.current?.send(JSON.stringify({ type: 'set_config', ...config, ...patch }));

  async function onCheckInbox() {
    const d = await fetch('/api/inbox-new').then((r) => r.json()).catch(() => ({ files: [] }));
    if (!d.files?.length) {
      setInboxNew(0);
      setMsgs((m) => [...m, { role: 'tool', text: 'inbox: nothing new' }]); // local — costs no tokens
      return;
    }
    onSend(`Check the inbox — new files:\n${d.files.map((f) => `- ${f}`).join('\n')}\nRead them and respond to what you find.`, []);
    await fetch('/api/inbox-ack', { method: 'POST', body: JSON.stringify({ paths: d.files }) });
    setInboxNew(0);
  }

  async function onEmail() {
    const d = await fetch('/api/email-draft').then((r) => r.json()).catch(() => null);
    if (!d || d.error) { alert(d?.error ?? 'could not build email draft'); return; }
    location.href = `mailto:?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body.slice(0, 6000))}`;
  }

  function onSelectFile(node) {
    const p = node.path.toLowerCase();
    if (p.endsWith('.pdf')) openPdf(node.path, 1);
    else if (/\.(html|png|jpe?g)$/.test(p)) window.open(`/api/raw?path=${encodeURIComponent(node.path)}`, '_blank');
    else openTab('file', { path: node.path }, node.name);
  }

  // ---- resize: redistribute weight between the two neighbouring columns ----
  function startResize(e, leftId, rightId) {
    e.preventDefault();
    const startX = e.clientX;
    // Pixels per unit of weight: the open columns share only the width left after
    // padding, dividers and collapsed strips. Dividing by the whole container
    // made the divider fall behind the cursor — 13-18px on a 300px drag.
    const openPx = [...(colsRef.current?.querySelectorAll(':scope > .col:not(.collapsed)') ?? [])]
      .reduce((s, el) => s + el.getBoundingClientRect().width, 0) || window.innerWidth;
    const left0 = colSize(layout.columns.find((c) => c.id === leftId)?.size);
    const right0 = colSize(layout.columns.find((c) => c.id === rightId)?.size);
    const total = layout.columns.filter((c) => !c.collapsed).reduce((s, c) => s + colSize(c.size), 0);
    // An iframe (video, dashboard) under the cursor swallows mousemove and the
    // drag sticks; the class switches pointer events off below the divider.
    document.body.classList.add('col-resizing');
    function mm(ev) {
      const dw = ((ev.clientX - startX) / openPx) * total;
      mutate((L) => {
        const l = L.columns.find((x) => x.id === leftId);
        const r = L.columns.find((x) => x.id === rightId);
        if (!l || !r) return;
        // The pair's sum is conserved, so clamping one end is the same as
        // clamping the drag itself. The previous version applied two `if`s in
        // sequence: when BOTH ends wanted to go under the minimum the second
        // subtracted from the first again and drove it negative — which is an
        // invalid flex-grow, and a column that has stopped growing.
        const [nl, nr] = clampPair(left0, right0, dw, total);
        l.size = nl;
        r.size = nr;
      });
    }
    function mu() {
      document.body.classList.remove('col-resizing');
      window.removeEventListener('mousemove', mm);
      window.removeEventListener('mouseup', mu);
    }
    window.addEventListener('mousemove', mm);
    window.addEventListener('mouseup', mu);
  }

  // Double-click a divider: split that pair's width evenly.
  function equalisePair(leftId, rightId) {
    mutate((L) => {
      const l = L.columns.find((x) => x.id === leftId);
      const r = L.columns.find((x) => x.id === rightId);
      if (!l || !r) return;
      l.size = r.size = (colSize(l.size) + colSize(r.size)) / 2;
    });
  }

  function renderTab(tab) {
    switch (tab.type) {
      case 'files': return <FilesTab onSelect={onSelectFile} refreshKey={refreshKey} />;
      case 'chat': return (
        <ChatTab
          msgs={msgs} pending={pending} pendingMood={monday?.mood} busy={busy}
          onSend={onSend} onInterrupt={onInterrupt} config={config} onConfig={onConfig}
          inboxNew={inboxNew} onCheckInbox={onCheckInbox} onEmail={onEmail}
          theme={theme} mode={mode} onTyping={onTyping} onReplay={onReplay}
        />
      );
      case 'file': return <FileTab path={tab.props.path} refreshKey={refreshKey} />;
      case 'pdf': return <PdfTab props={tab.props} onProps={(p) => updateTabProps(tab.id, p)} annBump={annBump} />;
      case 'schedule': return <ScheduleTab />;
      case 'grades': return <GradesTab />;
      case 'inbox': return <InboxTab />;
      case 'video': return <VideoTab props={tab.props ?? {}} />;
      case 'paperflow': return <PaperFlowTab paper={tab.props?.paper ?? null} mode={mode}
        onPick={(paper) => updateTabProps(tab.id, { ...(tab.props ?? {}), paper })}
        onPdf={flowPdf} onVideo={flowVideo} onExit={closePaperFlow} />;
      case 'backlog': return <BacklogTab refreshKey={backlogKey} onCount={setBacklogDue} onOpenPaper={openStudyPdf} onOpenVideo={openVideo} mode={mode} focus={tab.props} />;
      case 'target85': return <TargetTab
        onOpenBacklog={() => openTab('backlog', null, null, focusColRef.current)}
        onOpenPdf={(path, title) => openTab('pdf', { path, page: 1, ts: Date.now() }, title, focusColRef.current)}
        onExam={() => openExam()} />;
      case 'readiness': return <ReadinessTab readiness={readiness} daysToExam={monday?.daysToExam} />;
      case 'settings': return (
        <SettingsPane
          voice={voice} speech={speech} proactive={proactiveCfg} proactiveMaster={proactiveMaster}
          rateLimitMin={rateLimitMin} appearance={appearance} config={config}
          mode={mode} theme={theme} targetScore={targetScore}
          onPatch={onSettingsPatch} onMode={onMode}
          onOpenReadiness={() => openTab('readiness', null, null, focusColRef.current)}
        />
      );
      default: return <div className="tab-fill">UNKNOWN TAB</div>;
    }
  }

  function zoneFromEvent(e) {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    return x < 0.25 ? 'left' : x > 0.75 ? 'right' : 'stack';
  }

  return (
    <div className="shell">
      <header>
        <MondayOrb
          state={orbState}
          mood={monday?.mood ?? 'focused'}
          theme={theme}
          level={() => audio.level()}
          title={`MONDAY — ${orbState}${monday?.mood ? ` · ${monday.mood}` : ''}${status !== 'connected' ? ` · ${status}` : ''}`}
        />
        <span className="logo">MONDAY</span>
        <DailyTime mode={mode} timer={timer} />
        <HealthStrip connection={status} />
        {audioBlocked && voice.enabled && mode !== 'EXAM' && (
          <button className="audio-unblock" title="Your browser blocked audio until you interact — click to let Monday speak"
            onClick={() => { audio.ensure(); audio.flushPending(); }}>🔇 tap to enable voice</button>
        )}
        <StatusLine
          state={monday}
          moodHistory={moodHistory}
          ctx={ctx}
          theme={theme}
          connection={status}
          elapsedMs={elapsed}
          onOpenReadiness={() => openTab('readiness', null, null, focusColRef.current)}
        />
        {/* Below ~1620px the header cannot hold the status line and every control
            on one line. Break here so it splits as identity+status / controls,
            rather than orphaning whichever buttons happen to fall off the end. */}
        <span className="hdr-break" />
        <span className="spacer" />
        <ModeSelector mode={mode} onMode={onMode} />
        <button
          className={`btn tiny spk ${voiceOn ? 'on' : ''}`}
          title={mode === 'EXAM' ? 'EXAM mode is silent' : voiceOn ? 'Monday speaks — click to silence' : 'Monday is silent — click to unmute'}
          disabled={mode === 'EXAM'}
          onClick={() => { audio.ensure(); setVoice((v) => { const next = !v.enabled; postConfig({ voice: { enabled: next } }); return { ...v, enabled: next }; }); }}
        >
          {mode === 'EXAM' ? '🔇' : voiceOn ? '🔊' : '🔈'}
        </button>
        {/* Settings opens the PANE — the full surface. The caret beside it keeps
            the quick popover, for mute / volume / stop-interrupting mid-question. */}
        <button
          className="btn tiny"
          title="Voice, prosody, model, modes, proactivity, appearance, study and data"
          onClick={() => openTab('settings', null, null, focusColRef.current)}
        >
          Settings
        </button>
        <span className="menu-wrap">
          <button className="btn tiny caret" title="Quick settings" aria-label="Quick settings" onClick={() => setSettingsOpen((s) => !s)}>▾</button>
          {settingsOpen && (
            <Settings
              voice={voice}
              proactive={proactiveCfg}
              proactiveMaster={proactiveMaster}
              mode={mode}
              onPatch={onSettingsPatch}
              onClose={() => setSettingsOpen(false)}
              onOpenPane={() => openTab('settings', null, null, focusColRef.current)}
            />
          )}
        </span>
        <span className="menu-wrap">
          <button className="btn tiny" onClick={() => setChatMenu((m) => !m)}>Chats ▾</button>
          {chatMenu && (
            <>
              <div className="menu-backdrop" onClick={() => setChatMenu(false)} />
              <div className="menu">
                <div className="menu-item" onClick={() => { onNewChat(); setChatMenu(false); }}>New chat</div>
                {chats.map((c) => (
                  <div key={c.id} className={`menu-item ${c.active ? 'on' : ''}`} onClick={() => { if (!c.active) onSwitchChat(c.id); setChatMenu(false); }}>
                    <span className="mi-col">{c.messages}</span> {c.title || 'untitled'}
                    {c.active ? <span className="mi-note"> (open)</span> : null}
                    <button className="x" onClick={(e) => { e.stopPropagation(); onDeleteChat(c.id); }}>×</button>
                  </div>
                ))}
              </div>
            </>
          )}
        </span>
        <span className="menu-wrap">
          <button className="btn tiny" onClick={() => setMenu((m) => !m)}>Tabs ▾</button>
          {menu && (
            <>
              <div className="menu-backdrop" onClick={() => setMenu(false)} />
              <div className="menu">
                {layout.columns.flatMap((c, ci) =>
                  c.tabs.map((t) => (
                    <div key={t.id} className="menu-item" onClick={() => { focusTab(t.id); setMenu(false); }}>
                      <span className="mi-col">{ci + 1}</span> {t.title}
                      {c.collapsed ? <span className="mi-note"> (hidden)</span> : null}
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </span>
        <button className="btn tiny t85-btn" onClick={() => openTab('target85', null, null, focusColRef.current)} title="distance to 8.5 (35/40) and exactly what to do before the exam">8.5+</button>
        <button className="btn tiny" onClick={() => openTab('files')}>Files</button>
        <button className="btn tiny" onClick={() => openTab('chat')}>Monday</button>
        <button className="btn tiny" onClick={() => openTab('readiness', null, null, focusColRef.current)} title="per-topic readiness, projected score, days to exam">Readiness</button>
        <button className="btn tiny" onClick={() => openTab('backlog', null, null, focusColRef.current)} title="every question waiting to be reworked">Backlog</button>
        <button className="btn tiny" onClick={() => window.open('/dashboard', '_blank')}>Dashboard</button>
        <button className="btn tiny" onClick={() => openExam()} title="sit a paper in the exam simulator — opens full screen in its own Chrome window">Exam</button>
        <button className="btn tiny" onClick={() => openPaperFlow(flowResume?.id ?? null)}
          title={flowResume ? `pick up ${flowResume.title} where you left off (Q${flowResume.current}, ${flowResume.marked}/20 marked)` : 'rework a JZ paper question by question: R2D2 video | paper → mark scheme | Y/M/N panel'}>
          {flowResume ? `🎬 Continue JZ ${flowResume.short.replace('Set ', '').replace(' Paper ', ' P')} · Q${flowResume.current}` : '🎬 JZ flow'}
        </button>
        <button className="btn tiny" onClick={() => setLayout(defaultLayout())}>Reset layout</button>
        <button
          className="btn tiny theme"
          title={appearance.theme === 'system' ? 'Following the system theme — click to pin' : 'Click to switch; the full choice, including "system", is in Settings'}
          onClick={() => onSettingsPatch({ appearance: { ...appearance, theme: theme === 'light' ? 'dark' : 'light' } })}
        >
          {theme === 'light' ? '◐ Dark' : '◑ Light'}
        </button>
        {backlogDue > 0 && (
          <BacklogBadge count={backlogDue}
            onPick={(f) => openTab('backlog', f, null, focusColRef.current)} />
        )}
        <button className="btn tiny" onClick={() => setHelp((h) => !h)}>?</button>
        <span className="cost">${cost.toFixed(2)}</span>
      </header>

      <ExamBanner mode={mode} />
      <PauseBanner mode={mode} />
      <ExamFrame mode={mode} />

      <FloatTimer timer={timer} setTimer={setTimer} mode={mode} />

      {paper && (
        <div className={`paper-bar${paper.done ? (paper.ok ? ' ok' : ' bad') : ''}`}>
          <b>{paper.done ? (paper.ok ? 'Paper added' : 'Paper') : 'Filing paper'}</b>
          <span>{paper.file}</span>
          <span className="paper-msg">{paper.text}</span>
          {paper.done && <button className="btn tiny" onClick={() => setPaper(null)}>×</button>}
        </div>
      )}

      {launcher && (
        <Launcher
          onClose={() => setLauncher(false)}
          onPick={(type, props, title) => openTab(type, props, title, focusColRef.current)}
        />
      )}

      {help && (
        <div className="help-backdrop" onClick={() => setHelp(false)}>
          <div className="help-card" onClick={(e) => e.stopPropagation()}>
            <h3>SHORTCUTS</h3>
            <table>
              <tbody>
                <tr><td>⌘T</td><td>new tab — pick what to open</td></tr>
                <tr><td>⌘W</td><td>close active tab in focused pane</td></tr>
                <tr><td>⌘S</td><td>toggle sidebar (FILES)</td></tr>
                <tr><td>⌘S in editor</td><td>save file</td></tr>
                <tr><td>⌘D</td><td>light / dark theme</td></tr>
                <tr><td>⌘,</td><td>open the settings pane</td></tr>
                <tr><td>⌥1–9</td><td>expand column n</td></tr>
                <tr><td>⌥T</td><td>bring the floating timer back to the top right</td></tr>
                <tr><td>⌘/</td><td>this help</td></tr>
                <tr><td>ESC</td><td>close menus</td></tr>
                <tr><td>ENTER / ⇧ENTER</td><td>send / newline in chat</td></tr>
              </tbody>
            </table>
            <p>Drag tabs between groups, or to a pane's left/right edge to split. Drag dividers to resize; double-click one to split the pair evenly. ▁ collapses a column; drop a tab on a collapsed strip to stack it there. TABS ▾ lists everything open.</p>
          </div>
        </div>
      )}

      <div className="cols" ref={colsRef}>
        {(() => { const grow = growWeights(layout.columns); return layout.columns.map((col, ci) => {
          const prev = layout.columns[ci - 1];
          return (
            <React.Fragment key={col.id}>
              {ci > 0 && (prev && !prev.collapsed && !col.collapsed ? (
                <div
                  className="resizer"
                  title="Drag to resize · double-click to split evenly"
                  onMouseDown={(e) => startResize(e, prev.id, col.id)}
                  onDoubleClick={() => equalisePair(prev.id, col.id)}
                />
              ) : (
                <div className="resizer static" />
              ))}
              {col.collapsed ? (
                <div
                  className={`col collapsed ${hint?.colId === col.id ? 'drop-on' : ''}`}
                  title={`Expand · ${col.tabs.map((t) => t.title).join(', ')}`}
                  onClick={() => mutate((L) => { const c = L.columns.find((x) => x.id === col.id); if (c) c.collapsed = false; })}
                  onDragOver={(e) => { if (drag) { e.preventDefault(); setHint({ colId: col.id, zone: 'stack' }); } }}
                  onDragLeave={() => setHint((h) => (h?.colId === col.id ? null : h))}
                  onDrop={(e) => { if (drag) { e.preventDefault(); moveTab(drag.tabId, col.id, 'stack'); setDrag(null); setHint(null); } }}
                >
                  <span className="vlabel">{col.tabs.map((t) => t.title).join(' · ')}</span>
                </div>
              ) : (
                <div
                  className={`col ${focusCol === col.id ? 'focused' : ''}`}
                  // Long-hand, not the `flex` shorthand: an invalid value in a
                  // shorthand takes the whole declaration with it, while these
                  // three are independent. growWeights sanitises each weight and
                  // scales the open columns to sum to at least 1 — below 1, flex
                  // leaves the remainder of the row blank.
                  style={{ flexGrow: grow[col.id], flexShrink: 1, flexBasis: '0%' }}
                  onMouseDownCapture={() => setFocusCol(col.id)}
                >
                  <div
                    className="tabbar"
                    onDragOver={(e) => { if (drag) { e.preventDefault(); setHint({ colId: col.id, zone: 'stack' }); } }}
                    onDrop={(e) => { if (drag) { e.preventDefault(); moveTab(drag.tabId, col.id, 'stack'); setDrag(null); setHint(null); } }}
                  >
                    {col.tabs.map((tab) => (
                      <span
                        key={tab.id}
                        className={`tab ${col.active === tab.id ? 'active' : ''}`}
                        draggable
                        onDragStart={(e) => { e.dataTransfer.setData('text/plain', tab.id); setDrag({ tabId: tab.id, fromCol: col.id }); }}
                        onDragEnd={() => { setDrag(null); setHint(null); }}
                        onClick={() => mutate((L) => { const c = L.columns.find((x) => x.id === col.id); if (c) c.active = tab.id; })}
                        /* Middle-click closes, the way every browser and editor does it.
                           onAuxClick rather than onMouseDown so a middle-drag that ends
                           elsewhere does not close the tab under the cursor; preventDefault
                           stops the browser's autoscroll cursor appearing. */
                        onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); e.stopPropagation(); closeTab(tab.id); } }}
                        onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
                        title={tab.props?.path ?? tab.title}
                      >
                        <span className="tab-label">{tab.title}</span>
                        <button className="x" onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}>×</button>
                      </span>
                    ))}
                    <span className="tabbar-end">
                      <button className="x" title="collapse" onClick={() => mutate((L) => { const c = L.columns.find((x) => x.id === col.id); if (c) c.collapsed = true; })}>▁</button>
                    </span>
                  </div>
                  <div className="col-body">
                    {col.tabs.map((tab) => (
                      <div key={tab.id} className="tab-holder" style={{ display: col.active === tab.id ? 'flex' : 'none' }}>
                        {renderTab(tab)}
                      </div>
                    ))}
                    {drag && (
                      <div
                        className="drop-catcher"
                        onDragOver={(e) => { e.preventDefault(); setHint({ colId: col.id, zone: zoneFromEvent(e) }); }}
                        onDragLeave={() => setHint((h) => (h?.colId === col.id ? null : h))}
                        onDrop={(e) => { e.preventDefault(); moveTab(drag.tabId, col.id, zoneFromEvent(e)); setDrag(null); setHint(null); }}
                      />
                    )}
                    {hint?.colId === col.id && <div className={`snap snap-${hint.zone}`} />}
                  </div>
                </div>
              )}
            </React.Fragment>
          );
        }); })()}
        {!layout.columns.some((c) => !c.collapsed) && (
          <div className="cols-empty">
            <p>{layout.columns.length ? 'Every pane is collapsed.' : 'No panes open.'}</p>
            <div className="cols-empty-actions">
              {layout.columns.length > 0 && (
                <button className="btn tiny" onClick={() => mutate((L) => { L.columns.forEach((c) => { c.collapsed = false; }); })}>Expand all</button>
              )}
              <button className="btn tiny" onClick={() => setLauncher(true)}>New tab ⌘T</button>
              <button className="btn tiny" onClick={() => setLayout(defaultLayout())}>Reset layout</button>
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
