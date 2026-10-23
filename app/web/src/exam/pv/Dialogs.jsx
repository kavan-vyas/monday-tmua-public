// Driver dialogs, as the jQuery UI markup the real driver renders (ui-dialog, titlebar,
// content, buttonpane) so jquery-ui.css + base.css + the theme style them.
//
// Real behaviour reproduced:
//  - No dimmed backdrop. The page behind stays fully visible; a modal dialog simply
//    blocks clicks to it (an invisible full-window shield).
//  - Dialogs open centred and can be dragged by the title bar. The Navigator can also be
//    resized from its edges and corner grip.
//  - Message text arrives as the driver's strings with <br/> line breaks; each line is its
//    own <p>, and a blank line is an empty <p>, which is how the driver lays them out.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AK } from './Driver.jsx';

let zTop = 2147483257;

function useDrag(ref) {
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || pos) return;
    const w = el.offsetWidth; const h = el.offsetHeight;
    setPos({ left: Math.max(0, (window.innerWidth - w) / 2), top: Math.max(0, (window.innerHeight - h) / 2) });
  }, [ref, pos]);
  const onMouseDown = useCallback((e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const start = { x: e.clientX, y: e.clientY, ...pos };
    const move = (ev) => setPos({
      left: Math.min(Math.max(0, start.left + ev.clientX - start.x), window.innerWidth - 60),
      top: Math.min(Math.max(0, start.top + ev.clientY - start.y), window.innerHeight - 30),
    });
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    e.preventDefault();
  }, [pos]);
  return [pos, setPos, onMouseDown];
}

export function DialogShell({
  title, titleNode, className = '', contentId, contentClass = '', contentStyle, children, buttons,
  buttonsetClass = 'position-center', width = 'auto', modal = true, resizable = false, onEscape, buttonpaneClass = '',
  titlebarClass = '',
}) {
  const ref = useRef(null);
  const [pos, setPos, onDrag] = useDrag(ref);
  const [size, setSize] = useState(null);
  const z = useMemo(() => ++zTop, []);

  useEffect(() => {
    if (!onEscape) return undefined;
    const k = (e) => { if (e.key === 'Escape') { e.preventDefault(); onEscape(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onEscape]);

  // Resize from any edge/corner, like jQuery UI's resizable handles.
  const startResize = (dir) => (e) => {
    e.preventDefault(); e.stopPropagation();
    const el = ref.current;
    const s = { x: e.clientX, y: e.clientY, w: el.offsetWidth, h: el.offsetHeight, ...pos };
    const move = (ev) => {
      const dx = ev.clientX - s.x; const dy = ev.clientY - s.y;
      let { w, h, left, top } = s;
      if (dir.includes('e')) w = Math.max(300, s.w + dx);
      if (dir.includes('s')) h = Math.max(200, s.h + dy);
      if (dir.includes('w')) { w = Math.max(300, s.w - dx); left = s.left + (s.w - w); }
      if (dir.includes('n')) { h = Math.max(200, s.h - dy); top = s.top + (s.h - h); }
      setSize({ w, h }); setPos({ left, top });
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <>
      {modal ? <div className="pv-modal-shield" style={{ position: 'fixed', inset: 0, zIndex: z - 1 }} /> : null}
      <div
        ref={ref} tabIndex={-1} role="dialog"
        className={`ui-dialog ui-corner-all ui-widget ui-widget-content ui-front${modal ? ' modal' : ''}${buttons ? ' ui-dialog-buttons' : ''} ui-draggable${resizable ? ' ui-resizable' : ''} Primary ${className}`}
        style={{
          position: 'fixed', height: size ? size.h : 'auto', width: size ? size.w : width, zIndex: z,
          top: pos ? pos.top : 0, left: pos ? pos.left : 0, visibility: pos ? 'visible' : 'hidden',
        }}
      >
        <div className={`ui-dialog-titlebar ui-corner-all ui-widget-header ui-helper-clearfix ui-draggable-handle ${titlebarClass}`} onMouseDown={onDrag}>
          <span className="ui-dialog-title rc-fonts-Message" tabIndex={-1}>{titleNode ?? title}</span>
        </div>
        <div id={contentId} className={`ui-dialog-content ui-widget-content ${contentClass}`}
          style={{ width: 'auto', minHeight: 58.85, maxHeight: 'none', height: 'auto', ...contentStyle }}>
          {children}
        </div>
        {resizable ? ['n', 'e', 's', 'w', 'se', 'sw', 'ne', 'nw'].map((d) => (
          <div key={d} className={`ui-resizable-handle ui-resizable-${d}${d === 'se' ? ' ui-icon ui-icon-gripsmall-diagonal-se' : ''}`}
            style={{ zIndex: 90 }} onMouseDown={startResize(d)} />
        )) : null}
        {buttons ? (
          <div className={`ui-dialog-buttonpane ui-widget-content ui-helper-clearfix ${buttonpaneClass}`}>
            <div className={`ui-dialog-buttonset ${buttonsetClass}`}>{buttons}</div>
          </div>
        ) : null}
      </div>
    </>
  );
}

export function DlgButton({ id, label, k, onClick, className = 'rc-fonts-Message', tele }) {
  return (
    <button type="button" id={id} className={`ui-button ui-corner-all ui-widget ${className}`}
      data-accesskey={k} accessKey={k?.toLowerCase()} data-tele={tele} onClick={onClick}>
      <AK label={label} k={k} />
    </button>
  );
}

/** Split a driver message ("line<br/>line<br/><br/>question") into the driver's <p>s. */
export function MessageLines({ text }) {
  const lines = String(text).split(/<br\s*\/?>/i);
  return <div>{lines.map((l, i) => <p key={i}>{l}</p>)}</div>;
}

/** Information (blue "i") or alert (yellow warning triangle) message with buttons. */
export function MessageDialog({ title, text, kind = 'info', buttons, contentId = 'abe-message' }) {
  const cls = kind === 'alert'
    ? 'abe-WarningImage alert-dialog rc-fonts-ItemText'
    : 'abe-InformationImage info-dialog';
  return (
    <DialogShell title={title} contentId={contentId} contentClass={cls}
      contentStyle={{ overflow: 'hidden auto' }} buttons={buttons}>
      <span className="sr-only">{kind === 'alert' ? 'Dialog Type Alert. ' : 'Dialog Type Information. '}</span>
      <div className="abe-dialogDiv">
        <div className="abe-infoDiv" />
        <div tabIndex={-1} className="abe-messageText rc-fonts-Message"><MessageLines text={text} /></div>
      </div>
    </DialogShell>
  );
}

// ── Navigator ───────────────────────────────────────────────────────────────

export function statusOf(qnum, { answers, seen }) {
  if (answers?.[qnum]) return 'Complete';
  if (seen?.[qnum]) return 'Incomplete';
  return 'Unseen';
}

const STATUS_RANK = { Unseen: 0, Incomplete: 1, Complete: 2 };

export function NavigatorDialog({ order, current, answers, seen, flags, onGo, onClose }) {
  // Sort resets to "Question #" ascending every time the Navigator opens, as on the real one.
  const [sort, setSort] = useState({ col: 'question', dir: 1 });
  const bodyRef = useRef(null);
  const rows = useMemo(() => {
    const base = order.map((n, i) => ({ n, ordinal: i + 1, st: statusOf(n, { answers, seen }), fl: Boolean(flags?.[n]) }));
    const key = { question: (r) => r.ordinal, status: (r) => STATUS_RANK[r.st] * 1000 + r.ordinal, flagForReview: (r) => (r.fl ? 0 : 1) * 1000 + r.ordinal }[sort.col];
    return base.sort((a, b) => (key(a) - key(b)) * sort.dir);
  }, [order, answers, seen, flags, sort]);
  const outstanding = rows.filter((r) => r.st !== 'Complete').length;

  useEffect(() => {
    const cur = bodyRef.current?.querySelector('tr.selectedRowColor');
    if (cur && bodyRef.current) {
      const box = bodyRef.current;
      if (cur.offsetTop + cur.offsetHeight > box.clientHeight) box.scrollTop = cur.offsetTop - box.clientHeight / 2;
    }
  }, []);

  const head = (col, label) => (
    <th className="navSortHead" data-sort-column={col}>
      <a href="#" style={{ textDecoration: 'none' }} data-tele={`nav-sort-${col}`}
        onClick={(e) => { e.preventDefault(); setSort((s) => ({ col, dir: s.col === col ? -s.dir : 1 })); }}>{label}</a>
      <span className={`sorting${sort.col === col ? (sort.dir > 0 ? ' abe-UpArrowImage' : ' abe-DownArrowImage') : ''}`} />
    </th>
  );

  return (
    <DialogShell
      className="ui-dialog-buttons" contentId="abe-navigatorDialog" contentClass="Content rc-fonts-ItemText"
      contentStyle={{ marginLeft: 6, marginRight: 6, paddingRight: 6, height: 314 }}
      width={720} resizable modal onEscape={onClose} buttonsetClass=""
      titleNode={(
        <>
          <span className="abe-NavigatorImage" />
          <span className="abe-ui-exam-dialog-title rc-fonts-Message" tabIndex={-1}>
            Navigator<span> - select a question to go to it</span>
          </span>
        </>
      )}
      buttons={<DlgButton label="Close" k="C" className="rc-fonts-Normal" onClick={onClose} tele="navigator-close" />}
    >
      <div id="abe-navigator">
        <div id="abe-navigatorBody" tabIndex={-1} ref={bodyRef}>
          <table cellSpacing={0}>
            <thead className="Secondary rc-fonts-Normal">
              <tr>
                {head('question', 'Question #')}
                {head('status', 'Status')}
                {head('flagForReview', 'Flagged for Review')}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.n} className={`navpoint ${i % 2 ? 'odd' : 'even'} ${r.n === current ? 'selectedRowColor' : ''}`}
                  data-tele={`nav-row-${r.n}`} onClick={() => onGo(r.n)}>
                  <td><a className="hover rc-fonts-Message" href="#" onClick={(e) => e.preventDefault()}>Question {r.ordinal}</a></td>
                  <td className={`status rc-fonts-Message ${r.st === 'Complete' ? 'Content' : 'abe-unseen'}`}>{r.st}</td>
                  <td className="abe-reviewFlag">
                    <span className={r.fl ? 'abe-FlaggedTrueLabelImage' : 'abe-FlaggedFalseLabelImage'}
                      style={{ display: 'inline-block', width: 35, height: 26, backgroundRepeat: 'no-repeat' }}>&nbsp;</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div id="abe-navigatorFooter" className="Primary rc-fonts-Message">{outstanding} Unseen/Incomplete</div>
      </div>
    </DialogShell>
  );
}

// ── Review-screen Instructions ──────────────────────────────────────────────

export function InstructionsDialog({ onClose }) {
  return (
    <DialogShell
      className="abe-ReviewInstructionsDialogMainContent abe-ReviewInstructionsDialog"
      titlebarClass="abe-ReviewInstructionsDialogTitleCloseParent"
      titleNode={<span className="abe-ReviewInstructionTitle">Instructions<span className="abe-ReviewInstructionsDialogHorizontalLine" /></span>}
      contentId="instructionsWindow"
      contentClass="abe-InformationImage info-dialog abe-ReviewInstructionsDialogTitleCloseParent"
      contentStyle={{ overflow: 'hidden auto' }} width={925} onEscape={onClose}
      buttonpaneClass="abe-ReviewInstructionsDialogButtonPane"
      buttons={<DlgButton id="Close" label="Close" k="C" className="rc-fonts-Message abe-ReviewInstructionsDialogCloseButton" onClick={onClose} tele="instructions-close" />}
    >
      <span className="sr-only">Dialog Type Information. </span>
      <div className="abe-dialogDiv">
        <div className="abe-infoDiv abe-ReviewInstructionInfoLI" />
        <div tabIndex={-1} className="abe-messageText rc-fonts-Message">
          <p>The review is a summary of your answers. You can review your questions in up to four different ways using the tabs.<br /></p>
          <ol>
            <li>Review all your questions and answers.</li>
            <li>Review questions that are incomplete.</li>
            <li>Review questions that were not seen.</li>
            <li>Review questions that are flagged for review.</li>
          </ol>
          <p>You may also select a question row’s “Review” button to get directly to its location in the exam.</p>
        </div>
      </div>
    </DialogShell>
  );
}

// ── Explain Answer → Solution ───────────────────────────────────────────────

export function SolutionDialog({ children, onClose }) {
  return (
    <DialogShell
      className="tabbed-dialog-all solution-dialog-all" modal={false} onEscape={onClose}
      width={Math.min(1224, window.innerWidth - 40)}
      titleNode={(
        <>
          <span className="abe-SolutionImage" />
          <span className="abe-ui-exam-dialog-title rc-fonts-Normal" tabIndex={-1}>Solution</span>
          <button type="button" className="ui-button ui-corner-all ui-widget ui-button-icon-only ui-dialog-titlebar-close"
            title="Close" style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)' }}
            data-tele="solution-close" onClick={onClose}>
            <span className="ui-button-icon ui-icon ui-icon-closethick" /><span className="ui-button-icon-space"> </span>Close
          </button>
        </>
      )}
      contentId="abe-solutionDialog"
      contentClass="abe-popup-window-tabbed-dialog ui-tabs ui-corner-all ui-widget ui-widget-content Content rc-fonts-ItemText"
      contentStyle={{ height: Math.min(600, window.innerHeight - 200), overflow: 'auto', background: '#fff' }}
    >
      <div className="abe-tabContent" style={{ padding: 18 }}>{children}</div>
    </DialogShell>
  );
}
