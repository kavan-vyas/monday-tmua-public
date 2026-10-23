// Route root for /exam — a computer-based test driver for sitting TMUA-style papers.
//
// The run, screen by screen:
//   prestart (choose papers)  → Start Test: full screen + "Loading, please wait…"
//   Welcome / NDA            → Next
//   Overview                 → 1-minute instructions clock (yellow: under 5:00)
//   Paper N intro            → same instructions clock; runs out ⇒ the paper starts
//   Paper N questions        → the paper clock; Next past the last question ⇒ Review
//   Review                   → End Review (two-step confirm) ⇒ paper N is finished
//   Interval (N=1 of 2)      → "Paper 1 is over… Paper 2 will start in 5 minutes", Start Paper 2
//   Final screen             → Finish ⇒ the analysis page
// Every change of screen passes through the driver's blur-and-spinner beat.
//
// Invariants carried over from the old simulator:
//  1. The answer key never reaches the browser during a paper — except, on demand, for
//     one question at a time when the student switched Explain Answer on.
//  2. Losing telemetry must never lose an answer: answers have their own route.
//  3. Time running out does not end a paper. The clock reads "Time Expired", the moment
//     is logged, and he keeps working until he ends it (his choice, 3 Oct).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Driver from './pv/Driver.jsx';
import SpinnerOverlay, { DeliveryLoading } from './pv/Spinner.jsx';
import { MessageDialog, DlgButton, NavigatorDialog, InstructionsDialog, SolutionDialog, statusOf } from './pv/Dialogs.jsx';
import { WelcomeScreen, OverviewScreen, IntroScreen, ItemScreen, ReviewScreen } from './pv/Screens.jsx';
import { loadDriverCss, applyScheme } from './pv/assets.js';
import { loadMathJax, texToHtml, refreshMathStyles } from './pv/mathjax.js';
import Setup from './Setup.jsx';
import { useExamClock } from './useExamClock.js';
import * as tele from './telemetry.js';

const BEAT_MS = 700;            // page change: blur + spinner
const BIG_BEAT_MS = 1600;       // starting or ending a paper takes longer, as on the real one
const INSTRUCTIONS_SEC = 60;
const INTERVAL_SEC = 5 * 60;

const post = async (url, body) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
};
const get = async (url) => {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
};

const enterFullscreen = () => {
  const el = document.documentElement;
  if (!document.fullscreenElement && el.requestFullscreen) el.requestFullscreen().catch(() => {});
};
const leaveFullscreen = () => { if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); };

/** A countdown to a fixed deadline, in whole seconds. */
function useCountdown(deadlineMs) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!deadlineMs) return undefined;
    const id = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [deadlineMs]);
  return deadlineMs ? Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000)) : null;
}

// The break between papers, remembered per run so closing the window doesn't lose it.
const holdBreak = (groupId, left) => {
  if (!groupId) return;
  try { if (left == null) localStorage.removeItem(`pv-break-${groupId}`); else localStorage.setItem(`pv-break-${groupId}`, String(left)); } catch { /* private */ }
};
const heldBreak = (groupId) => {
  try { const v = Number(localStorage.getItem(`pv-break-${groupId}`)); return Number.isFinite(v) && v > 0 ? v : null; } catch { return null; }
};

const fmtDialog = (s, n) => s.replace('${incompleteItems}', String(n));
const TXT = {
  endExam: 'You have chosen to end this exam.<br/><br/>Are you sure you want to end this exam?',
  endPaper: (done, next) => `You have chosen to end ${done}.<br/><br/>${next} will start after a 5-minute break, which you can pause or skip.<br/><br/>Are you sure you want to end ${done}?`,
  endReview1Complete: 'You have chosen to end the current review.  If you click<br/>Yes, you will NOT be able to return to this review.<br/><br/>Are you sure you want to end this review?',
  endReview2Complete: 'Please confirm that you want to end this review.  If you click<br/>Yes, you will NOT be able to return to this review.<br/><br/>Are you sure you want to end this review?',
  endReview1Incomplete: 'You have chosen to end the current review, but have<br/>${incompleteItems} incomplete questions.  If you click Yes, you will NOT<br/>be able to return to this review.<br/><br/>Are you sure you want to end this review?',
  endReview2Incomplete: 'Please confirm that you want to end this review.  If you click<br/>Yes, you will NOT be able to return to this review and answer<br/>the ${incompleteItems} questions you have not completed.<br/><br/>Are you sure you want to end this review?',
};

export default function ExamApp() {
  const [phase, setPhase] = useState('boot');     // boot | setup | starting | run
  const [papers, setPapers] = useState([]);
  const [unfinished, setUnfinished] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [scheme, setScheme] = useState(() => { try { return localStorage.getItem('pv-scheme') || 'Default'; } catch { return 'Default'; } });

  const [plan, setPlan] = useState(null);         // { sections:[{paperId,name,count,durationSec}], opts, groupId }
  const [screen, setScreen] = useState(null);     // { kind, sec }
  const [beat, setBeat] = useState(false);
  const [sitting, setSitting] = useState(null);   // current paper's payload from the server
  const [doneIds, setDoneIds] = useState([]);
  const [endExamOpen, setEndExamOpen] = useState(false);
  const [instrDeadline, setInstrDeadline] = useState(null);
  const [intervalDeadline, setIntervalDeadline] = useState(null);
  const [intervalHeld, setIntervalHeld] = useState(null);   // seconds left while the break is paused
  const [timerHidden, setTimerHidden] = useState(false);
  const [counterHidden, setCounterHidden] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => { loadDriverCss(); loadMathJax().catch(() => {}); }, []);
  useEffect(() => { applyScheme(scheme); try { localStorage.setItem('pv-scheme', scheme); } catch { /* private */ } }, [scheme]);
  useEffect(() => tele.attach(rootRef.current), [phase, screen?.kind]);

  // ── boot: resume ?id= straight into its paper, else the prestart page ────────
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('id');
    (async () => {
      try {
        if (id) {
          const data = await get(`/api/exam/sitting?id=${encodeURIComponent(id)}`);
          const list = (await get('/api/exam/papers')).papers ?? [];
          if (data.sitting.status === 'finished') {
            // Paper 1 of a two-paper run is over and Paper 2 never started: back to the
            // break (paused, so a closed laptop doesn't eat it), not to the answers.
            const s = data.sitting;
            const planIds = s.plan?.length ? s.plan : [s.paperId];
            const sec = planIds.indexOf(s.paperId);
            const group = s.groupId
              ? ((await get(`/api/exam/sittings?group=${encodeURIComponent(s.groupId)}`).catch(() => ({}))).sittings ?? []) : [];
            const nextStarted = group.some((x) => x.paperId === planIds[sec + 1]);
            if (sec >= 0 && sec + 1 < planIds.length && !nextStarted) {
              setPapers(list);
              setPlan({
                groupId: s.groupId ?? null,
                opts: { timing: s.timing, shuffle: s.shuffle, extraTime: s.extraTime, explain: s.explain, allowPause: s.allowPause },
                sections: planIds.map((pid) => {
                  const p = list.find((x) => x.id === pid);
                  return { paperId: pid, name: `Paper ${p?.paper ?? 1}`, count: p?.questions ?? 20, durationSec: s.durationSec };
                }),
              });
              setDoneIds(group.filter((x) => x.status === 'finished').map((x) => x.id));
              setIntervalHeld(heldBreak(s.groupId) ?? INTERVAL_SEC);
              setScreen({ kind: 'interval', sec });
              setPhase('run');
              return;
            }
            const ids = group.filter((x) => x.status === 'finished').map((x) => x.id);
            window.location.replace(`/exam/report?ids=${(ids.length ? ids : [id]).map(encodeURIComponent).join(',')}`);
            return;
          }
          setPapers(list);
          const s = data.sitting;
          const planIds = s.plan?.length ? s.plan : [s.paperId];
          setPlan({
            groupId: s.groupId ?? null,
            opts: { timing: s.timing, shuffle: s.shuffle, extraTime: s.extraTime, explain: s.explain, allowPause: s.allowPause },
            sections: planIds.map((id) => {
              const p = list.find((x) => x.id === id);
              return { paperId: id, name: `Paper ${p?.paper ?? 1}`, count: p?.questions ?? 20, durationSec: s.durationSec };
            }),
          });
          // Papers of this run that are already over, so the report shows the whole test.
          if (s.groupId) {
            try {
              const done = ((await get(`/api/exam/sittings?group=${encodeURIComponent(s.groupId)}`)).sittings ?? [])
                .filter((x) => x.status === 'finished' && x.id !== s.id).map((x) => x.id);
              setDoneIds(done);
            } catch { /* the report can live without them */ }
          }
          setSitting(data);
          setScreen({ kind: 'paper', sec: Math.max(0, planIds.indexOf(s.paperId)) });
          setPhase('run');
          return;
        }
        setPapers((await get('/api/exam/papers')).papers ?? []);
        try { setUnfinished((await get('/api/exam/sittings?status=active')).sittings ?? []); } catch { /* convenience */ }
        setPhase('setup');
      } catch (e) { setError(String(e.message || e)); setPhase('setup'); }
    })();
  }, []);

  /** Every page change goes through the blur + spinner, then lands. */
  const go = useCallback((fn, ms = BEAT_MS) => {
    setBeat(true);
    setTimeout(() => { fn(); setBeat(false); }, ms);
  }, []);

  // ── prestart → run ───────────────────────────────────────────────────────────
  const start = useCallback(async ({ paperIds, timing, shuffle, extraTime, explain, allowPause }) => {
    enterFullscreen();                 // must run inside the click
    setBusy(true); setError(null);
    setPhase('starting');
    const durationSec = timing === 'untimed' ? null : Math.round((timing === 'long' ? 120 : 75) * 60 * (extraTime ? 1.25 : 1));
    const sections = paperIds.map((id) => {
      const p = papers.find((x) => x.id === id);
      return { paperId: id, name: `Paper ${p?.paper ?? 1}`, count: p?.questions ?? 20, durationSec };
    });
    const groupId = `g${Date.now().toString(36)}`;
    setPlan({ sections, groupId, opts: { timing, shuffle, extraTime, explain, allowPause } });
    await loadMathJax().catch(() => {});
    setTimeout(() => {
      setBusy(false);
      setScreen({ kind: 'welcome', sec: 0 });
      setPhase('run');
    }, BIG_BEAT_MS);
  }, [papers]);

  const timed = plan ? plan.sections[0]?.durationSec != null : true;

  // Instructions clock: the Overview and Paper 1's intro share one minute; each later
  // paper's intro has its own. When it runs out, the paper starts.
  const instrLeft = useCountdown(instrDeadline);
  const beginPaper = useCallback(async (secIdx) => {
    setInstrDeadline(null);
    setBeat(true);
    try {
      const s = plan.sections[secIdx];
      const created = await post('/api/exam/sitting', {
        paperId: s.paperId, timing: plan.opts.timing ?? 'real', shuffle: plan.opts.shuffle, extraTime: plan.opts.extraTime,
        explain: plan.opts.explain, allowPause: plan.opts.allowPause, groupId: plan.groupId, section: secIdx + 1,
        plan: plan.sections.map((x) => x.paperId),
      });
      const data = await get(`/api/exam/sitting?id=${encodeURIComponent(created.sittingId)}`);
      window.history.replaceState({}, '', `/exam?id=${encodeURIComponent(created.sittingId)}`);
      setTimeout(() => { setSitting(data); setScreen({ kind: 'paper', sec: secIdx }); setBeat(false); }, BIG_BEAT_MS);
    } catch (e) {
      setError(String(e.message || e)); setBeat(false);
    }
  }, [plan]);

  useEffect(() => {
    if (instrLeft === 0 && (screen?.kind === 'overview' || screen?.kind === 'intro')) beginPaper(screen.kind === 'overview' ? 0 : screen.sec);
  }, [instrLeft, screen, beginPaper]);

  // Interval between papers: five minutes, then Paper 2 starts by itself.
  const intervalLeft = useCountdown(intervalDeadline);
  const toIntro = useCallback((secIdx) => {
    setIntervalDeadline(null);
    setIntervalHeld(null);
    holdBreak(plan?.groupId, null);
    go(() => { setScreen({ kind: 'intro', sec: secIdx }); setInstrDeadline(timed ? Date.now() + INSTRUCTIONS_SEC * 1000 : null); }, BIG_BEAT_MS);
  }, [go, timed, plan]);
  const pauseBreak = useCallback(() => {
    tele.record('interval_pause', { left: intervalLeft });
    setIntervalHeld(intervalLeft); setIntervalDeadline(null);
    holdBreak(plan?.groupId, intervalLeft);
  }, [intervalLeft, plan]);
  const resumeBreak = useCallback(() => {
    enterFullscreen();               // a reload during the break drops full screen; a click may restore it
    tele.record('interval_resume', { left: intervalHeld });
    setIntervalDeadline(Date.now() + (intervalHeld ?? INTERVAL_SEC) * 1000); setIntervalHeld(null);
  }, [intervalHeld]);
  // The break's time left survives a reload: written every few seconds while it runs.
  useEffect(() => {
    if (screen?.kind === 'interval' && intervalLeft != null && intervalLeft % 5 === 0) holdBreak(plan?.groupId, intervalLeft);
  }, [screen, intervalLeft, plan]);
  useEffect(() => {
    if (intervalLeft === 0 && screen?.kind === 'interval') toIntro(screen.sec + 1);
  }, [intervalLeft, screen, toIntro]);

  const toFinal = useCallback((ids) => {
    setSitting(null);
    window.history.replaceState({}, '', '/exam');
    go(() => setScreen({ kind: 'final', sec: 0, ids }), BIG_BEAT_MS);
  }, [go]);

  /** A paper has been ended (End Review) — on to the interval, or the final screen. */
  const paperDone = useCallback((sittingId) => {
    const ids = [...doneIds, sittingId];
    setDoneIds(ids);
    const next = screen.sec + 1;
    if (next < plan.sections.length) {
      setSitting(null);
      window.history.replaceState({}, '', `/exam?id=${encodeURIComponent(sittingId)}`);
      setIntervalHeld(null);
      go(() => { setScreen({ kind: 'interval', sec: screen.sec }); setIntervalDeadline(Date.now() + INTERVAL_SEC * 1000); }, BIG_BEAT_MS);
    } else toFinal(ids);
  }, [doneIds, screen, plan, go, toFinal]);

  /** End Exam on a paper with another one after it: end THAT paper and go to the break. */
  const endThisPaper = useCallback(async (sittingId) => {
    setEndExamOpen(false);
    setBeat(true);
    try { await tele.stop(); await post('/api/exam/finish', { sittingId, reason: 'ended' }); } catch { /* idempotent */ }
    setBeat(false);
    paperDone(sittingId);
  }, [paperDone]);

  /** End Exam: finish whatever paper is open and stop the whole test. */
  const endWholeExam = useCallback(async (sittingIdOrNull) => {
    setEndExamOpen(false);
    setBeat(true);
    const ids = [...doneIds];
    if (sittingIdOrNull) {
      try { await tele.stop(); await post('/api/exam/finish', { sittingId: sittingIdOrNull, reason: 'ended' }); } catch { /* finish is idempotent; the report retries */ }
      ids.push(sittingIdOrNull);
    }
    setDoneIds(ids);
    setBeat(false);
    toFinal(ids);
  }, [doneIds, toFinal]);

  const openReport = (ids) => {
    leaveFullscreen();
    window.location.href = ids.length ? `/exam/report?ids=${ids.map(encodeURIComponent).join(',')}` : '/';
  };

  // ── render ──────────────────────────────────────────────────────────────────
  const common = { scheme, onScheme: (s) => { tele.record('scheme_change', { to: s }); setScheme(s); } };
  const instrTimer = timed && instrDeadline ? { remainingSec: instrLeft, hidden: timerHidden } : null;
  const endExamBtn = () => { tele.record('end_exam_click'); setEndExamOpen(true); };
  const onEarlierPaper = screen?.kind === 'paper' && sitting && plan && screen.sec + 1 < plan.sections.length;

  let body;
  if (phase === 'boot' || phase === 'starting') body = <DeliveryLoading />;
  else if (phase === 'setup') {
    body = <Setup papers={papers} unfinished={unfinished} busy={busy} error={error} onStart={start} {...common} />;
  } else if (screen?.kind === 'welcome') {
    body = (
      <Driver {...common} nav={{ endExam: endExamBtn, next: () => go(() => { setScreen({ kind: 'overview', sec: 0 }); setInstrDeadline(timed ? Date.now() + INSTRUCTIONS_SEC * 1000 : null); }) }}>
        <WelcomeScreen />
      </Driver>
    );
  } else if (screen?.kind === 'overview') {
    body = (
      <Driver {...common} timer={instrTimer} onTimerClick={() => setTimerHidden((v) => !v)}
        nav={{ endExam: endExamBtn, previous: () => go(() => setScreen({ kind: 'welcome', sec: 0 })), next: () => go(() => setScreen({ kind: 'intro', sec: 0 })) }}>
        <OverviewScreen sections={plan.sections} timed={timed} />
      </Driver>
    );
  } else if (screen?.kind === 'intro') {
    body = (
      <Driver {...common} timer={instrTimer} onTimerClick={() => setTimerHidden((v) => !v)}
        nav={{ endExam: endExamBtn, next: () => beginPaper(screen.sec) }}>
        <IntroScreen section={plan.sections[screen.sec]} timed={timed} />
      </Driver>
    );
  } else if (screen?.kind === 'paper' && sitting) {
    body = (
      <Paper
        key={sitting.sitting.id}
        data={sitting} section={plan.sections[screen.sec]} opts={plan.opts} common={common}
        timerHidden={timerHidden} setTimerHidden={setTimerHidden}
        counterHidden={counterHidden} setCounterHidden={setCounterHidden}
        go={go} onEndExam={endExamBtn} onDone={paperDone}
      />
    );
  } else if (screen?.kind === 'interval') {
    const nextName = plan.sections[screen.sec + 1]?.name ?? 'Paper 2';
    body = (
      <Driver {...common} timer={{ remainingSec: intervalHeld ?? intervalLeft, hidden: false }}
        tools={{ pause: intervalHeld == null ? pauseBreak : null, pauseLabel: 'Pause Break' }}
        nav={{ endExam: endExamBtn, action: { label: `Start ${nextName}`, k: 'S', onClick: () => { enterFullscreen(); toIntro(screen.sec + 1); }, tele: 'start-next-paper' } }}>
        <IntervalScreen done={plan.sections[screen.sec].name} next={nextName} left={intervalHeld ?? intervalLeft} />
      </Driver>
    );
  } else if (screen?.kind === 'final') {
    body = (
      <Driver {...common} nav={{ action: { label: 'Finish', k: 'F', onClick: () => openReport(screen.ids ?? doneIds), tele: 'finish' } }}>
        <FinalScreen papers={(screen.ids ?? doneIds).length || 1} />
      </Driver>
    );
  } else body = <DeliveryLoading />;

  return (
    <div className="pv-root" ref={rootRef}>
      {body}
      {endExamOpen && onEarlierPaper ? (
        <MessageDialog title="End Exam" text={TXT.endPaper(plan.sections[screen.sec].name, plan.sections[screen.sec + 1].name)} contentId="EndExamLate"
          buttons={<>
            <DlgButton id="Yes" label="Yes" k="Y" tele="end-paper-yes" onClick={() => { tele.record('end_paper_confirm'); endThisPaper(sitting.sitting.id); }} />
            <DlgButton id="No" label="No" k="N" tele="end-exam-no" onClick={() => { tele.record('end_exam_cancel'); setEndExamOpen(false); }} />
          </>} />
      ) : endExamOpen ? (
        <MessageDialog title="End Exam" text={TXT.endExam} contentId="EndExamLate"
          buttons={<>
            <DlgButton id="Yes" label="Yes" k="Y" tele="end-exam-yes" onClick={() => { tele.record('end_exam_confirm'); endWholeExam(screen?.kind === 'paper' ? sitting?.sitting.id ?? null : null); }} />
            <DlgButton id="No" label="No" k="N" tele="end-exam-no" onClick={() => { tele.record('end_exam_cancel'); setEndExamOpen(false); }} />
          </>} />
      ) : null}
      {screen?.kind === 'interval' && intervalHeld != null && !endExamOpen ? (
        <MessageDialog title="Break Paused" contentId="abe-pauseScreen"
          text={`The break is paused with ${mmss(intervalHeld)} left before ${plan.sections[screen.sec + 1]?.name ?? 'the next paper'}.<br/><br/>You can close this window; opening the paper again brings you back here.`}
          buttons={<>
            <DlgButton id="Resume" label="Resume Break" k="R" tele="interval-resume" onClick={resumeBreak} />
            <DlgButton id="StartNow" label={`Start ${plan.sections[screen.sec + 1]?.name ?? 'Next Paper'}`} k="S" tele="start-next-paper" onClick={() => { enterFullscreen(); toIntro(screen.sec + 1); }} />
          </>} />
      ) : null}
      {beat ? <SpinnerOverlay /> : null}
      {error && phase === 'run' ? <div className="pv-error" role="alert">{error}</div> : null}
    </div>
  );
}

// ── the interval and final screens ─────────────────────────────────────────────

const ARIAL = { fontFamily: 'arial', fontSize: '12pt' };
const Gap = () => <p><span style={ARIAL}>&nbsp;</span></p>;
const mmss = (s) => `${Math.floor((s ?? 0) / 60)}:${String((s ?? 0) % 60).padStart(2, '0')}`;

function IntervalScreen({ done, next, left }) {
  return (
    <div id="abe-readMe" className="contentPaneLanguageWrapper" tabIndex={0}>
      <div className="abe-tt abe-content-root abe-block-leading Block abe-noPadding" style={{ backgroundColor: '#fff' }}>
        <p><b style={ARIAL}>{`${done} is over.`}</b></p>
        <Gap />
        <p><span style={ARIAL}>{`You have a 5-minute break before ${next}. Time remaining before ${next} starts: `}</span><b style={ARIAL}>{mmss(left)}</b></p>
        <Gap />
        <p><span style={ARIAL}>{`Your answers to ${done} have been saved, and you cannot return to ${done}.`}</span></p>
        <Gap />
        <p><span style={ARIAL}>{`If you are ready before the time runs out, click the `}</span><b style={ARIAL}>{`Start ${next} (S)`}</b><span style={ARIAL}>{` button. ${next} will start automatically when the time runs out. To stop the countdown, click `}</span><b style={ARIAL}>Pause Break</b><span style={ARIAL}>.</span></p>
      </div>
    </div>
  );
}

function FinalScreen({ papers }) {
  return (
    <div id="abe-readMe" className="contentPaneLanguageWrapper" tabIndex={0}>
      <div className="abe-tt abe-content-root abe-block-leading Block abe-noPadding" style={{ backgroundColor: '#fff' }}>
        <p className="abe-paragraph-center"><span className="abe-sim-brand">TMUA Practice</span></p>
        <Gap />
        <p><span style={ARIAL}>You have reached the end of the </span><b style={ARIAL}>Test of Mathematics for University Admission</b><span style={ARIAL}>.</span></p>
        <Gap />
        <p><span style={ARIAL}>{`Your responses to ${papers > 1 ? 'both papers' : 'this paper'} have been recorded.`}</span></p>
        <Gap />
        <p><span style={ARIAL}>Click the </span><b style={ARIAL}>Finish (F)</b><span style={ARIAL}> button to see your analysis.</span></p>
      </div>
    </div>
  );
}

// ── one paper: questions, Navigator, review ────────────────────────────────────

function Paper({ data, section, opts, common, timerHidden, setTimerHidden, counterHidden, setCounterHidden, go, onEndExam, onDone }) {
  const sitting = data.sitting;
  const questions = data.questions;
  const order = sitting.order;
  const [idx, setIdx] = useState(() => {
    const first = order.findIndex((n) => !sitting.answers?.[n]);
    return first > 0 ? first : 0;
  });
  const [answers, setAnswers] = useState(sitting.answers ?? {});
  const [flags, setFlags] = useState(sitting.flags ?? {});
  const [seen, setSeen] = useState(sitting.seen ?? {});
  const [view, setView] = useState('item');          // item | review
  const [fromReview, setFromReview] = useState(false);
  const [tab, setTab] = useState('All');
  const [navOpen, setNavOpen] = useState(false);
  const [instrOpen, setInstrOpen] = useState(false);
  const [endReviewStep, setEndReviewStep] = useState(0);
  const [solution, setSolution] = useState(null);
  const [paused, setPaused] = useState(Boolean(sitting.paused));
  const [error, setError] = useState(null);
  const enteredAt = useRef(Date.now());
  const visits = useRef({});
  const touched = useRef({});
  const paneRef = useRef(null);

  const question = questions[idx];
  const qnum = question?.qnum ?? null;

  useEffect(() => {
    tele.start(sitting.id, Date.now() - (sitting.elapsedSec ?? 0) * 1000);
    tele.record('section_start', { section: sitting.section ?? 1, paperId: sitting.paperId });
    return () => { tele.stop(); };
  }, [sitting.id, sitting.elapsedSec, sitting.section, sitting.paperId]);

  const clock = useExamClock({
    startedAt: sitting.startedAt, durationSec: sitting.durationSec ?? null, elapsedSec: sitting.elapsedSec ?? 0,
    breakSecondsUsed: sitting.breakSecondsUsed ?? 0, paused, onExpire: () => tele.record('time_expired'),
  });

  // seen + enter bookkeeping
  useEffect(() => {
    if (view !== 'item' || qnum == null) return;
    if (!visits.current[qnum]) {
      visits.current[qnum] = 1;
      tele.record('question_enter', { qnum });
    }
    setSeen((s) => (s[qnum] ? s : { ...s, [qnum]: true }));
  }, [view, qnum]);

  const leave = useCallback(() => {
    if (qnum != null && view === 'item') tele.record('question_leave', { qnum, dwell_ms: Date.now() - enteredAt.current });
  }, [qnum, view]);

  const goTo = useCallback((nextIdx, how) => {
    if (nextIdx < 0 || nextIdx >= questions.length) return;
    leave();
    const to = questions[nextIdx]?.qnum ?? null;
    if (how) tele.record(how, { from: qnum, to });
    go(() => {
      enteredAt.current = Date.now();
      visits.current[to] = (visits.current[to] || 0) + 1;
      if (visits.current[to] > 1) tele.record('revisit', { qnum: to, count: visits.current[to] });
      tele.record('question_enter', { qnum: to });
      setIdx(nextIdx); setView('item');
      if (paneRef.current) paneRef.current.scrollTop = 0;
    });
  }, [questions, qnum, go, leave]);

  const writeAnswer = useCallback(async (n, choice, flagged) => {
    try { await post('/api/exam/answer', { sittingId: sitting.id, qnum: n, choice, flagged }); setError(null); } catch (e) {
      try { await post('/api/exam/answer', { sittingId: sitting.id, qnum: n, choice, flagged }); } catch { setError(`Could not save your answer to question ${n}. ${String(e.message || e)}`); }
    }
  }, [sitting.id]);

  const choose = useCallback((letter) => {
    const prev = answers[qnum] ?? null;
    if (!touched.current[qnum]) { touched.current[qnum] = true; tele.record('first_interaction', { qnum, ms: Date.now() - enteredAt.current }); }
    tele.record('option_select', { qnum, letter, prev, latency_ms: Date.now() - enteredAt.current });
    if (prev && prev !== letter) tele.record('option_change', { qnum, from: prev, to: letter });
    setAnswers((a) => ({ ...a, [qnum]: letter }));
    writeAnswer(qnum, letter, Boolean(flags[qnum]));
  }, [answers, flags, qnum, writeAnswer]);

  const toggleFlag = useCallback(() => {
    const on = !flags[qnum];
    tele.record(on ? 'flag_set' : 'flag_clear', { qnum });
    setFlags((f) => ({ ...f, [qnum]: on }));
    writeAnswer(qnum, answers[qnum] ?? null, on);
  }, [answers, flags, qnum, writeAnswer]);

  const openReview = useCallback((how) => {
    leave();
    tele.record(how ?? 'review_open', { qnum });
    go(() => { setView('review'); setFromReview(false); setTab('All'); });
  }, [go, leave, qnum]);

  const next = useCallback(() => {
    if (idx + 1 < questions.length) goTo(idx + 1, fromReview ? 'review_next' : 'nav_next');
    else { tele.record('end_of_paper'); openReview('review_open'); }
  }, [idx, questions.length, goTo, fromReview, openReview]);

  // Pause (practice only): stops the clock, keeps everything.
  const pause = useCallback(() => {
    leave();
    tele.record('pause_start', { qnum });
    setPaused(true);
    post('/api/exam/pause', { sittingId: sitting.id }).catch(() => {});
  }, [leave, qnum, sitting.id]);
  const resume = useCallback(() => {
    tele.record('pause_end', { qnum });
    enteredAt.current = Date.now();
    setPaused(false);
    post('/api/exam/resume', { sittingId: sitting.id }).catch(() => {});
  }, [qnum, sitting.id]);

  // Leaving the window pauses the clock (a beacon, because the page may be going away).
  useEffect(() => {
    const away = () => {
      if (document.visibilityState === 'visible' || !opts?.allowPause) return;
      try { navigator.sendBeacon('/api/exam/pause', JSON.stringify({ sittingId: sitting.id })); } catch { /* best effort */ }
      tele.record('pause_start', { auto: true });
      setPaused(true);
    };
    document.addEventListener('visibilitychange', away);
    return () => document.removeEventListener('visibilitychange', away);
  }, [sitting.id, opts]);

  const explain = useCallback(async () => {
    tele.record('explain_open', { qnum });
    try {
      const r = await get(`/api/exam/explain?id=${encodeURIComponent(sitting.id)}&q=${qnum}`);
      setSolution(r);
    } catch (e) { setSolution({ error: String(e.message || e) }); }
  }, [sitting.id, qnum]);

  const finishPaper = useCallback(async () => {
    setEndReviewStep(0);
    tele.record('end_review_confirm');
    tele.record('submit', { reason: 'submitted' });
    await tele.stop();
    try { await post('/api/exam/finish', { sittingId: sitting.id, reason: 'submitted' }); } catch (e) { setError(String(e.message || e)); return; }
    onDone(sitting.id);
  }, [sitting.id, onDone]);

  const reviewRows = useMemo(() => order.map((n, i) => ({
    qnum: n, ordinal: i + 1, status: statusOf(n, { answers, seen }), flagged: Boolean(flags[n]),
  })), [order, answers, seen, flags]);
  const incomplete = reviewRows.filter((r) => r.status !== 'Complete').length;

  const timer = sitting.durationSec == null ? null : { remainingSec: clock.remainingSec, hidden: timerHidden };
  const figureUrl = question?.figure ? `/api/exam/figure?paper=${encodeURIComponent(sitting.paperId)}&q=${question.qnum}` : null;

  let content; let tools; let nav; let counter = null; let paneStyle;
  if (view === 'review') {
    content = (
      <ReviewScreen rows={reviewRows} tab={tab} onTab={(t) => { tele.record('review_tab', { tab: t }); setTab(t); }}
        onReviewAll={() => { tele.record('review_all'); setFromReview(true); goTo(0, 'review_all'); }}
        onReviewItem={(n) => { tele.record('review_item', { to: n }); setFromReview(true); goTo(order.indexOf(n), 'review_item'); }} />
    );
    tools = { instructions: () => { tele.record('review_instructions'); setInstrOpen(true); } };
    nav = { endReview: () => { tele.record('end_review_click'); setEndReviewStep(1); } };
    paneStyle = { backgroundColor: '#f2f3f5' };
  } else {
    content = question ? (
      <ItemScreen key={`${sitting.id}-${question.qnum}`} question={question} paperId={sitting.paperId}
        answer={answers[qnum] ?? null} onAnswer={choose} figureUrl={figureUrl} />
    ) : null;
    counter = { ordinal: idx + 1, total: questions.length, hidden: counterHidden };
    tools = {
      explain: opts?.explain ? explain : null,
      pause: opts?.allowPause ? pause : null,
      flag: { flagged: Boolean(flags[qnum]), onClick: toggleFlag },
    };
    nav = fromReview
      ? { endExam: onEndExam, reviewScreen: () => openReview('review_screen'), next }
      : {
        endExam: onEndExam,
        previous: idx > 0 ? () => goTo(idx - 1, 'nav_prev') : null,
        navigator: () => { tele.record('navigator_open', { qnum }); setNavOpen(true); },
        next,
      };
  }

  return (
    <>
      <Driver {...common} timer={timer} counter={counter}
        onTimerClick={() => { tele.record(timerHidden ? 'timer_show' : 'timer_hide'); setTimerHidden((v) => !v); }}
        onCounterClick={() => { tele.record(counterHidden ? 'counter_show' : 'counter_hide'); setCounterHidden((v) => !v); }}
        tools={tools} nav={nav} paneRef={paneRef} paneStyle={paneStyle}>
        {content}
      </Driver>

      {navOpen ? (
        <NavigatorDialog order={order} current={qnum} answers={answers} seen={seen} flags={flags}
          onGo={(n) => { tele.record('navigator_row_click', { qnum, to: n }); setNavOpen(false); goTo(order.indexOf(n), 'nav_jump'); }}
          onClose={() => { tele.record('navigator_close', { qnum }); setNavOpen(false); }} />
      ) : null}
      {instrOpen ? <InstructionsDialog onClose={() => setInstrOpen(false)} /> : null}
      {endReviewStep === 1 ? (
        <MessageDialog kind="alert" title="End Review" contentId="EndReview1"
          text={incomplete ? fmtDialog(TXT.endReview1Incomplete, incomplete) : TXT.endReview1Complete}
          buttons={<>
            <DlgButton id="Yes" label="Yes" k="Y" tele="end-review-yes-1" onClick={() => setEndReviewStep(2)} />
            <DlgButton id="No" label="No" k="N" tele="end-review-no-1" onClick={() => { tele.record('end_review_cancel'); setEndReviewStep(0); }} />
          </>} />
      ) : null}
      {endReviewStep === 2 ? (
        <MessageDialog kind="alert" title="End Review Confirmation" contentId="EndReview2"
          text={incomplete ? fmtDialog(TXT.endReview2Incomplete, incomplete) : TXT.endReview2Complete}
          buttons={<>
            <DlgButton id="Yes" label="Yes" k="Y" tele="end-review-yes-2" onClick={finishPaper} />
            <DlgButton id="No" label="No" k="N" tele="end-review-no-2" onClick={() => { tele.record('end_review_cancel'); setEndReviewStep(0); }} />
          </>} />
      ) : null}
      {paused ? (
        <MessageDialog title="Pause Exam" contentId="abe-pauseScreen"
          text="Your exam is paused. The clock has stopped and every answer is saved.<br/><br/>You can close this window and continue later from the prestart page."
          buttons={<DlgButton id="Resume" label="Resume" k="R" tele="pause-resume" onClick={resume} />} />
      ) : null}
      {solution ? <Solution data={solution} options={question?.options ?? []} onClose={() => setSolution(null)} /> : null}
      {error ? <div className="pv-error" role="alert">{error}</div> : null}
    </>
  );
}

function Solution({ data, onClose }) {
  const [option, setOption] = useState(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const h = data.option ? await texToHtml(data.option) : null;
      refreshMathStyles();
      if (live) setOption(h);
    })();
    return () => { live = false; };
  }, [data]);
  return (
    <SolutionDialog onClose={onClose}>
      <div style={{ fontFamily: 'arial', fontSize: '12pt' }}>
        {data.error ? <p>{data.error}</p> : (
          <>
            <p>The correct answer is: {option ? <span dangerouslySetInnerHTML={{ __html: option }} /> : (data.answer ?? 'not available')}</p>
            <p>&nbsp;</p>
            {data.solution ? data.solution.pages.map((pg) => (
              <p key={pg}><img alt={`solution page ${pg}`} style={{ maxWidth: '100%' }}
                src={`/api/pdf-page?path=${encodeURIComponent(data.solution.path)}&page=${pg}`} /></p>
            )) : <p>No worked solution is available for this question.</p>}
          </>
        )}
      </div>
    </SolutionDialog>
  );
}
