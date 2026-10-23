// ═══════════════ MONDAY — SETTINGS pane ═══════════════
//
// A real pane, not a popover: it tiles, drags, stacks and persists like every
// other tab, because this is a surface you sit in and adjust, not one you poke
// at through a 320px menu.
//
// Two rules run through the whole file:
//
//   1. EVERY CONTROL IS WIRED. Nothing here is a placeholder. If a value cannot
//      be made to do something, it is not drawn.
//   2. THE SERVER IS THE TRUTH. Writes go through `onPatch` → POST /api/config,
//      which validates and clamps, and the `config` event comes back with what
//      was actually stored. Locally optimistic, server-corrected.
//
// Everything is styled from tokens.css. There are no colours in this file.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PROACTIVE_TRIGGERS, MODES, MODE_HINT, MOODS, MOOD_MANNER,
  MODELS, EFFORTS, THEMES, DENSITIES, FONT_SIZES, GATE_LABELS,
  SPEECH_RANGE, RATE_LIMIT_RANGE, DEFAULT_SPEECH, DEFAULT_APPEARANCE,
  moodColor, moodInk, bytes,
} from './constants.js';

// ── primitives ───────────────────────────────────────────────────────────────
// Every control has a label and exactly one line saying what it does. That line
// is the point of the pane: a switch whose effect you have to guess is a switch
// you leave alone.

function Row({ label, hint, disabled, children, wide }) {
  return (
    <div className={`sp-row ${disabled ? 'off' : ''} ${wide ? 'wide' : ''}`}>
      <div className="sp-row-text">
        <span className="sp-row-label">{label}</span>
        {hint && <span className="sp-row-hint">{hint}</span>}
      </div>
      <div className="sp-row-ctl">{children}</div>
    </div>
  );
}

function Toggle({ on, disabled, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!on}
      aria-label={label}
      className={`sw ${on ? 'on' : ''}`}
      disabled={disabled}
      onClick={() => !disabled && onChange(!on)}
    >
      <span className="sw-knob" />
    </button>
  );
}

function SwitchRow({ label, hint, on, disabled, onChange }) {
  return (
    <Row label={label} hint={hint} disabled={disabled}>
      <Toggle on={on} disabled={disabled} onChange={onChange} label={label} />
    </Row>
  );
}

/** A slider with its live value in mono beside it. `fmt` renders the readout. */
function SliderRow({ label, hint, value, min, max, step, disabled, onChange, fmt, onCommit }) {
  const v = Number.isFinite(Number(value)) ? Number(value) : min;
  return (
    <Row label={label} hint={hint} disabled={disabled}>
      <span className="sp-slider">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={v}
          disabled={disabled}
          aria-label={label}
          onChange={(e) => onChange(Number(e.target.value))}
          onMouseUp={() => onCommit?.()}
          onKeyUp={() => onCommit?.()}
          onTouchEnd={() => onCommit?.()}
        />
        <span className="sp-num tabular">{fmt ? fmt(v) : v}</span>
      </span>
    </Row>
  );
}

/** A segmented choice. Used wherever the options are few and worth reading. */
function Choice({ options, value, onChange, disabled, label }) {
  return (
    <span className="sp-seg" role="radiogroup" aria-label={label}>
      {options.map(([key, text, hint]) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={value === key}
          className={`btn tiny ${value === key ? 'on' : ''}`}
          title={hint ?? text}
          disabled={disabled}
          onClick={() => onChange(key)}
        >
          {text}
        </button>
      ))}
    </span>
  );
}

function Section({ id, title, blurb, children, right }) {
  return (
    <section className="sp-section" id={`sp-${id}`}>
      <header className="sp-section-head">
        <h2 className="sp-section-title">{title}</h2>
        {right}
      </header>
      {blurb && <p className="sp-section-blurb">{blurb}</p>}
      <div className="sp-section-body">{children}</div>
    </section>
  );
}

// ── the pane ─────────────────────────────────────────────────────────────────

const SECTIONS = [
  ['voice', 'Voice'],
  ['model', 'Model'],
  ['modes', 'Modes'],
  ['proactivity', 'Proactivity'],
  ['appearance', 'Appearance'],
  ['study', 'Study'],
  ['data', 'Data'],
];

export default function SettingsPane({
  voice, speech, proactive, proactiveMaster, rateLimitMin, appearance,
  config, mode, theme, targetScore, onPatch, onMode, onOpenReadiness,
}) {
  // Server-supplied facts the pane cannot invent: what each mode really gates,
  // the live voice worker status, where the data lives and how big it is.
  const [meta, setMeta] = useState(null);
  const [data, setData] = useState(null);
  const [exam, setExam] = useState(null);       // { examDate, present, source }
  const [examDraft, setExamDraft] = useState('');
  const [note, setNote] = useState('');         // the one-line result strip
  const [busy, setBusy] = useState('');

  const sp = { ...DEFAULT_SPEECH, ...(speech ?? {}) };
  const ap = { ...DEFAULT_APPEARANCE, ...(appearance ?? {}) };
  const gates = meta?.modeGates ?? null;
  const examLocked = mode === 'EXAM';
  const voiceOn = !!voice?.enabled && !examLocked;

  const say = useCallback((text) => {
    setNote(text);
    const t = setTimeout(() => setNote(''), 6000);
    return () => clearTimeout(t);
  }, []);

  const loadMeta = useCallback(() => {
    fetch('/api/config')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setMeta)
      .catch(() => setMeta(null));
  }, []);
  const loadData = useCallback(() => {
    fetch('/api/data-stats')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setData)
      .catch(() => setData(null));
  }, []);
  const loadExam = useCallback(() => {
    fetch('/api/exam-date')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { setExam(d); setExamDraft(d.examDate ?? ''); })
      .catch(() => setExam(null));
  }, []);

  useEffect(() => { loadMeta(); loadData(); loadExam(); }, [loadMeta, loadData, loadExam]);

  // ── writers ────────────────────────────────────────────────────────────────
  const patchSpeech = (p) => onPatch({ speech: { ...sp, ...p } });
  const patchProsody = (mood, p) =>
    onPatch({ speech: { ...sp, prosody: { ...sp.prosody, [mood]: { ...(sp.prosody?.[mood] ?? { rate: 1, pause: 1 }), ...p } } } });

  async function testVoice(mood) {
    setBusy('speak');
    try {
      const r = await fetch('/api/speak', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          // Deliberately a line with maths in it: the pauses around a $…$ span
          // are the single most audible thing the prosody settings control.
          text: `Right. Given $f(x) = \\frac{x^2-1}{x-2}$, find $f'(2)$. Take your time.`,
          mood,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) say(`Nothing said — ${d.error ?? `HTTP ${r.status}`}.`);
      else if (meta && !meta.voice?.ready) {
        // The server accepts the request whether or not the worker is up, so the
        // panel has to be the one that does not pretend. Refresh first: the
        // worker may simply have finished loading since the pane opened.
        loadMeta();
        say(`Queued a line in ${mood}, but the voice worker is ${meta.voice?.status ?? 'not running'} — ${meta.voice?.reason || 'nothing will be heard'}.`);
      } else say(`Speaking a line in ${mood}.`);
    } catch {
      say('Could not reach the server.');
    } finally {
      setBusy('');
    }
  }

  async function saveExamDate() {
    setBusy('exam');
    try {
      const r = await fetch('/api/exam-date', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ date: examDraft }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) say(`Exam date refused — ${d.error ?? `HTTP ${r.status}`}.`);
      else {
        say(d.changed ? `Exam date set to ${d.examDate} in session_memory.json.` : 'That was already the date.');
        loadExam(); loadMeta();
      }
    } catch {
      say('Could not reach the server.');
    } finally {
      setBusy('');
    }
  }

  async function clearCache() {
    if (!window.confirm('Delete every rendered audio file? Monday re-synthesises them as it speaks; nothing else is touched.')) return;
    setBusy('cache');
    try {
      const r = await fetch('/api/voice-cache/clear', { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) say(`Cache not cleared — ${d.error ?? `HTTP ${r.status}`}.`);
      else { say(`Cleared ${d.removed} audio file${d.removed === 1 ? '' : 's'}, ${bytes(d.bytes)} freed.`); loadData(); }
    } catch {
      say('Could not reach the server.');
    } finally {
      setBusy('');
    }
  }

  const days = useMemo(() => {
    const d = Date.parse(`${exam?.examDate ?? ''}T00:00:00`);
    if (!Number.isFinite(d)) return null;
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    return Math.max(0, Math.round((d - midnight.getTime()) / 86400000));
  }, [exam]);

  return (
    <div className="tab-fill sp-tab">
      <div className="pane-toolbar sp-bar">
        <span className="sp-title">Settings</span>
        <nav className="sp-jump">
          {SECTIONS.map(([id, label]) => (
            <a key={id} className="sp-jump-link" href={`#sp-${id}`}
              onClick={(e) => { e.preventDefault(); document.getElementById(`sp-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>
              {label}
            </a>
          ))}
        </nav>
        <span className="quick-spacer" />
        <button className="btn tiny" onClick={() => { loadMeta(); loadData(); loadExam(); }}>Refresh</button>
      </div>

      {note && <div className="sp-note">{note}</div>}
      {examLocked && (
        <div className="sp-lock">
          EXAM is running. Voice and interruptions are forced off in code, not by
          request — the switches below stay where you left them and come back when it ends.
        </div>
      )}

      <div className="pane-body sp-body">

        {/* ═══ VOICE ═══ */}
        <Section
          id="voice"
          title="Voice"
          blurb="Monday's voice is synthesised locally. Nothing here leaves the machine, and every one of these settings reaches the synthesiser on the next sentence — no restart."
          right={meta?.voice && (
            <span
              className={`sp-badge ${meta.voice.ready ? 'ok' : 'warn'}`}
              title={meta.voice.reason || meta.voice.status}
            >
              {meta.voice.ready ? `worker ready · ${meta.voice.device ?? 'cpu'}` : `running silent · ${meta.voice.status}`}
            </span>
          )}
        >
          <SwitchRow
            label="Monday speaks"
            hint={examLocked ? 'Forced silent while EXAM is running.' : 'Reads its replies aloud as they are written.'}
            on={voiceOn}
            disabled={examLocked}
            onChange={(v) => onPatch({ voice: { enabled: v } })}
          />
          <SliderRow
            label="Volume"
            hint="Playback level in this browser. Does not affect the recording."
            value={voice?.volume ?? 0.9}
            min={0} max={1} step={0.05}
            disabled={!voiceOn}
            fmt={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => onPatch({ voice: { volume: v } })}
          />
          <SliderRow
            label="Speaking rate"
            hint="Scales every mood at once. 1.00 is the tuned preset; below 0.9 it starts to sound laboured."
            value={sp.rate}
            min={SPEECH_RANGE.rate[0]} max={SPEECH_RANGE.rate[1]} step={0.05}
            disabled={!voiceOn}
            fmt={(v) => `${v.toFixed(2)}×`}
            onChange={(v) => patchSpeech({ rate: v })}
          />
          <SwitchRow
            label="Speak long explanations"
            hint={sp.longForm
              ? 'On: Monday reads a whole answer, however long it runs.'
              : `Off: it speaks the first ${sp.maxChars} characters of a reply and then goes quiet — the rest is written only.`}
            on={sp.longForm}
            disabled={!voiceOn}
            onChange={(v) => patchSpeech({ longForm: v })}
          />
          <SliderRow
            label="Spoken length cap"
            hint="How much of a long reply gets said out loud before it falls silent. Only applies with the switch above off."
            value={sp.maxChars}
            min={SPEECH_RANGE.maxChars[0]} max={1600} step={20}
            disabled={!voiceOn || sp.longForm}
            fmt={(v) => `${v} chars`}
            onChange={(v) => patchSpeech({ maxChars: v })}
          />

          <div className="sp-sub">
            <div className="sp-sub-head">
              <span className="eyebrow">Per-mood prosody</span>
              <span className="sp-sub-note">
                Monday's six moods are different voices, not one voice at different speeds.
                Rate stretches the mood's own pace; pauses stretch its silences — the beat around
                a maths span is where most of the intelligibility lives.
              </span>
            </div>
            <div className="sp-prosody-head">
              <span />
              <span className="sp-col-label">Rate</span>
              <span className="sp-col-label">Pauses</span>
              <span />
            </div>
            {MOODS.map((m) => {
              const p = sp.prosody?.[m] ?? { rate: 1, pause: 1 };
              const c = moodColor(m, theme);
              return (
                <div className="sp-prosody" key={m}>
                  <span className="sp-mood" style={{ background: c, color: moodInk(m, theme) }} title={MOOD_MANNER[m]}>{m}</span>
                  {/* The column headings above vanish once the pane is narrow
                      enough to stack these, so each slider carries its own tag
                      that appears exactly when the heading disappears. */}
                  <span className="sp-slider tight">
                    <span className="sp-tag">rate</span>
                    <input
                      type="range" min={SPEECH_RANGE.rate[0]} max={SPEECH_RANGE.rate[1]} step={0.05}
                      value={p.rate} disabled={!voiceOn}
                      aria-label={`${m} speaking rate`}
                      title={`${m} speaking rate`}
                      onChange={(e) => patchProsody(m, { rate: Number(e.target.value) })}
                    />
                    <span className="sp-num tabular">{Number(p.rate).toFixed(2)}</span>
                  </span>
                  <span className="sp-slider tight">
                    <span className="sp-tag">pauses</span>
                    <input
                      type="range" min={SPEECH_RANGE.pause[0]} max={SPEECH_RANGE.pause[1]} step={0.1}
                      value={p.pause} disabled={!voiceOn}
                      aria-label={`${m} pause length`}
                      title={`${m} pause length`}
                      onChange={(e) => patchProsody(m, { pause: Number(e.target.value) })}
                    />
                    <span className="sp-num tabular">{Number(p.pause).toFixed(1)}</span>
                  </span>
                  <button
                    className="btn tiny"
                    disabled={!voiceOn || busy === 'speak'}
                    title={`Speak a line of maths in ${m}`}
                    onClick={() => testVoice(m)}
                  >
                    Test
                  </button>
                </div>
              );
            })}
            <div className="sp-actions">
              <button
                className="btn tiny"
                disabled={!voiceOn}
                onClick={() => onPatch({ speech: { ...sp, rate: 1, prosody: Object.fromEntries(MOODS.map((m) => [m, { rate: 1, pause: 1 }])) } })}
              >
                Reset prosody
              </button>
              <span className="sp-actions-note">Back to the tuned presets in tts/prosody.py.</span>
            </div>
          </div>
        </Section>

        {/* ═══ MODEL ═══ */}
        <Section
          id="model"
          title="Model"
          blurb="Which model answers, and how hard it thinks first. Changing either ends the live session; the next message resumes it with the new settings, so nothing in the conversation is lost."
        >
          <Row label="Model" hint={MODELS.find(([k]) => k === config?.model)?.[2] ?? 'the model behind Monday'} wide>
            <Choice label="Model" options={MODELS} value={config?.model} onChange={(v) => onPatch({ model: v })} />
          </Row>
          <Row label="Reasoning effort" hint={EFFORTS.find(([k]) => k === config?.effort)?.[2] ?? 'how long it thinks before answering'} wide>
            <Choice label="Effort" options={EFFORTS} value={config?.effort} onChange={(v) => onPatch({ effort: v })} />
          </Row>
        </Section>

        {/* ═══ MODES ═══ */}
        <Section
          id="modes"
          title="Modes"
          blurb="A mode is enforced in code, not by asking Monday nicely. The ticks below are read from the server's own gate table, so this cannot describe a rule that is not real."
        >
          {MODES.map((m) => {
            const g = gates?.[m];
            return (
              <div key={m} className={`sp-mode ${mode === m ? 'on' : ''}`}>
                <button className={`btn tiny m-${m.toLowerCase()} ${mode === m ? 'on' : ''}`} onClick={() => onMode(m)}>{m}</button>
                <div className="sp-mode-text">
                  <span className="sp-mode-hint">{meta?.modeBlurbs?.[m] ?? MODE_HINT[m]}</span>
                  <span className="sp-gates">
                    {g
                      ? GATE_LABELS.map(([k, label]) => (
                        <span key={k} className={`sp-gate ${g[k] ? 'yes' : 'no'}`}>{g[k] ? '✓' : '✕'} {label}</span>
                      ))
                      : <span className="sp-gate">gates unavailable — the server did not answer</span>}
                  </span>
                </div>
              </div>
            );
          })}
        </Section>

        {/* ═══ PROACTIVITY ═══ */}
        <Section
          id="proactivity"
          title="Proactivity"
          blurb="Monday raising something you did not ask about. Nothing fires unless its own switch is on — there is no trigger that overrides its toggle, and all of them are suppressed in EXAM."
        >
          <SwitchRow
            label="Monday may interrupt"
            hint={examLocked ? 'All triggers are suppressed while EXAM runs.' : 'The master switch. Off means never, whatever the individual switches say.'}
            on={!!proactiveMaster && !examLocked}
            disabled={examLocked}
            onChange={(v) => onPatch({ proactiveEnabled: v })}
          />
          <SliderRow
            label="Minimum gap between interruptions"
            hint="A global floor, however many triggers are due at once. It cannot be switched off — only widened."
            value={rateLimitMin ?? 10}
            min={RATE_LIMIT_RANGE[0]} max={120} step={1}
            disabled={!proactiveMaster || examLocked}
            fmt={(v) => (v >= 60 ? `${(v / 60).toFixed(1)} h` : `${v} min`)}
            onChange={(v) => onPatch({ proactiveRateLimitMin: v })}
          />
          <div className="sp-sub">
            <div className="sp-sub-head"><span className="eyebrow">The seven triggers</span></div>
            {PROACTIVE_TRIGGERS.map(([key, label, hint]) => (
              <SwitchRow
                key={key}
                label={label}
                hint={hint}
                on={!!proactive?.[key]}
                disabled={!proactiveMaster || examLocked}
                onChange={(v) => onPatch({ proactive: { ...proactive, [key]: v } })}
              />
            ))}
            <div className="sp-actions">
              <button
                className="btn tiny"
                disabled={examLocked}
                onClick={() => onPatch({ proactive: Object.fromEntries(PROACTIVE_TRIGGERS.map(([k]) => [k, false])) })}
              >
                Turn all off
              </button>
              <button
                className="btn tiny"
                disabled={examLocked}
                onClick={() => onPatch({ proactive: Object.fromEntries(PROACTIVE_TRIGGERS.map(([k, , , d]) => [k, d])) })}
              >
                Restore defaults
              </button>
              <span className="sp-actions-note">Defaults have late night off; it was your call to make.</span>
            </div>
          </div>
        </Section>

        {/* ═══ APPEARANCE ═══ */}
        <Section
          id="appearance"
          title="Appearance"
          blurb="Stored on the server with everything else, so the shell looks the same on the next machine as it does on this one."
        >
          <Row label="Theme" hint={THEMES.find(([k]) => k === ap.theme)?.[2]} wide>
            <Choice label="Theme" options={THEMES} value={ap.theme} onChange={(v) => onPatch({ appearance: { ...ap, theme: v } })} />
          </Row>
          <Row label="Density" hint={DENSITIES.find(([k]) => k === ap.density)?.[2]} wide>
            <Choice label="Density" options={DENSITIES} value={ap.density} onChange={(v) => onPatch({ appearance: { ...ap, density: v } })} />
          </Row>
          <Row label="Font size" hint={FONT_SIZES.find(([k]) => k === ap.fontSize)?.[2]} wide>
            <Choice label="Font size" options={FONT_SIZES} value={ap.fontSize} onChange={(v) => onPatch({ appearance: { ...ap, fontSize: v } })} />
          </Row>
          <p className="sp-foot">
            Density and font size work by redefining the spacing and type tokens on the root
            element, so every pane follows — including ones written after this setting existed.
          </p>
        </Section>

        {/* ═══ STUDY ═══ */}
        <Section
          id="study"
          title="Study"
          blurb="The two numbers the whole readiness model hangs off."
          right={days != null && <span className={`sp-badge ${days <= 30 ? 'warn' : ''}`}>{days} days out</span>}
        >
          <Row
            label="Exam date"
            hint={exam
              ? (exam.present
                ? 'Written into tutor_data/memory/session_memory.json — the one record the dashboard and the readiness model both read. There is no second copy.'
                : 'The record carries no date yet, so this is the built-in fallback. Saving writes a real one.')
              : 'Could not read the record.'}
            wide
          >
            <span className="sp-inline">
              <input
                type="date"
                className="sp-date"
                value={examDraft}
                aria-label="Exam date"
                onChange={(e) => setExamDraft(e.target.value)}
              />
              <button
                className="btn tiny save"
                disabled={busy === 'exam' || !examDraft || examDraft === exam?.examDate}
                onClick={saveExamDate}
              >
                {busy === 'exam' ? 'Saving…' : 'Save'}
              </button>
              {examDraft !== (exam?.examDate ?? '') && (
                <button className="btn tiny" onClick={() => setExamDraft(exam?.examDate ?? '')}>Cancel</button>
              )}
            </span>
          </Row>
          <SliderRow
            label="Target score"
            hint="The TMUA score the readiness pane measures you against, and the trajectory it expects on the way there."
            value={targetScore ?? 9}
            min={1} max={9} step={0.1}
            fmt={(v) => v.toFixed(1)}
            onChange={(v) => onPatch({ targetScore: v })}
          />
          <div className="sp-actions">
            <button className="btn tiny" onClick={() => onOpenReadiness?.()}>Open readiness</button>
            <span className="sp-actions-note">See what those two numbers currently produce.</span>
          </div>
        </Section>

        {/* ═══ DATA ═══ */}
        <Section
          id="data"
          title="Data"
          blurb="Where everything lives on disk. The only thing this pane will delete is the rendered audio, which is regenerable by definition."
          right={<button className="btn tiny" onClick={loadData}>Recount</button>}
        >
          {!data && <div className="sp-empty">Could not read the data stats.</div>}
          {data && (
            <>
              <Row label="Chat archive" hint={`${data.chats.files} conversation${data.chats.files === 1 ? '' : 's'} kept in full, every event recorded. Nothing here is ever deleted automatically.`}>
                <span className="sp-num tabular">{bytes(data.chats.bytes)}</span>
              </Row>
              <Row label="Voice cache" hint="Rendered audio, keyed by the exact prosody plan. Clearing it costs re-synthesis time and nothing else.">
                <span className="sp-inline">
                  <span className="sp-num tabular">{data.voiceCache.files} files · {bytes(data.voiceCache.bytes)}</span>
                  <button className="btn tiny stop" disabled={busy === 'cache' || !data.voiceCache.files} onClick={clearCache}>
                    {busy === 'cache' ? 'Clearing…' : 'Clear'}
                  </button>
                </span>
              </Row>
              <Row label="Settings file" hint="Every switch on this page, persisted here.">
                <span className="sp-num tabular">{bytes(data.state.bytes)}</span>
              </Row>

              <div className="sp-sub">
                <div className="sp-sub-head"><span className="eyebrow">Paths</span></div>
                <dl className="sp-paths">
                  {[
                    ['Project root', data.paths.projectRoot],
                    ['Tutor data', data.paths.tutorData],
                    ['Student record', data.paths.sessionMemory],
                    ['Inbox', data.paths.inbox],
                    ['Chats', data.paths.chats],
                    ['Settings', data.paths.state],
                    ['Voice cache', data.paths.voiceCache],
                  ].map(([label, p]) => (
                    <React.Fragment key={label}>
                      <dt>{label}</dt>
                      <dd title={p}>{p}</dd>
                    </React.Fragment>
                  ))}
                </dl>
              </div>

              <div className="sp-actions">
                <button className="btn tiny" onClick={() => window.open('/dashboard', '_blank')}>Open dashboard</button>
                <span className="sp-actions-note">The published progress report, rebuilt every couple of turns.</span>
              </div>
            </>
          )}
        </Section>

        <p className="sp-tail">
          Every setting on this page is stored on the server and validated there before it is
          kept — the panel cannot put a value into the config that the server has not agreed to.
        </p>
      </div>
    </div>
  );
}
