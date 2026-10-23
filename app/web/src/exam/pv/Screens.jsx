// Content-pane screens, in the driver markup this simulator uses: Welcome/NDA, the exam overview, each paper's intro, the question item,
// and the Review screen.
import React, { useEffect, useState } from 'react';
import { texToHtml, refreshMathStyles } from './mathjax.js';

const ARIAL = { fontFamily: 'arial', fontSize: '12pt' };

function Root({ children }) {
  return (
    <div id="abe-readMe" className="contentPaneLanguageWrapper dynamicContent heightRoot" dir="ltr" tabIndex={0}>
      <div className="abe-tt abe-content-root undef-width abe-block-leading Block abe-noPadding" style={{ backgroundColor: '#ffffff' }}>
        <div className="sub-root undef-width">
          <div className="abe-tt undef-width abe-block-leading abe-noPadding Block">{children}</div>
        </div>
      </div>
    </div>
  );
}

const P = ({ children, bold }) => (
  <p>{bold ? <b style={ARIAL}>{children}</b> : <span style={ARIAL}>{children}</span>}</p>
);
const Gap = () => <p><span style={ARIAL}>&nbsp;</span></p>;

// ── Welcome ───────────────────────────────────────────────────────────────

export function WelcomeScreen() {
  return (
    <Root>
      <div className="abe-tt undef-width abe-block-leading abe-noPadding Block" data-leafdatatype="text">
        <p className="abe-paragraph-center"><span className="abe-sim-brand">TMUA Practice</span></p>
        <Gap />
        <p><span style={ARIAL}>Welcome to the </span><b style={ARIAL}>Test of Mathematics for University Admission</b><span style={ARIAL}>.</span></p>
        <Gap />
        <P>This is a practice simulation of a computer-based multiple-choice maths test. It is not affiliated with, or endorsed by, any test provider.</P>
        <Gap />
        <p><span style={ARIAL}>Click the </span><b style={ARIAL}>Next (N)</b><span style={ARIAL}>&nbsp;button when you are ready to begin the test.</span></p>
      </div>
    </Root>
  );
}

// ── Tables shared by the overview and intro screens ─────────────────────────

const cell = (first) => ({
  borderCollapse: 'collapse', width: first ? 152 : 153, padding: 2, borderTop: '1px solid black',
  ...(first ? {} : { borderLeft: '1px solid black' }),
});

function SectionTable({ head, rows }) {
  return (
    <div className="abe-tt undef-width abe-block-leading abe-noPadding Block" data-leafdatatype="table_container">
      <div className="table abe-content">
        <table style={{ borderCollapse: 'collapse', borderSpacing: 2, border: '1px solid black' }} bgcolor="#FFFFFF">
          <colgroup width="152" /><colgroup width="153" /><colgroup width="152" />
          <tbody>
            <tr>
              <td style={cell(true)}><p style={{ textAlign: 'left' }}><span style={{ fontFamily: 'Arial', fontSize: '12pt' }}><b>{head}</b></span></p></td>
              <td style={cell(false)}><p style={{ textAlign: 'center' }}><span style={{ fontFamily: 'Arial', fontSize: '12pt' }}><b>Number of Questions</b></span></p></td>
              <td style={cell(true)}><p style={{ textAlign: 'center' }}><span style={{ fontFamily: 'Arial', fontSize: '12pt' }}><b>Time</b></span></p></td>
            </tr>
            {rows.map((r) => (
              <tr key={r.name}>
                <td style={cell(true)}><p style={{ textAlign: 'left' }}><span style={{ fontFamily: 'Arial', fontSize: '12pt' }}>{r.name}</span></p></td>
                <td style={cell(false)}><p style={{ textAlign: 'center' }}><span style={{ fontFamily: 'Arial', fontSize: '12pt' }}>{r.count}</span></p></td>
                <td style={{ ...cell(true), borderLeft: '1px solid black' }}><p style={{ textAlign: 'center' }}><span style={{ fontFamily: 'Arial', fontSize: '12pt' }}>{r.time}</span></p></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export const timeLabel = (durationSec) => (durationSec == null ? 'Untimed' : `${Math.round(durationSec / 60)} minutes`);

/** The exam overview — timed wording from the timed sample, untimed from the untimed one. */
export function OverviewScreen({ sections, timed }) {
  const n = sections.length;
  const word = timed ? (n === 1 ? 'one section' : 'two sections') : (n === 1 ? 'one subtest' : 'two subtests');
  const total = sections[0]?.count ?? 20;
  return (
    <Root>
      <div className="abe-tt undef-width abe-block-leading abe-noPadding Block" data-leafdatatype="text">
        {timed ? <><P bold>You have 1 minute to read these instructions.</P><Gap /></> : null}
        <P>{`This exam consists of ${word}:`}</P>
        <Gap />
      </div>
      <SectionTable head={timed ? 'Section' : 'Subtest'} rows={sections.map((s) => ({ name: s.name, count: s.count, time: timeLabel(s.durationSec) }))} />
      <div className="abe-tt undef-width abe-block-leading abe-noPadding Block" data-leafdatatype="text">
        <Gap />
        <P>For each question, choose the one answer you consider correct.</P>
        <Gap />
        <P>{`There are no penalties for incorrect responses, only marks for correct answers, so you should attempt all ${total} questions${n > 1 && timed ? ' in each section' : ''}. Each question is worth one mark.`}</P>
        <Gap />
        <p><span style={ARIAL}>Please click the </span><b style={ARIAL}>Next (N)</b><span style={ARIAL}> button to proceed.</span></p>
      </div>
    </Root>
  );
}

export function IntroScreen({ section, timed }) {
  return (
    <Root>
      <div className="abe-tt undef-width abe-block-leading abe-noPadding Block" data-leafdatatype="text">
        <P bold>{section.name}</P>
        <Gap />
        {timed ? <><P bold>You have 1 minute to read these instructions.</P><Gap /></> : null}
      </div>
      <SectionTable head="Section" rows={[{ name: section.name, count: section.count, time: timeLabel(section.durationSec) }]} />
      <div className="abe-tt undef-width abe-block-leading abe-noPadding Block" data-leafdatatype="text">
        <Gap />
        <p><span style={ARIAL}>Please click the </span><b style={ARIAL}>Next (N)</b><span style={ARIAL}> button to proceed{timed ? '.' : ''}</span></p>
      </div>
    </Root>
  );
}

// ── Question item ─────────────────────────────────────────────────────────

const SPAN = (inner) => `<p><span style="font-family: arial; font-size: 12pt">${inner}</span></p>`;
// A line that is nothing but display maths sits on the driver's tab stop (~9em in).
const isDisplayLine = (line) => /^\s*\$\$[\s\S]+\$\$\s*$/.test(line);
const LINE = async (line) => (isDisplayLine(line)
  ? `<p><span style="font-family: arial; font-size: 12pt"><span class="tab tab-align-0" style="padding-left: 144px; display: inline-block;"></span>${await texToHtml(`$\\displaystyle ${line.trim().slice(2, -2)}$`)}</span></p>`
  : SPAN(await texToHtml(line)));
const gapHtml = SPAN('&nbsp;');

/** The stem as the driver's paragraphs: each line, a blank paragraph, display/figure after line one. */
async function stemHtml(q, figureUrl) {
  const parts = String(q.stem ?? '').split('\n');
  const block = [];
  if (q.display) block.push(await LINE(q.display));
  // Figures are cropped from 200 dpi renders; the driver shows item images at screen
  // resolution, so they are drawn at 96/200 of their pixel size.
  if (q.figure && figureUrl) block.push(SPAN(`<img src="${figureUrl.replace(/"/g, '&quot;')}" style="vertical-align: middle; zoom: 0.48" alt="">`));
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i].trim()) { out.push(await LINE(parts[i])); out.push(gapHtml); }
    if (i === 0 && block.length) for (const b of block) { out.push(b); out.push(gapHtml); }
  }
  return out.join('');
}

export function ItemScreen({ question, paperId, answer, onAnswer, figureUrl }) {
  const name = `response-${paperId}-${question.qnum}_R`;
  const [html, setHtml] = useState(null);
  useEffect(() => {
    let live = true;
    setHtml(null);
    (async () => {
      const stem = await stemHtml(question, figureUrl);
      const options = {};
      for (const o of question.options) options[o.letter] = SPAN(await texToHtml(o.latex, { displayStyle: true }));
      refreshMathStyles();
      if (live) setHtml({ stem, options });
    })();
    return () => { live = false; };
  }, [question, figureUrl]);
  if (!html) return null;

  return (
    <div key={`${paperId}-${question.qnum}`}>
      <Root>
        <div className="abe-tt undef-width abe-block-leading abe-verticalPadding Block">
          <div className="abe-tt undef-width abe-block-leading abe-noPadding Block" data-leafdatatype="text"
            dangerouslySetInnerHTML={{ __html: html.stem }} />
        </div>
        <div className="abe-tt undef-width abe-block-leading Block abe-noPadding">
          {question.options.map((o) => {
            const id = `${paperId}-${question.qnum}_R.${o.letter}`;
            return (
              <div key={o.letter} className="abe-tt undef-width abe-block-leading abe-verticalPadding Block">
                <div className="abe-tt undef-width abe-block-leading Block abe-noPadding">
                  <div className="abe-tt undef-width abe-block-leading abe-noPadding horizontalParent Block" data-tele={`option-${o.letter}`}>
                    <div className="abe-tt abe-inline undef-width abe-block-leading abe-input-container abe-noPadding Block"
                      data-leafdatatype="radio_button" style={{ width: 30 }}>
                      <label className="abe-tt abe-parentLabel" style={{ display: 'inline-block' }}>
                        <input type="radio" name={name} id={id} value={o.letter} role="radio"
                          checked={answer === o.letter} onChange={() => onAnswer(o.letter)} />
                      </label>
                    </div>
                    <div className="abe-tt abe-inline undef-width abe-block-leading Block abe-noPadding"
                      style={{ marginTop: 2, width: 'calc(100% - 34px)' }}>
                      <div className="abe-tt undef-width abe-block-leading abe-noPadding Block">
                        <div className="abe-tt undef-width abe-block-leading abe-noPadding Block">
                          {/* The whole row is the label: clicking anywhere on it, even far to
                              the right of the text, selects the option — as on the real one. */}
                          <label className="abe-tt abe-defaultLabel undef-width" htmlFor={id} aria-hidden="true"
                            style={{ display: 'inline-block', width: '100%' }}>
                            <div className="abe-tt undef-width abe-block-leading Block abe-noPadding" aria-hidden="true">
                              <div className="abe-tt undef-width abe-block-leading abe-noPadding Block" data-leafdatatype="text"
                                dangerouslySetInnerHTML={{ __html: html.options[o.letter] }} />
                            </div>
                          </label>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Root>
    </div>
  );
}

// ── Review screen ─────────────────────────────────────────────────────────

const TABS = [
  { id: 'All', tip: null },
  { id: 'Incomplete', tip: 'Review questions that are incomplete' },
  { id: 'Unseen', tip: 'Review questions that were not seen' },
  { id: 'Flagged', tip: 'Review questions that are flagged for review' },
];

export function ReviewScreen({ rows, tab, onTab, onReviewItem, onReviewAll }) {
  const counts = {
    All: rows.length,
    Incomplete: rows.filter((r) => r.status === 'Incomplete').length,
    Unseen: rows.filter((r) => r.status === 'Unseen').length,
    Flagged: rows.filter((r) => r.flagged).length,
  };
  // A tab with nothing in it is hidden, as the driver hides "Flagged (0)".
  const visible = TABS.filter((t) => t.id === 'All' || counts[t.id] > 0);
  const shown = rows.filter((r) => tab === 'All' || (tab === 'Flagged' ? r.flagged : r.status === tab));
  const pill = { Complete: 'abe-reviewComplete abe-reviewCompleteLabel', Incomplete: 'abe-reviewIncomplete abe-reviewIncompleteLabel', Unseen: 'abe-reviewUnseen abe-reviewUnseenLabel' };

  return (
    <div className="abe-reviewScreen-2-0" tabIndex={-1}>
      <div className="abe-reviewScreenHeader">
        <div className="abe-reviewTypeTitle-2-0 rc-fonts-Normal"><h3 className="abe-reviewHeading"> Review </h3></div>
        <div id="abe-ReviewAllButtonContainer" className="abe-ReviewButtonContainer">
          <button id="abe-ReviewAllButton" type="button" className="abe-reviewBtn rc-fonts-Normal" data-accesskey="A" accessKey="A"
            style={{ display: 'inline-block' }} data-tele="review-all" onClick={onReviewAll}>
            Review <span className="abe-accesskey">A</span>ll
          </button>
        </div>
      </div>
      <div className="abe-scrollableReviewContent abe-reviewScreenTab" id="scrollableReviewContent" style={{ overflow: 'clip auto', height: 'unset' }}>
        <div className="abe-multipleSections abe-tabbedMultipleSection">
          <div className="abe-reviewScreenSectionTitles">
            <div className="abe-reviewSectionTitles abe-reviewScreenTitleFonts">
              {visible.map((t) => (
                <div key={t.id} id={`tab${t.id}`} className="titleTab">
                  {t.tip ? <span className="abe-reviewScreenToolTip" id={`abe-reviewScreenToolTip${t.id}`} tabIndex={-1}> {t.tip} </span> : null}
                  <button id={t.id} type="button" value={t.id} role="tab" aria-selected={tab === t.id}
                    className={`abe-reviewSectionTitle ui-button${tab === t.id ? ' abe-sectionTitleSelected' : ''}`}
                    data-tele={`review-tab-${t.id}`} onClick={() => onTab(t.id)}>
                    {` ${t.id} `}<div className="abe-reviewTabCount"> ( </div><div id={`${t.id}Count`}>{counts[t.id]}</div><div> ) </div>
                    {t.tip ? <div id={`${t.id}Tooltip`} className="abe-reviewScreenToolTipIcon" /> : null}
                  </button>
                </div>
              ))}
            </div>
          </div>
          <div className="abe-reviewTable" id={`abe-reviewTable-${tab}`}>
            <div className="abe-tbl-content">
              <table className="abe-reviewTableClass" cellPadding={0} cellSpacing={0} border={0} tabIndex={-1}>
                <thead className="abe-reviewTheadClass">
                  <tr className="abe-reviewTrClass abe-reviewThFonts">
                    <th scope="col" className="abe-reviewTdClass abe-reviewTopLeftTableCorner" width="10%">Question</th>
                    <th scope="col" className="abe-reviewTdClass" width="20%">Title</th>
                    <th scope="col" className="abe-reviewTdClass" width="22%">Status</th>
                    <th scope="col" className="abe-reviewTdClass" width="20%">Flagged</th>
                    <th scope="col" className="abe-reviewTdClass abe-reviewTopRightTableCorner" width="15%"><span className="abe-tranparentHeader">Review Buttons </span></th>
                  </tr>
                </thead>
                <tbody className="abe-reviewTbodyClass">
                  {shown.length === 0 ? (
                    <tr className="abe-reviewTrClass"><td className="abe-reviewTdClass" colSpan={5}>No Records Found.</td></tr>
                  ) : shown.map((r) => (
                    <tr key={r.qnum} className="abe-reviewTrClass abe-reviewItemEntry abe-reviewTableRowPosition">
                      <th scope="row" className="abe-reviewTdClass abe-reviewScreenQuestionFont" data-cell="Question">{r.ordinal}</th>
                      <td className="abe-reviewTdClass abe-reviewScreenTitleFont" data-cell="Title"> Question </td>
                      <td className="abe-reviewTdClass" data-cell="Status">
                        <div className={`abe-reviewItemStatus ${pill[r.status]} abe-reviewScreenStatusFont`}> {r.status} </div>
                      </td>
                      {r.flagged ? (
                        <td className="abe-reviewTdClass abe-reviewTdClassFlagged" data-cell="Flagged">
                          <div className="abe-FlagForReviewMain">
                            <div className="abe-FlagForReviewReviewScreenButton-2-0 abe-reviewScreenTitleFont">Yes</div>
                            <div className="abe-FlagForReviewReviewScreen-2-0-ButtonSelected abe-FlagForReviewReviewScreenButtonSelected" />
                          </div>
                        </td>
                      ) : (
                        <td className="abe-reviewTdClass" data-cell="Flagged">
                          <div className="abe-FlagForReviewReviewScreenButton-2-0 abe-reviewScreenTitleFont">No</div>
                        </td>
                      )}
                      <td className="abe-reviewTdClass" style={{ position: 'relative' }}>
                        <div id="abe-reviewItemButton">
                          <button type="button" className="abe-reviewItemBtn abe-reviewItemTitle ui-button"
                            aria-label={`Review Question ${r.ordinal} Question `} data-tele={`review-item-${r.qnum}`}
                            onClick={() => onReviewItem(r.qnum)}>Review</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
