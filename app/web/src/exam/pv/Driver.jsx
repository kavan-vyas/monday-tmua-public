// The test-driver chrome — title bar, tool bar, content pane, navigation bar — styled
// by web/public/sim/sim.css (loaded by assets.js).
//
// Behaviour copied from the real driver:
//  - Buttons are real <button>s with an underlined access key; Alt+<key> clicks whichever
//    visible button carries that key, topmost dialog first. That is how the driver binds
//    them (data-accesskey), and why Alt+N works on any screen that shows Next.
//  - The clock button toggles "Time Remaining mm:ss" ↔ icon only. With 5:00 or less left
//    it is forced visible, turns yellow (class "locked") and stops responding to clicks.
//  - The counter button toggles "n of N" ↔ icon only.
//  - The first visible button on the left of each bar gets 5px of left padding.
import React, { useEffect, useRef, useState } from 'react';
import { SCHEMES } from './assets.js';

export function AK({ label, k }) {
  const i = label.toLowerCase().indexOf(k.toLowerCase());
  if (i < 0) return <>{label}</>;
  return <>{label.slice(0, i)}<span className="abe-accesskey">{label[i]}</span>{label.slice(i + 1)}</>;
}

/** Alt+key → click the visible button bound to that key, preferring the topmost dialog. */
export function useAccessKeys(enabled = true) {
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const key = (e.code?.startsWith('Key') ? e.code.slice(3) : e.key).toUpperCase();
      if (key.length !== 1) return;
      const visible = (b) => b.offsetParent !== null && !b.disabled;
      const dialogs = [...document.querySelectorAll('.ui-dialog')].filter((d) => d.offsetParent !== null);
      const scopes = dialogs.length ? [dialogs[dialogs.length - 1]] : [document];
      for (const scope of scopes) {
        const hit = [...scope.querySelectorAll('[data-accesskey]')]
          .find((b) => b.dataset.accesskey.toUpperCase() === key && visible(b));
        if (hit) { e.preventDefault(); e.stopPropagation(); hit.click(); return; }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [enabled]);
}

function Btn({ id, label, k, onClick, className = 'rc-fonts-Normal', shown = true, tele, describedBy }) {
  if (!shown) return null;
  return (
    <button id={id} type="button" className={className} data-accesskey={k} accessKey={k}
      aria-describedby={describedBy} data-tele={tele} onClick={onClick}>
      <AK label={label} k={k} />
    </button>
  );
}

const fmt = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${m < 10 ? '0' : ''}${m}:${s % 60 < 10 ? '0' : ''}${s % 60}`;
};

function TitleBar({ timer, counter, onTimerClick, onCounterClick }) {
  const locked = Boolean(timer && timer.remainingSec != null && timer.remainingSec <= 300);
  const showTimerText = timer && (locked || !timer.hidden);
  const expired = timer && timer.remainingSec != null && timer.remainingSec <= 0;
  return (
    <div id="abe-titlebar" className="Primary" role="region" aria-labelledby="Title_bar">
      <span id="Title_bar" style={{ display: 'none' }}>Title bar</span>
      <div id="abe-application-logo"><span className="abe-ApplicationLogoImage" /></div>
      <div id="abe-titlebar-title" className="rc-fonts-Large" tabIndex={-1} style={{ visibility: 'visible' }}>
        <span id="abe-assessment-title">Test of Mathematics for University Admission</span>
      </div>
      <div id="abe-titlebar-info" style={{ visibility: 'visible' }}>
        <div id="abe-timer" role="timer" style={{ visibility: timer ? 'visible' : 'hidden' }}>
          <button id="abe-TimeRemainingSectionButton" type="button" className={locked ? 'locked' : ''}
            style={{ display: timer ? undefined : 'none' }} data-tele="timer-toggle"
            onClick={locked ? undefined : onTimerClick}>
            <span id="abe-timerPlaceholder" />
            <span id="accessibleTimerText" className="sr-only">
              {`${showTimerText ? 'Hide' : 'Show'} Timer Time Remaining`}
            </span>
            <div id="abe-timerContents" className="rc-fonts-Message" aria-hidden="true"
              style={{ display: showTimerText ? undefined : 'none' }}>
              {timer ? (
                expired
                  ? <><span id="abe-timerLabel">Time Expired</span><span id="timeRemaining" /></>
                  : <><span id="abe-timerLabel">Time Remaining </span><span id="timeRemaining">{fmt(timer.remainingSec)}</span></>
              ) : null}
            </div>
          </button>
        </div>
        <div id="abe-itemCounter" role="heading" aria-level={1} style={{ visibility: counter ? 'visible' : 'hidden' }}>
          <button id="abe-ItemOrdinalKnownButton" type="button" data-tele="counter-toggle" onClick={onCounterClick}
            style={{ display: counter ? undefined : 'none' }}>
            <div className="abe-hidden-shim" />
            <div id="abe-itemCounterWrapper" aria-hidden="true">
              {counter && !counter.hidden ? (
                <span id="abe-ItemOrdinalKnown" className="rc-fonts-Message">
                  <span id="itemOrdinal">{counter.ordinal}</span> of <span id="itemCardinal">{counter.total}</span>
                </span>
              ) : null}
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

function SchemeMenu({ scheme, onScheme }) {
  const [open, setOpen] = useState(false);
  const [hot, setHot] = useState(0);
  const ref = useRef(null);
  const current = SCHEMES.find((s) => s.id === scheme) ?? SCHEMES[0];

  useEffect(() => {
    if (!open) return undefined;
    setHot(Math.max(0, SCHEMES.findIndex((s) => s.id === scheme)));
    const away = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const key = (e) => {
      if (e.key === 'Escape') { setOpen(false); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setHot((h) => Math.min(SCHEMES.length - 1, h + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setHot((h) => Math.max(0, h - 1)); }
      else if (e.key === 'Enter') { e.preventDefault(); setHot((h) => { onScheme(SCHEMES[h].id); return h; }); setOpen(false); }
    };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', away); window.removeEventListener('keydown', key); };
  }, [open, scheme, onScheme]);

  return (
    <div className="abe-icon-left abe-colorSchemeDropDown" ref={ref}>
      <span className="ui-selectmenu abe-colorSchemeDropdownButton" id="colorSchemeDropDown">
        <span id="dropdown-colorSchemes" className="abe-drop_down">
          <span
            className={`ui-selectmenu-button ui-widget ui-button ui-state-default ui-corner-all${open ? ' ui-selectmenu-button-open ui-corner-top' : ''}`}
            tabIndex={0} id="colorSchemes-button" role="combobox" aria-expanded={open}
            aria-haspopup="true" data-tele="scheme" onClick={() => setOpen((v) => !v)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true); } }}
          >
            <span className="ui-icon ui-icon-triangle-1-s" />
            <span className="ui-selectmenu-text rc-fonts-Small">{current.label}</span>
          </span>
          {/* Rendered only while open: a closed list that is merely hidden can still
              catch a click aimed at whatever sits underneath it. */}
          {open ? <div className="ui-selectmenu-menu ui-front ui-selectmenu-open">
            <ul id="colorSchemes-menu" role="listbox" tabIndex={0} aria-hidden={!open}
              className="ui-menu ui-corner-bottom ui-widget ui-widget-content rc-fonts-Small">
              {SCHEMES.map((s, i) => (
                <li key={s.id} className="ui-menu-item">
                  <div tabIndex={-1} role="option" data-tele={`scheme-${s.id}`}
                    className={`ui-menu-item-wrapper${i === hot ? ' ui-state-active' : ''}`}
                    onMouseEnter={() => setHot(i)}
                    onClick={() => { onScheme(s.id); setOpen(false); }}>{s.label}</div>
                </li>
              ))}
            </ul>
          </div> : null}
        </span>
      </span>
    </div>
  );
}

function ToolBar({ tools = {}, scheme, onScheme }) {
  const { explain, instructions, pause, flag } = tools;
  const leftFirst = explain ? 'explain' : instructions ? 'instructions' : null;
  const rightFirst = pause ? 'pause' : flag ? 'flag' : null;
  const pad = (name, first) => ({ paddingLeft: first === name ? '5px' : '0px' });
  return (
    <div id="abe-toolbar" className="Secondary" role="region" aria-labelledby="Tool_bar" style={{ display: 'table', height: '30px' }}>
      <span id="Tool_bar" style={{ display: 'none' }}>Tool bar</span>
      <div id="abe-toolbar-tools" style={{ visibility: 'visible' }}>
        {explain ? (
          <div className="abe-icon-left" style={pad('explain', leftFirst)}>
            <Btn id="abe-SolutionButton" className="rc-fonts-Small" label="Explain Answer" k="X" onClick={explain} tele="explain" />
          </div>
        ) : null}
        {instructions ? (
          <div className="abe-icon-left" style={pad('instructions', leftFirst)}>
            <Btn id="abe-ReviewInstructionsButton" label="Instructions" k="R" onClick={instructions} tele="review-instructions" />
          </div>
        ) : null}
      </div>
      <div id="abe-toolbar-flags">
        {pause ? (
          <div className="abe-icon-left" style={pad('pause', rightFirst)}>
            <button id="abe-PauseExamButton" type="button" className="rc-fonts-Small" data-tele="pause" onClick={pause}>{tools.pauseLabel ?? 'Pause Exam'}</button>
          </div>
        ) : null}
        {flag ? (
          <div className="abe-icon-left" style={pad('flag', rightFirst)}>
            <button id="abe-FlagForReviewItemButton" type="button"
              className={`rc-fonts-Small ${flag.flagged ? 'abe-FlagForReviewItemButtonSelected' : 'abe-FlagForReviewItemButtonUnselected'}`}
              data-accesskey="F" accessKey="F" data-tele="flag" aria-pressed={flag.flagged} onClick={flag.onClick}>
              <AK label="Flag for Review" k="F" />
            </button>
          </div>
        ) : null}
        <SchemeMenu scheme={scheme} onScheme={onScheme} />
      </div>
    </div>
  );
}

function NavBar({ nav = {} }) {
  const { endExam, reviewScreen, endReview, previous, navigator, next, action } = nav;
  const leftFirst = endExam ? 'end' : reviewScreen ? 'rs' : endReview ? 'er' : null;
  const pad = (name) => ({ paddingLeft: leftFirst === name ? '5px' : '0px' });
  return (
    <div id="abe-navigationbar" className="Primary" role="navigation">
      <div id="abe-navigation-help-finish" style={{ visibility: 'visible' }}>
        {endExam ? (
          <div className="abe-inline-button-left abe-icon-left" style={pad('end')}>
            <Btn id="abe-EndExamButton" label="End Exam" k="E" onClick={endExam} tele="end-exam" />
          </div>
        ) : null}
        {reviewScreen ? (
          <div className="abe-inline-button-left abe-icon-left" style={pad('rs')}>
            <Btn id="abe-ReviewScreenButton" label="Review Screen" k="S" onClick={reviewScreen} tele="review-screen" />
          </div>
        ) : null}
        {endReview ? (
          <div className="abe-inline-button-left abe-icon-left" style={pad('er')}>
            <Btn id="abe-EndReviewButton" label="End Review" k="E" onClick={endReview} tele="end-review" />
          </div>
        ) : null}
      </div>
      <div id="abe-navigation-jump" style={{ visibility: 'visible' }}>
        {previous ? (
          <div className="abe-inline-button-right abe-icon-left" style={{ paddingLeft: '0px' }}>
            <Btn id="abe-PreviousButton" label="Previous" k="P" onClick={previous} tele="prev" />
          </div>
        ) : null}
        {navigator ? (
          <div className="abe-inline-button-right">
            <Btn id="abe-NavigatorButton" label="Navigator" k="V" onClick={navigator} tele="navigator" />
          </div>
        ) : null}
        {next ? (
          <div className="abe-inline-button-right abe-icon-right">
            <Btn id="abe-NextButton" label="Next" k="N" onClick={next} tele="next" />
          </div>
        ) : null}
        {/* The driver's own Continue Exam slot, relabelled: Start Test, Start Paper 2,
            Finish. Same place, same button style, its own access key. */}
        {action ? (
          <div className="abe-inline-button-right abe-icon-right">
            <Btn id="abe-ContinueExamButton" label={action.label} k={action.k} onClick={action.onClick} tele={action.tele} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The whole driver frame. `children` is the content pane's content; `pane` lets a screen
 * restyle the pane itself (the Review screen uses a grey pane).
 */
export default function Driver({ timer, counter, onTimerClick, onCounterClick, tools, nav, scheme, onScheme, children, paneClass = '', paneStyle, paneRef }) {
  useAccessKeys(true);
  return (
    <div id="abe-examPreview-root">
      <TitleBar timer={timer} counter={counter} onTimerClick={onTimerClick} onCounterClick={onCounterClick} />
      <ToolBar tools={tools} scheme={scheme} onScheme={onScheme} />
      <div id="abe-contentPane" className={`Content rc-fonts-ItemText ${paneClass}`} dir="ltr" tabIndex={-1} role="main"
        ref={paneRef} data-tele="body"
        style={{ visibility: 'visible', overflow: 'auto', bottom: '33px', height: 'unset', ...paneStyle }}>
        {children}
      </div>
      <NavBar nav={nav} />
    </div>
  );
}
