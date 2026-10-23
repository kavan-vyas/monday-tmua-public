// ═══════════════ MONDAY — VIDEO pane ═══════════════
// Two completely different rendering strategies behind one component, picked by
// whether we're running inside Monday.app's native shell:
//
//   NATIVE  — window.webkit?.messageHandlers?.videoPane exists. The real video
//             is a native player layered by the app OUTSIDE the web view, on top
//             of this pane. This component never shows video pixels itself; it
//             only tells the native side where to put its player by posting the
//             web-view-relative rect of a placeholder div, plus show/hide/load
//             lifecycle messages.
//
//   BROWSER — no native bridge. Plain <iframe> onto youtube-nocookie, because
//             there's no native player to hand off to.
//
// Props: { videoId, t, ts, title }
//   videoId — YouTube id, or falsy for the empty state
//   t       — start time in seconds
//   ts      — a nonce that changes even when videoId repeats, so "play this same
//             clip again from the top" still fires a fresh `load` message
//   title   — optional display title for the header

import React, { useEffect, useRef } from 'react';

function isNative() {
  try { return !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.videoPane); }
  catch { return false; }
}

function post(msg) {
  try { window.webkit.messageHandlers.videoPane.postMessage(msg); }
  catch { /* bridge gone mid-session — nothing to do about it here */ }
}

function rectOf(el) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
}

/**
 * Is the placeholder actually on screen?
 *
 * A tab that is not the active one in its column stays MOUNTED behind
 * `display:none` (App.jsx renders every tab and hides the inactive ones), so
 * this component's unmount cleanup — the only thing that posted `hide` — never
 * ran when you simply switched tabs. The native YouTube view went on floating
 * over the app at its last rect, as an unclickable white rectangle, and nothing
 * could take it away again.
 */
const onScreen = (rect) => !!rect && rect.w > 0 && rect.h > 0;

/** Native placeholder: posts show/hide/rect/load to the app's message handler
 *  and renders nothing but an empty, precisely-positioned div for the native
 *  layer to sit on top of. */
function NativePane({ videoId, t, ts, title }) {
  const ref = useRef(null);
  const rafId = useRef(null);
  const visibleRef = useRef(false);

  useEffect(() => {
    const el = ref.current;

    // Visibility is derived from the placeholder's own box, so every way of
    // hiding this pane is covered by one rule: switching tabs, collapsing the
    // column, dragging the tab elsewhere, or the window being resized to
    // nothing. Posting `hide` is idempotent on the native side.
    const postRect = () => {
      const rect = rectOf(el);
      const visible = onScreen(rect);
      if (visible !== visibleRef.current) {
        visibleRef.current = visible;
        post(visible ? { action: 'show', rect, videoId, t } : { action: 'hide', videoId, t });
      }
      if (visible) post({ action: 'rect', rect, videoId, t });
    };

    // show + initial rect, on mount
    const first = rectOf(el);
    visibleRef.current = onScreen(first);
    if (visibleRef.current) post({ action: 'show', rect: first, videoId, t });
    postRect();

    // ResizeObserver — element (and therefore layout) size changes
    const ro = new ResizeObserver(() => postRect());
    if (el) ro.observe(el);

    // rAF-throttled scroll listener — position changes from any ancestor
    // scrolling. Capture:true so it fires for scroll on any container, not
    // just window.
    const onScroll = () => {
      if (rafId.current != null) return;
      rafId.current = requestAnimationFrame(() => {
        rafId.current = null;
        postRect();
      });
    };
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onScroll, { passive: true });

    return () => {
      ro.disconnect();
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onScroll);
      if (rafId.current != null) cancelAnimationFrame(rafId.current);
      post({ action: 'hide', videoId, t });
    };
    // mount/unmount only — the load effect below handles videoId/ts changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `load` whenever videoId or ts changes — ts is a nonce specifically so that
  // re-requesting the SAME id (e.g. "play that clip again") still posts.
  useEffect(() => {
    // No specific video -> tell the native panel to open the R2Drew TMUA playlist,
    // so the pane is a browsable YouTube surface rather than a dead placeholder.
    // Never load while hidden. The native `load` handler un-hides the view as a
    // side effect, so loading from behind a hidden tab is a second way to put
    // the overlay back on screen with nobody watching it.
    if (!visibleRef.current) return;
    post({ action: 'load', videoId: videoId || '', t, rect: rectOf(ref.current) });
  }, [videoId, t, ts]);

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {title && <Header title={title} />}
      <div
        ref={ref}
        className="video-native-placeholder"
        style={{
          flex: 1,
          minHeight: 0,
          background: 'var(--sunken)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--r-md)',
          margin: 'var(--sp-6)',
        }}
      />
    </div>
  );
}

/** Browser fallback: a plain youtube-nocookie iframe. */
function BrowserPane({ videoId, t, title }) {
  if (!videoId) {
    // Browse the R2Drew TMUA playlist rather than showing a dead end.
    const listSrc = 'https://www.youtube-nocookie.com/embed/videoseries?list=PL5cY5CwQvGSTTZ4y1wfjw5dpM84h0lL_X&rel=0&modestbranding=1';
    return (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Header title="R2Drew — TMUA playlist" />
        <iframe
          title="R2Drew TMUA playlist"
          src={listSrc}
          style={{ flex: 1, minHeight: 0, border: 0, margin: 'var(--sp-6)', borderRadius: 'var(--r-md)' }}
          allow="accelerometer; autoplay; encrypted-media; picture-in-picture"
          allowFullScreen
        />
      </div>
    );
  }
  if (false) {
    return (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {title && <Header title={title} />}
        <div style={{
          flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 'var(--sp-3)',
          color: 'var(--ink-3)', padding: 'var(--sp-8)', textAlign: 'center',
        }}
        >
          <div style={{ fontSize: 'var(--t-base)', color: 'var(--ink-2)' }}>No video open.</div>
          <div style={{ fontSize: 'var(--t-xs)', maxWidth: '38ch' }}>
            Monday can put one here itself — ask, and it opens one with show_video.
          </div>
        </div>
      </div>
    );
  }

  const src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?start=${Math.max(0, Math.floor(t || 0))}&rel=0&modestbranding=1`;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {title && <Header title={title} />}
      <div style={{ flex: 1, minHeight: 0, padding: 'var(--sp-6)' }}>
        <iframe
          key={src}
          title={title || 'video'}
          src={src}
          style={{ width: '100%', height: '100%', border: '1px solid var(--line)', borderRadius: 'var(--r-md)' }}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      </div>
    </div>
  );
}

function Header({ title }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', gap: 'var(--sp-4)',
      padding: 'var(--sp-5) var(--sp-6) 0',
      fontSize: 'var(--t-xs)', fontWeight: 'var(--fw-medium)', color: 'var(--ink-2)',
    }}
    >
      {title}
    </div>
  );
}

export default function VideoTab(props) {
  const { videoId, t, ts, title } = props ?? {};
  return (
    <div className="tab-fill video-tab" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {isNative()
        ? <NativePane videoId={videoId} t={t} ts={ts} title={title} />
        : <BrowserPane videoId={videoId} t={t} title={title} />}
    </div>
  );
}
