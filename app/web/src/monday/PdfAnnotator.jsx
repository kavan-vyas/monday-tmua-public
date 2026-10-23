// PdfAnnotator — pdf.js canvas rendering + the annotation editor.
//
// One custom overlay owns all four mark types (ink / highlight / arrow /
// freetext), one undo stack, one eraser — not pdf.js's AnnotationEditorLayer
// (plan correction P-6). Everything persisted is PDF user space: points,
// origin bottom-left. toPdf/toCss through the page viewport are the only
// bridges to pixels, which is what keeps a mark drawn at 100% zoom registered
// when viewed at 300% on a different-sized pane.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TextLayer } from 'pdfjs-dist';
import { loadDocument, renderScale, toPdf, toCss, textInRect } from './pdfEngine.js';
import {
  MONDAY_COLOR, STUDENT_COLOR, HIGHLIGHT_COLOR,
  makeInk, makeHighlight, makeArrow, makeFreetext, markDistance,
  applyOp, invertOp, buildSavePayload, mergeServerPages, makeAutosaver,
  anchorAt, scrollDelta,
} from './pdfMarks.js';

const EMPTY = [];
// Pen ink colours the student can pick. Blue is the default; green added on request.
const PEN_COLORS = [['#1b6ef3', 'Blue'], ['#1a9e5c', 'Green']];
// Every PDF opens at 75% (his request). 50% stays the floor of the zoom control.
const DEFAULT_ZOOM = 0.75;
const MIN_ZOOM = 0.5;
const TOOLS = [
  ['pen', '✎', 'Pen — draw freehand'],
  ['highlight', '▆', 'Highlighter — drag over text'],
  ['arrow', '↗', 'Arrow — drag from tail to head'],
  ['text', 'T', 'Note — click to type'],
  ['eraser', '⌫', 'Eraser — click or drag over your marks'],
];

// Font for freetext marks and arrow notes — read once from the design tokens.
let markFont = null;
const fontFamily = () => {
  if (!markFont) markFont = getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim() || 'sans-serif';
  return markFont;
};

// ── mark painting ────────────────────────────────────────────────────────────
function drawMark(ctx, vp, m) {
  const scale = vp.scale;
  const color = m.color ?? (m.author === 'monday' ? MONDAY_COLOR : STUDENT_COLOR);
  ctx.save();
  if (m.type === 'ink' && m.paths?.length) {
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(0.75, (m.width ?? 1.6) * scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    m.paths.forEach((pt, i) => {
      const [x, y] = toCss(vp, pt[0], pt[1]);
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.stroke();
  } else if (m.type === 'highlight') {
    ctx.globalAlpha = 0.32;
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = m.color ?? (m.author === 'monday' ? MONDAY_COLOR : HIGHLIGHT_COLOR);
    for (const q of m.quads ?? []) {
      const [ax, ay] = toCss(vp, q[0], q[1]);
      const [bx, by] = toCss(vp, q[2], q[3]);
      ctx.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
    }
  } else if (m.type === 'arrow' && m.from && m.to) {
    const [x0, y0] = toCss(vp, m.from[0], m.from[1]);
    const [x1, y1] = toCss(vp, m.to[0], m.to[1]);
    drawArrowShape(ctx, x0, y0, x1, y1, color, scale);
    if (m.note) {
      ctx.font = `${Math.max(9, 10 * scale)}px ${fontFamily()}`;
      ctx.fillStyle = color;
      const above = y1 <= y0;
      ctx.textBaseline = above ? 'bottom' : 'top';
      ctx.fillText(m.note, x1 + 4, above ? y1 - 4 : y1 + 4);
    }
  } else if (m.type === 'freetext' && m.text) {
    const at = m.at ?? (m.bbox ? [m.bbox[0], m.bbox[3]] : null);
    if (at) {
      const [x, y] = toCss(vp, at[0], at[1]);
      const px = Math.max(9, 11 * scale);
      ctx.fillStyle = color;
      ctx.font = `${px}px ${fontFamily()}`;
      ctx.textBaseline = 'top';
      m.text.split('\n').forEach((line, i) => ctx.fillText(line, x, y + i * px * 1.3));
    }
  }
  ctx.restore();
}

function drawArrowShape(ctx, x0, y0, x1, y1, color, scale) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1.25, 1.8 * scale);
  ctx.lineCap = 'round';
  const ang = Math.atan2(y1 - y0, x1 - x0);
  const head = Math.max(7, 8 * scale);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - head * Math.cos(ang - 0.45), y1 - head * Math.sin(ang - 0.45));
  ctx.lineTo(x1 - head * Math.cos(ang + 0.45), y1 - head * Math.sin(ang + 0.45));
  ctx.closePath();
  ctx.fill();
}

// In-progress gesture, painted in CSS space (no PDF round-trip until commit).
function drawGesture(ctx, g) {
  if (!g?.pts || g.pts.length === 0) return;
  ctx.save();
  if (g.tool === 'pen') {
    ctx.strokeStyle = g.color || STUDENT_COLOR;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 1; i < g.pts.length; i++) {
      const [ax, ay] = g.pts[i - 1];
      const [bx, by, press] = g.pts[i];
      ctx.lineWidth = Math.max(0.9, 1.6 * g.scale * 2 * (press || 0.5));
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
  } else if (g.tool === 'highlight' && g.pts.length > 1) {
    const [ax, ay] = g.pts[0];
    const [bx, by] = g.pts[g.pts.length - 1];
    ctx.globalAlpha = 0.32;
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = HIGHLIGHT_COLOR;
    ctx.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
  } else if (g.tool === 'arrow' && g.pts.length > 1) {
    const [ax, ay] = g.pts[0];
    const [bx, by] = g.pts[g.pts.length - 1];
    drawArrowShape(ctx, ax, ay, bx, by, g.color || STUDENT_COLOR, g.scale);
  }
  ctx.restore();
}

export default function PdfAnnotator({ pdf, onProps, annBump }) {
  const [doc, setDoc] = useState(null);
  const [err, setErr] = useState(null);
  // 50% by default: fit-width on a tiling pane renders a page far larger than it needs
  // to be read at, and every paper was being zoomed out by hand on open. A tab that
  // already carries its own zoom keeps it — this is the starting point, not an override.
  const [zoom, setZoom] = useState(pdf.zoom ?? DEFAULT_ZOOM);
  // Every OPEN (a new path or a re-open, which stamps a fresh ts) starts at 75% (or the
  // zoom the opener passes), even in
  // a reused tab that was zoomed for the previous paper. Zooming by hand afterwards sticks.
  const openKey = `${pdf.path}|${pdf.ts ?? ''}`;
  const lastOpen = useRef(openKey);
  useEffect(() => {
    if (lastOpen.current === openKey) return;
    lastOpen.current = openKey;
    setZoom(pdf.zoom ?? DEFAULT_ZOOM);   // an opener may ask for its own (the JZ flow uses 100%)
  }, [openKey]);
  const [thumbs, setThumbs] = useState(pdf.thumbs ?? false); // page-preview rail
  const [tool, setTool] = useState(pdf.tool ?? null);
  const [penColor, setPenColor] = useState(pdf.penColor ?? PEN_COLORS[0][0]);
  // Clean view: the PDF file itself is never modified (marks live in a sidecar
  // JSON), so hiding marks IS the unedited paper — for backlog re-attempts.
  // Default ON: a paper opens clean, so a question is read on its own terms before
  // anyone's working is visible. Toggling it off brings the marks back, and the
  // choice rides in tab props, so a pane set to show marks keeps showing them.
  const [hideMarks, setHideMarks] = useState(pdf.hideMarks ?? true);
  const [current, setCurrent] = useState(1);
  const [baseW, setBaseW] = useState(0); // stack width at zoom 1, css px
  const [saveState, setSaveState] = useState('saved');
  const scrollRef = useRef(null);
  const stackRef = useRef(null);
  const rootRef = useRef(null);
  const hoverRef = useRef(false);
  const pageRefs = useRef({});
  const sizesRef = useRef({}); // page -> [w,h], pdf points, for POST page_sizes
  const propsRef = useRef(pdf);
  useEffect(() => { propsRef.current = pdf; }, [pdf]);

  // annotations: { "7": [marks] } in PDF user space; marksV bumps repaints
  const marksRef = useRef({});
  const [marksV, setMarksV] = useState(0);
  const undoRef = useRef({ undo: [], redo: [] });
  const saverRef = useRef(null);

  // load the document; destroy it when the tab closes or the path changes
  useEffect(() => {
    let dead = false;
    let d = null;
    setDoc(null);
    setErr(null);
    pageRefs.current = {};
    sizesRef.current = {};
    loadDocument(pdf.path)
      .then((x) => { if (dead) { x.destroy(); return; } d = x; setDoc(x); })
      .catch((e) => { if (!dead) setErr(String(e?.message ?? e)); });
    return () => { dead = true; d?.destroy(); };
  }, [pdf.path]);

  useEffect(() => {
    let dead = false;
    marksRef.current = {};
    undoRef.current = { undo: [], redo: [] };
    setMarksV((v) => v + 1);
    fetch(`/api/annotations?path=${encodeURIComponent(pdf.path)}`)
      .then((r) => r.json())
      .then((d) => { if (!dead) { marksRef.current = d.pages ?? {}; setMarksV((v) => v + 1); } })
      .catch(() => {});
    return () => { dead = true; };
  }, [pdf.path]);

  // Autosave: ~800ms debounce over dirty pages, author-scoped merge on the
  // server (so this can never wipe a mark Monday drew), sendBeacon flush on
  // anything that could lose the tab. Never a dialog.
  useEffect(() => {
    const saver = makeAutosaver({
      getPayload: (pages) => buildSavePayload(pdf.path, marksRef.current, sizesRef.current, pages),
      post: async (payload) => {
        const r = await fetch('/api/annotations', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!r.ok) throw new Error(`save failed: ${r.status}`);
      },
      beacon: (payload) => navigator.sendBeacon('/api/annotations', JSON.stringify(payload)),
      onState: setSaveState,
    });
    saverRef.current = saver;
    return () => { saver.flush(); saver.dispose(); };
  }, [pdf.path]);

  useEffect(() => {
    const flush = () => saverRef.current?.flush();
    const onVis = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('blur', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('blur', flush);
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  // scrolling onto a different page flushes whatever the last page had pending
  useEffect(() => { saverRef.current?.flush(); }, [current]);

  // Monday drew (annotate_pdf / clear_annotations), or another client saved:
  // refetch and repaint, keeping our own possibly-unsaved marks authoritative.
  useEffect(() => {
    if (!annBump || annBump.path !== pdf.path) return undefined;
    let dead = false;
    fetch(`/api/annotations?path=${encodeURIComponent(pdf.path)}`)
      .then((r) => r.json())
      .then((d) => {
        if (dead) return;
        marksRef.current = mergeServerPages(marksRef.current, d.pages ?? {});
        setMarksV((v) => v + 1);
      })
      .catch(() => {});
    return () => { dead = true; };
  }, [annBump]); // eslint-disable-line

  // ── the one undo/redo stack, all four mark types ──────────────────────────
  function commitOp(op) {
    marksRef.current = applyOp(marksRef.current, op);
    undoRef.current.undo.push(op);
    undoRef.current.redo = [];
    saverRef.current?.markDirty(op.page);
    setMarksV((v) => v + 1);
  }
  function undo() {
    const op = undoRef.current.undo.pop();
    if (!op) return;
    marksRef.current = applyOp(marksRef.current, invertOp(op));
    undoRef.current.redo.push(op);
    saverRef.current?.markDirty(op.page);
    setMarksV((v) => v + 1);
  }
  function redo() {
    const op = undoRef.current.redo.pop();
    if (!op) return;
    marksRef.current = applyOp(marksRef.current, op);
    undoRef.current.undo.push(op);
    saverRef.current?.markDirty(op.page);
    setMarksV((v) => v + 1);
  }

  // ⌘Z / ⇧⌘Z, scoped to this pane being hovered or focused — the global
  // App.jsx keydown handler doesn't own 'z', checked before binding.
  useEffect(() => {
    function onKey(e) {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
      if (!hoverRef.current && !rootRef.current?.contains(document.activeElement)) return;
      const t = e.target;
      if (t?.isContentEditable || /^(input|textarea)$/i.test(t?.tagName ?? '')) return;
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line

  // zoom + tool + clean-view survive tab drags / layout saves via onProps
  useEffect(() => {
    const cur = propsRef.current;
    if ((cur.zoom ?? 1) !== zoom || (cur.tool ?? null) !== tool || (cur.hideMarks ?? false) !== hideMarks
      || (cur.penColor ?? PEN_COLORS[0][0]) !== penColor || (cur.thumbs ?? false) !== thumbs) {
      onProps?.({ ...cur, zoom, tool, hideMarks, penColor, thumbs });
    }
  }, [zoom, tool, hideMarks, penColor, thumbs]); // eslint-disable-line

  // Tab switching. A backgrounded tab is display:none: the layout box goes, and the
  // browser drops scrollTop with it. A ResizeObserver is NOT a dependable witness to
  // that — an element with no box may simply stop being reported — so visibility is
  // watched with an IntersectionObserver, which is the observer that is actually
  // specified to fire when a target stops being rendered.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const io = new IntersectionObserver((entries) => {
      const showing = entries.some((e) => e.isIntersecting);
      if (!showing) {
        if (wasVisible.current) cssWAtHide.current = lastCssW.current;   // freeze the layout we left
        wasVisible.current = false;
        return;
      }
      if (wasVisible.current) return;
      wasVisible.current = true;
      // Two frames: one for the layout box to exist again, one for pdf.js to have
      // settled the page heights, before we put the reader back where they were.
      requestAnimationFrame(() => requestAnimationFrame(() => restorePlaceRef.current?.()));
    }, { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // fit-width base: pages track the pane's width, zoom multiplies it
  useEffect(() => {
    const el = stackRef.current;
    if (!el) return undefined;
    // Capture before setBaseW: at this instant the pages are still laid out at the
    // OLD width, which is the only moment the anchor can be read correctly.
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth || 0;
      const wasHidden = lastStackW.current === 0;
      lastStackW.current = w;
      // A backgrounded tab is display:none, which removes the layout box — and the
      // browser drops scrollTop to 0 with it. So: never read an anchor while hidden or
      // on the frame the pane is revealed (both would record page 1), and when it comes
      // back, put the remembered place back rather than trusting the scroll position.
      if (!wasHidden && w) captureAnchorRef.current?.();
      setBaseW(w);
      if (wasHidden && w) requestAnimationFrame(() => restorePlaceRef.current?.());
    });
    ro.observe(el);
    lastStackW.current = el.clientWidth || 0;
    setBaseW(lastStackW.current);
    return () => ro.disconnect();
  }, []);

  // Declared here, above the anchoring effect that depends on it: a `const` referenced
  // from a hook's dependency array is read DURING render, so declaring it further down
  // puts it in the temporal dead zone and the component throws before it can paint.
  const cssW = Math.max(200, Math.round((baseW || 600) * zoom));

  // ── keeping your place across a resize or a zoom ───────────────────────────
  // Page height is width x aspectRatio, so the moment cssW changes every page
  // grows or shrinks — while scrollTop stays the same NUMBER OF PIXELS. Left
  // alone that silently moves the paper under you: zoom in on question 7 and you
  // land on question 11, and merely dragging the pane wider does the same.
  //
  // So remember where you are as a point in the DOCUMENT — which page, and how far
  // down it — and put that point back under the same part of the viewport once the
  // new layout is in. Anchored on the viewport's centre, because that is what the
  // eye is on when zooming.
  const anchorRef = useRef(null);
  const lastCssW = useRef(0);
  const captureAnchorRef = useRef(null);
  const restoreAnchorRef = useRef(null);
  const lastStackW = useRef(0);
  const scrollTopRef = useRef(0);   // exact pixels, good when nothing rescaled
  const cssWAtHide = useRef(0);     // what the layout was when the pane went away
  const wasVisible = useRef(true);

  const visible = () => {
    const c = scrollRef.current;
    // offsetParent is null under display:none, and a hidden pane has no height —
    // either way every rect is zero and anything read from them is a lie.
    return c && c.offsetParent !== null && c.clientHeight > 0;
  };

  const captureAnchor = useCallback(() => {
    const c = scrollRef.current;
    if (!c || !visible()) return;
    const cRect = c.getBoundingClientRect();
    const pages = [];
    for (const [num, el] of Object.entries(pageRefs.current)) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      pages.push({ page: Number(num), top: r.top, height: r.height });
    }
    const best = anchorAt(pages, { top: cRect.top, height: c.clientHeight });
    if (best) anchorRef.current = best;
  }, []);
  captureAnchorRef.current = captureAnchor;

  const restoreAnchor = useCallback(() => {
    const c = scrollRef.current;
    const a = anchorRef.current;
    const el = a && pageRefs.current[a.page];
    if (!c || !el || !visible()) return;
    const cRect = c.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    c.scrollTop += scrollDelta(a, { top: r.top, height: r.height }, { top: cRect.top, height: c.clientHeight });
  }, []);
  restoreAnchorRef.current = restoreAnchor;

  // Coming back to a backgrounded tab. Two cases, and the cheap one is also the exact
  // one: if nothing rescaled while the pane was away, the pixels we remember are still
  // the right pixels. Only when the width moved in the meantime do we need the anchor,
  // which is an approximation by comparison.
  const restorePlace = useCallback(() => {
    const c = scrollRef.current;
    if (!c || !visible()) return;
    if (cssWAtHide.current && cssWAtHide.current === lastCssW.current && scrollTopRef.current) {
      c.scrollTop = scrollTopRef.current;
      return;
    }
    restoreAnchor();
  }, [restoreAnchor]);
  const restorePlaceRef = useRef(null);
  restorePlaceRef.current = restorePlace;

  useLayoutEffect(() => {
    const prev = lastCssW.current;
    lastCssW.current = cssW;
    // Nothing to restore on the first layout, or when the width did not really move.
    if (!prev || prev === cssW) return;
    restoreAnchor();
  }, [cssW, restoreAnchor]);

  // Jump when Monday (or the arrows) asks for a page; the ts nonce re-fires same-page
  // requests.
  //
  // A single scroll is not enough. When a document has just opened, every page below the
  // fold is still a placeholder of guessed height: pdf.js rasterises them as they come
  // near, and each one that lands at its true height shifts everything under it. Scrolling
  // once, 60ms in, therefore aimed at coordinates that no longer existed a moment later —
  // which is why opening a paper sometimes finished in blank space below the question.
  //
  // So the jump holds the target until the layout stops moving: re-assert the page's
  // position on every frame-ish tick, and stop once it has not moved for a few ticks, or
  // after a second and a half, or the moment the reader touches the scroller — a
  // correction that fights the person scrolling is worse than a bad landing.
  const settledRef = useRef(false);
  useEffect(() => { settledRef.current = false; }, [pdf.path, doc]);
  useEffect(() => {
    if (!pdf.page || !doc) return undefined;
    const c = scrollRef.current;
    if (!c) return undefined;

    let cancelled = false;
    let stable = 0;
    const started = Date.now();
    const target = () => pageRefs.current[pdf.page];

    const align = (smooth) => {
      const el = target();
      if (!el) return false;
      const delta = el.getBoundingClientRect().top - c.getBoundingClientRect().top;
      if (Math.abs(delta) <= 2) return true;
      if (smooth) c.scrollBy({ top: delta, behavior: 'smooth' });
      else c.scrollTop += delta;
      return false;
    };

    // Only the first jump into a freshly opened document is instant; once the layout has
    // settled, moving between pages keeps the smooth scroll it always had.
    const smooth = settledRef.current;
    const kick = setTimeout(() => { align(smooth); setCurrent(pdf.page); }, 60);

    const stop = () => { cancelled = true; };
    const opts = { passive: true };
    for (const ev of ['wheel', 'pointerdown', 'keydown', 'touchstart']) c.addEventListener(ev, stop, opts);

    const tick = setInterval(() => {
      if (cancelled || Date.now() - started > 1500) { clearInterval(tick); settledRef.current = true; return; }
      if (smooth && Date.now() - started < 420) return; // let the smooth scroll finish first
      stable = align(false) ? stable + 1 : 0;
      if (stable >= 4) { clearInterval(tick); settledRef.current = true; }
    }, 80);

    return () => {
      clearTimeout(kick);
      clearInterval(tick);
      for (const ev of ['wheel', 'pointerdown', 'keydown', 'touchstart']) c.removeEventListener(ev, stop, opts);
    };
  }, [pdf.page, pdf.ts, pdf.path, doc]);

  function onScroll() {
    const c = scrollRef.current;
    if (!c) return;
    if (visible()) scrollTopRef.current = c.scrollTop;
    captureAnchor();
    const top = c.getBoundingClientRect().top + 40;
    let best = 1;
    let bestd = Infinity;
    for (const [num, el] of Object.entries(pageRefs.current)) {
      if (!el) continue;
      const d = Math.abs(el.getBoundingClientRect().top - top);
      if (d < bestd) { bestd = d; best = Number(num); }
    }
    setCurrent(best);
  }

  const numPages = doc?.numPages ?? null;
  const jump = (p) => pageRefs.current[Math.min(Math.max(1, p), numPages ?? 1)]?.scrollIntoView({ block: 'start', behavior: 'smooth' });

  return (
    <div
      className="tab-fill pdf-tab"
      ref={rootRef}
      onPointerEnter={() => { hoverRef.current = true; }}
      onPointerLeave={() => { hoverRef.current = false; }}
    >
      <div className="file-toolbar">
        <button className="btn tiny" onClick={() => jump(current - 1)}>◀</button>
        <span className="pgnum">{current}{numPages ? `/${numPages}` : ''}</span>
        <button className="btn tiny" onClick={() => jump(current + 1)}>▶</button>
        <button className="btn tiny" onClick={() => { captureAnchor(); setZoom((z) => Math.max(MIN_ZOOM, +(z - 0.25).toFixed(2))); }}>−</button>
        <span className="pgnum">{Math.round(zoom * 100)}%</span>
        <button className="btn tiny" onClick={() => { captureAnchor(); setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2))); }}>+</button>
        <span className="tool-gap" />
        {TOOLS.map(([t, icon, tip]) => (
          <button
            key={t}
            className={`btn tiny pdf-tool ${tool === t ? 'on' : ''}`}
            title={tip}
            onClick={() => setTool((cur) => {
              const next = cur === t ? null : t;
              // You cannot annotate a hidden layer — picking a tool reveals the marks.
              if (next) setHideMarks(false);
              return next;
            })}
          >{icon}</button>
        ))}
        {(tool === 'pen' || tool === 'arrow') && (
          <span className="pen-swatches">
            {PEN_COLORS.map(([c, name]) => (
              <button
                key={c}
                className={`pen-swatch ${penColor === c ? 'on' : ''}`}
                title={`${name} pen`}
                style={{ background: c }}
                onClick={() => setPenColor(c)}
              />
            ))}
          </span>
        )}
        <button
          className={`btn tiny ${hideMarks ? 'on' : ''}`}
          title={hideMarks ? 'Marks hidden — showing the clean paper' : 'Hide marks — view the clean paper'}
          onClick={() => setHideMarks((h) => !h)}
        >◎</button>
        <button
          className={`btn tiny ${thumbs ? 'on' : ''}`}
          title={thumbs ? 'Hide the page previews' : 'Show page previews'}
          onClick={() => setThumbs((v) => !v)}
        >▤</button>
        <button className="btn tiny" title="Undo (⌘Z)" onClick={undo}>↺</button>
        <button className="btn tiny" title="Redo (⇧⌘Z)" onClick={redo}>↻</button>
        <span className={`pdf-save s-${saveState}`}>
          {saveState === 'saved' ? 'saved' : saveState === 'error' ? 'retrying…' : 'saving…'}
        </span>
        <span className="pdf-name" title={pdf.path}>{pdf.path.split('/').pop()}</span>
        <button className="btn tiny" onClick={() => fetch(`/api/open?path=${encodeURIComponent(pdf.path)}`, { method: 'POST' })}>Open ↗</button>
      </div>
      <div className="pdf-main">
      <div className="pdf-scrollhost">
      <div className="pdf-body" ref={scrollRef} onScroll={onScroll}>
        <div className="pdf-stack pdf-stack-fit" ref={stackRef}>
          {doc && numPages
            ? Array.from({ length: numPages }, (_, i) => i + 1).map((p) => (
                <PdfPage
                  key={p}
                  doc={doc}
                  num={p}
                  cssW={cssW}
                  tool={hideMarks ? null : tool}
                  penColor={penColor}
                  hidden={hideMarks}
                  scrollRef={scrollRef}
                  refCb={(el) => { pageRefs.current[p] = el; }}
                  onSize={(n, s) => { sizesRef.current[String(n)] = s; }}
                  marks={marksRef.current[String(p)] ?? EMPTY}
                  marksV={marksV}
                  onCommit={commitOp}
                />
              ))
            : <div className="pdf-empty">{err ? `COULD NOT RENDER: ${err}` : 'Loading…'}</div>}
        </div>
      </div>
      <PdfScrollbar scrollRef={scrollRef} deps={[doc, numPages, zoom, thumbs]} />
      </div>
      {thumbs && doc && numPages ? (
        <PdfThumbs doc={doc} numPages={numPages} current={current} onJump={jump} />
      ) : null}
      </div>
    </div>
  );
}

/**
 * The reader's scrollbar, drawn by us instead of the platform.
 *
 * macOS scrollbars honour "Jump to the spot that's clicked", and with tap-to-click on a
 * trackpad a light rest of the finger on the track counts as that click — so the document
 * leapt to wherever the pointer happened to be. Hovering did nothing; the tap did, and the
 * two are indistinguishable to the person doing it.
 *
 * This bar therefore does what a scrollbar is expected to do and nothing else: drag the
 * thumb to scroll, click the track to move by one screen, hover to do nothing at all. The
 * native bar is hidden for this pane only — every other scroller in the app keeps the
 * platform's own.
 */
function PdfScrollbar({ scrollRef, deps = [] }) {
  const [geom, setGeom] = useState({ top: 0, size: 0, show: false });
  const dragRef = useRef(null);
  const trackRef = useRef(null);

  const measure = useCallback(() => {
    const c = scrollRef.current;
    const track = trackRef.current;
    if (!c || !track) return;
    const h = track.clientHeight;
    const ratio = c.clientHeight / c.scrollHeight;
    if (!Number.isFinite(ratio) || ratio >= 1) { setGeom((g) => (g.show ? { ...g, show: false } : g)); return; }
    const size = Math.max(28, h * ratio);
    const max = c.scrollHeight - c.clientHeight;
    const top = max > 0 ? (c.scrollTop / max) * (h - size) : 0;
    setGeom({ top, size, show: true });
  }, [scrollRef]);

  useEffect(() => {
    const c = scrollRef.current;
    if (!c) return undefined;
    measure();
    c.addEventListener('scroll', measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(c);
    if (c.firstElementChild) ro.observe(c.firstElementChild);
    return () => { c.removeEventListener('scroll', measure); ro.disconnect(); };
  }, [measure, scrollRef]);

  // Pages rasterise after the doc loads and zoom changes the stack height, and neither
  // fires a scroll event — so remeasure when the things that change the height change.
  useEffect(() => { const t = setTimeout(measure, 60); return () => clearTimeout(t); }, deps); // eslint-disable-line

  function onThumbDown(e) {
    const c = scrollRef.current;
    const track = trackRef.current;
    if (!c || !track) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { y: e.clientY, top: c.scrollTop, h: track.clientHeight, size: geom.size };
  }

  function onThumbMove(e) {
    const d = dragRef.current;
    const c = scrollRef.current;
    if (!d || !c) return;
    const max = c.scrollHeight - c.clientHeight;
    const travel = d.h - d.size;
    if (travel <= 0) return;
    c.scrollTop = Math.min(max, Math.max(0, d.top + ((e.clientY - d.y) / travel) * max));
  }

  const endDrag = () => { dragRef.current = null; };

  return (
    <div className={`pdf-sbar${geom.show ? '' : ' idle'}`} ref={trackRef}>
      <div
        className="pdf-sbar-thumb"
        style={{ transform: `translateY(${geom.top}px)`, height: `${geom.size}px` }}
        onPointerDown={onThumbDown}
        onPointerMove={onThumbMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
    </div>
  );
}

// The page-preview rail. Deliberately its own scroller on the right of the paper: it is
// a map of the document, not part of it, and it must not move when the page does.
// Thumbnails render lazily — a 40-page mark scheme should not rasterise forty times to
// show you six.
function PdfThumbs({ doc, numPages, current, onJump }) {
  const railRef = useRef(null);
  const activeRef = useRef(null);

  // Follow the reader, but only when the rail is not the thing being scrolled.
  const touched = useRef(0);
  useEffect(() => {
    if (Date.now() - touched.current < 1200) return;
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  return (
    <div className="pdf-thumbs" ref={railRef} onScroll={() => { touched.current = Date.now(); }}>
      {Array.from({ length: numPages }, (_, i) => i + 1).map((p) => (
        <button
          key={p}
          className={`pdf-thumb ${p === current ? 'on' : ''}`}
          ref={p === current ? activeRef : null}
          onClick={() => onJump(p)}
          title={`Page ${p}`}
        >
          <PdfThumbCanvas doc={doc} num={p} rootRef={railRef} />
          <span className="pdf-thumb-n">{p}</span>
        </button>
      ))}
    </div>
  );
}

const THUMB_W = 132;

function PdfThumbCanvas({ doc, num, rootRef }) {
  const holdRef = useRef(null);
  const canvasRef = useRef(null);
  const [near, setNear] = useState(false);
  const [ratio, setRatio] = useState('210 / 297');

  useEffect(() => {
    const el = holdRef.current;
    if (!el) return undefined;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setNear(true); io.disconnect(); }
    }, { root: rootRef.current, rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [rootRef]);

  useEffect(() => {
    if (!near) return undefined;
    let dead = false;
    let task = null;
    doc.getPage(num).then((page) => {
      if (dead) return;
      const base = page.getViewport({ scale: 1 });
      setRatio(`${base.width} / ${base.height}`);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const vp = page.getViewport({ scale: (THUMB_W / base.width) * dpr });
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      task = page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp });
      task.promise.catch(() => {});
    }).catch(() => {});
    return () => { dead = true; try { task?.cancel(); } catch { /* already done */ } };
  }, [near, doc, num]);

  return (
    <span className="pdf-thumb-hold" ref={holdRef} style={{ aspectRatio: ratio }}>
      <canvas ref={canvasRef} />
    </span>
  );
}

// One page: HiDPI render canvas + selectable text layer + the annotation
// overlay. Rendering is lazy (first approach of the viewport); the overlay
// repaints on every marks change, which is cheap next to a pdf.js render.
function PdfPage({ doc, num, cssW, tool, hidden, penColor, scrollRef, refCb, onSize, marks, marksV, onCommit }) {
  const [page, setPage] = useState(null);
  const [near, setNear] = useState(false);
  const [size, setSize] = useState(null); // [w,h] in pdf points
  const [editor, setEditor] = useState(null); // {x, y} css — open freetext input
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const textRef = useRef(null);
  const overlayRef = useRef(null);
  const editRef = useRef(null);
  const drawRef = useRef(null); // in-progress gesture
  const textContentRef = useRef(null); // cached page.getTextContent() promise
  const marksLive = useRef(marks);
  useEffect(() => { marksLive.current = marks; }, [marks]);

  useEffect(() => {
    let dead = false;
    doc.getPage(num).then((p) => {
      if (dead) return;
      const v = p.getViewport({ scale: 1 });
      setPage(p);
      setSize([v.width, v.height]);
      onSize(num, [v.width, v.height]);
    }).catch(() => {});
    return () => { dead = true; };
  }, [doc, num]); // eslint-disable-line

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const io = new IntersectionObserver(
      (es) => setNear(es.some((e) => e.isIntersecting)),
      { root: scrollRef.current, rootMargin: '900px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []); // eslint-disable-line

  // Far-off pages release their canvases — a long paper scrolled end to end
  // would otherwise hold every page's bitmap at once (GBs at Retina DPR).
  useEffect(() => {
    if (near) return;
    for (const r of [canvasRef, overlayRef]) {
      const cv = r.current;
      if (cv?.width) { cv.width = 0; cv.height = 0; }
    }
    if (textRef.current) textRef.current.textContent = '';
  }, [near]);

  useEffect(() => {
    if (!page || !near || !canvasRef.current) return undefined;
    const scale = cssW / (size?.[0] || cssW);
    const { device } = renderScale(scale);
    const cv = canvasRef.current;
    const dvp = page.getViewport({ scale: device });
    cv.width = Math.floor(dvp.width);
    cv.height = Math.floor(dvp.height);
    const task = page.render({ canvas: cv, canvasContext: cv.getContext('2d'), viewport: dvp });
    task.promise.catch(() => {}); // cancellation mid-resize is routine
    const tl = textRef.current;
    let layer = null;
    if (tl) {
      tl.textContent = '';
      const vp = page.getViewport({ scale });
      tl.style.setProperty('--scale-factor', String(vp.scale));
      layer = new TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp });
      layer.render().catch(() => {});
    }
    return () => {
      try { task.cancel(); } catch { /* already done */ }
      try { layer?.cancel(); } catch { /* already done */ }
    };
  }, [page, near, cssW, size]);

  // repaint committed marks + any in-progress gesture
  function paint(gesture) {
    const cv = overlayRef.current;
    if (!cv || !page || !size) return;
    const scale = cssW / size[0];
    const { device, dpr } = renderScale(scale);
    const w = Math.floor(size[0] * device);
    if (cv.width !== w) { cv.width = w; cv.height = Math.floor(size[1] * device); }
    const vp = page.getViewport({ scale });
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vp.width, vp.height);
    if (hidden) return; // clean view — the unedited paper
    for (const m of marksLive.current) drawMark(ctx, vp, m);
    if (gesture) drawGesture(ctx, gesture);
  }

  useEffect(() => {
    if (near) paint(drawRef.current);
  }, [page, near, cssW, size, marks, marksV, hidden]); // eslint-disable-line

  // ── pointer gestures on the overlay ───────────────────────────────────────
  const geom = () => {
    const scale = cssW / size[0];
    return { scale, vp: page.getViewport({ scale }), rect: overlayRef.current.getBoundingClientRect() };
  };

  function eraseAt(g, xCss, yCss) {
    const [xp, yp] = toPdf(g.vp, xCss, yCss);
    const thresh = 10 / g.vp.scale; // ~10 css px, in pdf points
    let best = null;
    let bestd = Infinity;
    for (const m of marksLive.current) {
      if (m.author === 'monday') continue; // Monday's marks are cleared by Monday
      if (g.erased.has(m.id)) continue;
      const d = markDistance(m, xp, yp);
      if (d < bestd) { bestd = d; best = m; }
    }
    if (best && bestd <= thresh) {
      g.erased.add(best.id);
      onCommit({ op: 'remove', page: num, mark: best });
    }
  }

  function onPointerDown(e) {
    if (!tool || !page || !size || e.button !== 0) return;
    e.preventDefault();
    const g = { tool, color: penColor, ...geom(), pts: [], erased: new Set() };
    const x = e.clientX - g.rect.left;
    const y = e.clientY - g.rect.top;
    if (tool === 'text') {
      setEditor({ x, y });
      return;
    }
    overlayRef.current.setPointerCapture(e.pointerId);
    drawRef.current = g;
    if (tool === 'eraser') { eraseAt(g, x, y); return; }
    g.pts.push([x, y, e.pressure || 0.5]);
    paint(g);
  }

  function onPointerMove(e) {
    const g = drawRef.current;
    if (!g) return;
    const x = e.clientX - g.rect.left;
    const y = e.clientY - g.rect.top;
    if (g.tool === 'eraser') { eraseAt(g, x, y); return; }
    const last = g.pts[g.pts.length - 1];
    if (last && Math.hypot(x - last[0], y - last[1]) < 1.5) return;
    g.pts.push([x, y, e.pressure || 0.5]);
    paint(g);
  }

  function onPointerUp(e) {
    const g = drawRef.current;
    drawRef.current = null;
    if (!g || g.tool === 'eraser') { paint(null); return; }
    const x = e.clientX - g.rect.left;
    const y = e.clientY - g.rect.top;
    if (!g.pts.length || Math.hypot(x - g.pts[g.pts.length - 1][0], y - g.pts[g.pts.length - 1][1]) >= 1) {
      g.pts.push([x, y, e.pressure || 0.5]);
    }
    finishGesture(g);
  }

  function onPointerCancel() {
    drawRef.current = null;
    paint(null);
  }

  function finishGesture(g) {
    if (g.tool === 'pen' && g.pts.length >= 2) {
      const paths = g.pts.map(([x, y]) => toPdf(g.vp, x, y));
      const avg = g.pts.reduce((s, p) => s + (p[2] || 0.5), 0) / g.pts.length;
      const width = Math.min(4, Math.max(0.8, 1.6 * 2 * avg)); // e.pressure: mouse=0.5 → 1.6
      const mark = makeInk(paths, { width, color: g.color });
      if (mark) onCommit({ op: 'add', page: num, mark });
    } else if (g.tool === 'arrow' && g.pts.length >= 2) {
      const from = toPdf(g.vp, g.pts[0][0], g.pts[0][1]);
      const to = toPdf(g.vp, g.pts[g.pts.length - 1][0], g.pts[g.pts.length - 1][1]);
      const mark = makeArrow(from, to, { color: g.color });
      if (mark) onCommit({ op: 'add', page: num, mark });
      else paint(null);
    } else if (g.tool === 'highlight' && g.pts.length >= 2) {
      const [ax, ay] = g.pts[0];
      const [bx, by] = g.pts[g.pts.length - 1];
      if (Math.abs(bx - ax) < 3 && Math.abs(by - ay) < 3) { paint(null); return; }
      const [px0, py0] = toPdf(g.vp, ax, ay);
      const [px1, py1] = toPdf(g.vp, bx, by);
      const quad = [Math.min(px0, px1), Math.min(py0, py1), Math.max(px0, px1), Math.max(py0, py1)];
      // the captured text is the field that makes a highlight meaningful to Monday
      textContentRef.current ??= page.getTextContent();
      textContentRef.current.then((tc) => {
        const text = textInRect(tc, g.vp, [ax, ay, bx, by]);
        const mark = makeHighlight([quad], text);
        if (mark) onCommit({ op: 'add', page: num, mark });
      }).catch(() => {
        const mark = makeHighlight([quad], '');
        if (mark) onCommit({ op: 'add', page: num, mark });
      });
    } else {
      paint(null);
    }
  }

  // freetext input — a floating box; blur or Enter commits, Escape cancels
  useEffect(() => {
    if (editor) setTimeout(() => editRef.current?.focus(), 0);
  }, [editor]);

  function commitText() {
    const el = editRef.current;
    const ed = editor;
    setEditor(null);
    if (!el || !ed || !page || !size) return;
    const text = el.innerText;
    if (!text.trim()) return;
    const { scale, vp } = geom();
    const at = toPdf(vp, ed.x, ed.y);
    const wh = [el.offsetWidth / scale, el.offsetHeight / scale];
    const mark = makeFreetext(at, text, wh);
    if (mark) onCommit({ op: 'add', page: num, mark });
  }

  const ratio = size ? `${size[0]} / ${size[1]}` : '210 / 297';
  const scaleNow = size ? cssW / size[0] : 1;
  return (
    <div
      className="pdf-pagewrap"
      ref={(el) => { wrapRef.current = el; refCb(el); }}
      style={{ width: cssW, aspectRatio: ratio }}
    >
      <canvas ref={canvasRef} className="pdf-render" />
      <div ref={textRef} className="textLayer" />
      <canvas
        ref={overlayRef}
        className={`pdf-overlay ${tool ? `t-${tool}` : ''}`}
        style={{ pointerEvents: tool ? 'auto' : 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      />
      {editor && (
        <div
          ref={editRef}
          className="pdf-freetext-input"
          contentEditable
          suppressContentEditableWarning
          style={{ left: editor.x, top: editor.y, fontSize: Math.max(9, 11 * scaleNow) }}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); editRef.current.textContent = ''; setEditor(null); }
            else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText(); }
          }}
        />
      )}
      <span className="pdf-pageno">{num}</span>
    </div>
  );
}
