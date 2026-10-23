// Native host for the Monday UI (the TMUA tutor).
//
// Previously the .app was a shell script that shelled out to `chrome --app=…` and
// exited, so the Dock and window belonged to Chrome and showed Chrome's icon. This
// hosts the same localhost UI in a WKWebView owned by the bundle, so the bundle's
// AppIcon.icns is what appears in the Dock and the app switcher.
//
// A second WKWebView (videoWeb) hosts real logged-in youtube.com, stripped of
// distractions, overlaid on the main view. The web app positions it by posting
// {action:'show'|'hide'|'rect'|'load', rect:{x,y,w,h}, videoId, t} to the
// `videoPane` script message handler.
//
// Build: see app/scripts/build-app.sh
import Cocoa
import WebKit

let PORT = 3941
let APP_URL = URL(string: "http://localhost:\(PORT)")!
// Monday.app sits at the project root, next to app/.
let SERVER_DIR = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("app").path
let NODE_CANDIDATES = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]

// ---------- YouTube declutter ----------
// One selector list, applied twice: compiled into a WKContentRuleList (fast, applies
// before layout) and injected as document-start CSS by a WKUserScript (survives
// anything the rule list misses, e.g. selectors inside the player iframe DOM that
// only exist after hydration). Rule lists cannot run script, so the autoplay-next
// *switch-off* (not just hiding the toggle) lives in the user script.
let YT_HIDE_SELECTORS = [
  // home feed (search bar stays usable; the grid goes)
  "ytd-browse[page-subtype='home'] ytd-rich-grid-renderer",
  "ytd-browse[page-subtype='home'] ytd-two-column-browse-results-renderer",
  // sidebar recommendations on watch pages
  "ytd-watch-next-secondary-results-renderer",
  "#related",
  // comments
  "ytd-comments#comments",
  "#comments",
  // Shorts shelves + Shorts surfaces
  "ytd-reel-shelf-renderer",
  "ytd-rich-shelf-renderer",
  "ytm-shorts-lockup-view-model",
  "grid-shelf-view-model",
  // end-screen cards / wall + pause overlay
  ".ytp-ce-element",
  ".ytp-endscreen-content",
  ".ytp-pause-overlay",
  // autoplay-next toggle
  ".ytp-autonav-toggle-button-container",
  // navigation drawer + mini guide (Home / Shorts / Subscriptions rabbit holes)
  "tp-yt-app-drawer#guide",
  "ytd-mini-guide-renderer",
  "#guide-button",
  // masthead bait
  "ytd-notification-topbar-button-renderer",
  "ytd-topbar-menu-button-renderer[is-shorts]",
].joined(separator: ", ")

// Safari content-blocker JSON. Ad/tracker hosts blocked outright; YouTube's own
// ad/telemetry endpoints blocked by path (the creative itself streams from
// googlevideo.com, same as the video — path rules are the only handle).
let YT_RULE_JSON = #"""
[
  {"trigger":{"url-filter":"^https?://([^/]+\\.)?doubleclick\\.net/"},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://([^/]+\\.)?googlesyndication\\.com/"},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://([^/]+\\.)?googleadservices\\.com/"},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://([^/]+\\.)?google-analytics\\.com/"},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://([^/]+\\.)?googletagmanager\\.com/"},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://([^/]+\\.)?moatads\\.com/"},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://([^/]+\\.)?adservice\\.google\\.com/"},"action":{"type":"block"}},
  {"trigger":{"url-filter":"/pagead/","if-domain":["*youtube.com"]},"action":{"type":"block"}},
  {"trigger":{"url-filter":"/api/stats/ads","if-domain":["*youtube.com"]},"action":{"type":"block"}},
  {"trigger":{"url-filter":"/ptracking","if-domain":["*youtube.com"]},"action":{"type":"block"}},
  {"trigger":{"url-filter":"/youtubei/v1/log_event","if-domain":["*youtube.com"]},"action":{"type":"block"}},
  {"trigger":{"url-filter":".*","if-domain":["*youtube.com"]},"action":{"type":"css-display-none","selector":"__SELECTORS__"}}
]
"""#.replacingOccurrences(of: "__SELECTORS__", with: YT_HIDE_SELECTORS)

// Document-start declutter script: injects the same CSS, re-attaches it if the SPA
// tears it out, and actually switches autoplay-next OFF whenever YouTube turns it on.
let YT_USER_SCRIPT = #"""
(function () {
  var CSS = "__SELECTORS__ { display: none !important; }";
  function attach() {
    if (document.getElementById('monday-declutter')) return;
    var st = document.createElement('style');
    st.id = 'monday-declutter';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }
  if (document.documentElement) attach();
  else document.addEventListener('DOMContentLoaded', attach);
  new MutationObserver(attach).observe(document.documentElement || document, { childList: true, subtree: true });
  setInterval(function () {
    var b = document.querySelector('.ytp-autonav-toggle-button[aria-checked="true"]');
    if (b) b.click();
  }, 1500);

  // ── clickable speed controller (no extension available in WKWebView) ──────────
  // A small overlay pinned to the top-left of the video: − , the current rate, + ,
  // and a reset. Keyboard: S slower, D faster, R reset — same as the Video Speed
  // Controller extension. The chosen rate persists and re-applies to each new video.
  var RATE_KEY = 'monday-vsc-rate';
  function getRate() { var r = parseFloat(localStorage.getItem(RATE_KEY)); return (r && r > 0) ? r : 1; }
  function clampRate(r) { return Math.min(16, Math.max(0.1, Math.round(r * 100) / 100)); }
  function vid() { return document.querySelector('video'); }
  function apply(r) {
    r = clampRate(r);
    localStorage.setItem(RATE_KEY, String(r));
    var v = vid(); if (v) v.playbackRate = r;
    var lab = document.getElementById('monday-vsc-rate'); if (lab) lab.textContent = r.toFixed(2) + 'x';
    return r;
  }
  function bump(d) { apply(getRate() + d); }
  function build() {
    if (document.getElementById('monday-vsc')) return;
    var host = document.querySelector('.html5-video-player') || document.body;
    if (!host) return;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    var box = document.createElement('div');
    box.id = 'monday-vsc';
    box.style.cssText = 'position:absolute;top:8px;left:8px;z-index:2147483647;display:flex;align-items:center;gap:2px;'
      + 'background:rgba(20,18,15,.72);color:#fff;font:600 12px system-ui,sans-serif;border-radius:8px;padding:3px 4px;'
      + 'opacity:.35;transition:opacity .15s;user-select:none;';
    box.onmouseenter = function () { box.style.opacity = '1'; };
    box.onmouseleave = function () { box.style.opacity = '.35'; };
    function btn(txt, fn, w) {
      var b = document.createElement('button');
      b.textContent = txt;
      b.style.cssText = 'all:unset;cursor:pointer;text-align:center;min-width:' + (w || 20) + 'px;padding:2px 4px;border-radius:5px;';
      b.onmouseenter = function () { b.style.background = 'rgba(255,255,255,.18)'; };
      b.onmouseleave = function () { b.style.background = 'transparent'; };
      b.onclick = function (e) { e.stopPropagation(); e.preventDefault(); fn(); };
      return b;
    }
    box.appendChild(btn('\u2212', function () { bump(-0.25); }));  // −
    var lab = document.createElement('span');
    lab.id = 'monday-vsc-rate'; lab.style.cssText = 'min-width:42px;text-align:center;cursor:pointer;';
    lab.onclick = function (e) { e.stopPropagation(); apply(1); };
    box.appendChild(lab);
    box.appendChild(btn('+', function () { bump(0.25); }));
    box.appendChild(btn('\u21ba', function () { apply(1); }, 22)); // ↺ reset
    host.appendChild(box);
    apply(getRate());
  }
  // Re-apply on new videos (SPA navigation keeps the page) and keep the widget alive.
  setInterval(function () { build(); var r = getRate(); var v = vid(); if (v && Math.abs(v.playbackRate - r) > 0.01) v.playbackRate = r; var lab = document.getElementById('monday-vsc-rate'); if (lab) lab.textContent = r.toFixed(2) + 'x'; }, 1000);
  document.addEventListener('keydown', function (e) {
    if (/^(INPUT|TEXTAREA)$/.test((e.target && e.target.tagName) || '') || e.metaKey || e.ctrlKey) return;
    var k = e.key.toLowerCase();
    if (k === 's') { bump(-0.25); } else if (k === 'd') { bump(0.25); } else if (k === 'r') { apply(1); } else return;
    e.preventDefault();
  }, true);
})();
"""#.replacingOccurrences(of: "__SELECTORS__", with: YT_HIDE_SELECTORS)

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
  var window: NSWindow!
  var web: WKWebView!
  var videoWeb: WKWebView!
  var retries = 0
  // Last rect the web app reported, in CSS px, window top-left origin. Kept so the
  // panel can be re-laid-out on window resize / page zoom without a fresh message.
  var lastVideoRect: (x: Double, y: Double, w: Double, h: Double)?

  // Self-test (used by scripted verification, harmless otherwise): when
  // MONDAY_VIDEO_SELFTEST=1, drive the videoPane contract from Swift after load and
  // write findings + a snapshot to /tmp.
  let selftest = ProcessInfo.processInfo.environment["MONDAY_VIDEO_SELFTEST"] == "1"
  var selftestFired = false

  func applicationDidFinishLaunching(_ note: Notification) {
    buildMenu()

    let cfg = WKWebViewConfiguration()
    cfg.websiteDataStore = .default()
    // Monday speaks through Web Audio. WKWebView defaults to demanding a user
    // gesture before any audio plays, which leaves the AudioContext suspended and
    // silently discards every scheduled buffer — the voice worker runs, chunks
    // arrive, and nothing is ever heard. Empty set = play without a gesture.
    cfg.mediaTypesRequiringUserActionForPlayback = []
    cfg.userContentController.add(self, name: "videoPane")
    web = WKWebView(frame: .zero, configuration: cfg)
    web.navigationDelegate = self
    web.uiDelegate = self
    web.allowsMagnification = true
    // enable the Web Inspector when the app is built for debugging
    if #available(macOS 13.3, *) { web.isInspectable = true }

    // ---------- video webview ----------
    let vcfg = WKWebViewConfiguration()
    // Persistent store: the YouTube login survives app restarts.
    vcfg.websiteDataStore = .default()
    // Same as line 31's rule on the main view: without it the player waits for a
    // gesture and Monday-driven loads sit paused and silent.
    vcfg.mediaTypesRequiringUserActionForPlayback = []
    vcfg.userContentController.addUserScript(WKUserScript(
      source: YT_USER_SCRIPT, injectionTime: .atDocumentStart, forMainFrameOnly: false))
    videoWeb = WKWebView(frame: .zero, configuration: vcfg)
    videoWeb.navigationDelegate = self
    videoWeb.uiDelegate = self
    videoWeb.isHidden = true
    if #available(macOS 13.3, *) { videoWeb.isInspectable = true }

    WKContentRuleListStore.default().compileContentRuleList(
      forIdentifier: "monday-youtube-declutter", encodedContentRuleList: YT_RULE_JSON
    ) { [weak self] list, err in
      if let list = list {
        self?.videoWeb.configuration.userContentController.add(list)
      } else if let err = err {
        self?.slog("rulelist compile FAILED: \(err)")
      }
    }

    let container = NSView(frame: NSRect(x: 0, y: 0, width: 1320, height: 880))
    web.frame = container.bounds
    web.autoresizingMask = [.width, .height]
    container.addSubview(web)
    container.addSubview(videoWeb, positioned: .above, relativeTo: web)

    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1320, height: 880),
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered, defer: false)
    window.title = "Monday"
    // The web app draws its own top bar (the MONDAY wordmark + orb + status). Stacking
    // the OS title bar on top of that looked like two headers and pushed the traffic
    // lights over the web navbar. Make the title bar transparent and let the content
    // fill the whole window; the web side insets its header so the lights sit in clear
    // space (see the .native-app padding).
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    window.isMovableByWindowBackground = false
    window.minSize = NSSize(width: 720, height: 520)
    window.contentView = container
    window.setFrameAutosaveName("TMUAMainWindow")
    window.center()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    NotificationCenter.default.addObserver(
      forName: NSWindow.didResizeNotification, object: window, queue: .main
    ) { [weak self] _ in self?.applyStoredVideoRect() }

    startServerIfNeeded()
    load()
  }

  // ---------- server ----------
  private func portOpen() -> Bool {
    guard let s = try? Data(contentsOf: URL(string: "http://localhost:\(PORT)/api/tree")!) else { return false }
    return !s.isEmpty
  }

  private func startServerIfNeeded() {
    if portOpen() { return }
    guard let node = NODE_CANDIDATES.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
      alert("Node not found", "Looked in:\n" + NODE_CANDIDATES.joined(separator: "\n"))
      return
    }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: node)
    p.arguments = ["server/index.js"]
    p.currentDirectoryURL = URL(fileURLWithPath: SERVER_DIR)
    // Launched from Finder the PATH is bare; poppler (pdftoppm/pdfinfo) lives in Homebrew.
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
    p.environment = env
    let log = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Logs/tmua-tutor.log")
    if !FileManager.default.fileExists(atPath: log.path) {
      FileManager.default.createFile(atPath: log.path, contents: nil)
    }
    if let h = try? FileHandle(forWritingTo: log) {
      h.seekToEndOfFile()
      p.standardOutput = h
      p.standardError = h
    }
    try? p.run()
  }

  private func load() { web.load(URLRequest(url: APP_URL)) }

  // The server may still be booting on a cold start — retry briefly before giving up.
  // Only the main view retries; a cancelled/failed navigation in the video panel must
  // never reload the app shell.
  func webView(_ w: WKWebView, didFail nav: WKNavigation!, withError e: Error) {
    if w === web { retryOrFail() }
  }
  func webView(_ w: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError e: Error) {
    if w === web { retryOrFail() }
  }
  func webView(_ w: WKWebView, didFinish nav: WKNavigation!) {
    if w === web {
      retries = 0
      // The video panel is an overlay the web app positions but does not own.
      // If it is showing when the page reloads, the React component that was
      // keeping track of it is gone and NOTHING is left to take it down — it
      // just sits there as an unclickable rectangle over the workspace. So a
      // main-frame load always starts from hidden; the app re-posts `show` if
      // a video pane is really on screen. This makes a reload the cure for a
      // stuck overlay rather than something that preserves it.
      videoWeb.isHidden = true
      runMainSelftest()
    } else if w === videoWeb {
      scheduleVideoSelftest()
    }
  }

  private func retryOrFail() {
    retries += 1
    if retries > 40 {
      alert("Could not reach the tutor server", "Nothing is answering on localhost:\(PORT).")
      return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.load() }
  }

  // ---------- link handling ----------
  // Main view: mailto: (the EMAIL button) and anything off-localhost must leave the
  // app, or they silently do nothing inside a WKWebView.
  // Video view: the opposite contract — nothing may leave YouTube. Only the video
  // site, its media CDN, and the Google login flow are allowed; everything else is
  // cancelled dead, never bounced to the browser.
  private func videoHostAllowed(_ u: URL) -> Bool {
    if u.scheme == "about" { return true }  // about:blank during player setup
    guard u.scheme == "http" || u.scheme == "https", let host = u.host?.lowercased() else { return false }
    let allowed = ["youtube.com", "youtube-nocookie.com", "youtu.be", "googlevideo.com", "accounts.google.com"]
    return allowed.contains { host == $0 || host.hasSuffix("." + $0) }
  }

  func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if w === videoWeb {
      if let u = action.request.url, videoHostAllowed(u) {
        decisionHandler(.allow)
      } else {
        decisionHandler(.cancel)
      }
      return
    }
    if let u = action.request.url {
      let isLocal = (u.host == "localhost" || u.host == "127.0.0.1")
      if u.scheme == "mailto" || (!isLocal && (u.scheme == "http" || u.scheme == "https")) {
        NSWorkspace.shared.open(u)
        decisionHandler(.cancel)
        return
      }
    }
    decisionHandler(.allow)
  }

  // target="_blank": main view hands PDF/image previews to the default browser; the
  // video view keeps allowed YouTube links in-panel and drops everything else.
  func webView(_ w: WKWebView, createWebViewWith cfg: WKWebViewConfiguration,
               for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if w === videoWeb {
      if let u = action.request.url, videoHostAllowed(u) { videoWeb.load(URLRequest(url: u)) }
      return nil
    }
    if let u = action.request.url { NSWorkspace.shared.open(u) }
    return nil
  }

  // ---------- videoPane contract ----------
  // {action:'show'|'hide'|'rect'|'load', rect:{x,y,w,h}, videoId, t}
  // rect is CSS px relative to the window, top-left origin.
  func userContentController(_ ucc: WKUserContentController, didReceive msg: WKScriptMessage) {
    guard msg.name == "videoPane", let body = msg.body as? [String: Any],
          let action = body["action"] as? String else { return }
    slog("videoPane received action=\(action) body=\(body)")
    switch action {
    case "show":
      if let r = cssRect(body["rect"]) { lastVideoRect = r }
      applyStoredVideoRect()
      videoWeb.isHidden = false
    case "rect":
      if let r = cssRect(body["rect"]) {
        lastVideoRect = r
        applyStoredVideoRect()
      }
    case "hide":
      videoWeb.isHidden = true
    case "load":
      // `load` changes what the panel is showing; it does NOT decide whether the
      // panel is on screen. That belongs to show/hide alone. Un-hiding here made
      // a load from a tab the reader had already switched away from put the
      // overlay back over the app, where nothing was left to take it down.
      guard let id = body["videoId"] as? String, videoIdSafe(id) else {
        // Empty id = "open YouTube to browse": land on the R2Drew TMUA playlist
        // rather than leaving the panel blank. Anything else malformed is refused.
        if (body["videoId"] as? String)?.isEmpty == true {
          if let u = URL(string: "https://www.youtube.com/playlist?list=PL5cY5CwQvGSTTZ4y1wfjw5dpM84h0lL_X") {
            videoWeb.load(URLRequest(url: u))
          }
        } else {
          slog("videoPane load REJECTED bad videoId")
        }
        return
      }
      let t = Int((body["t"] as? Double) ?? Double(body["t"] as? Int ?? 0))
      var s = "https://www.youtube.com/watch?v=\(id)"
      if t > 0 { s += "&t=\(t)s" }
      if let u = URL(string: s) { videoWeb.load(URLRequest(url: u)) }
    default:
      break
    }
  }

  private func videoIdSafe(_ id: String) -> Bool {
    return !id.isEmpty && id.count <= 64 &&
      id.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
  }

  private func cssRect(_ any: Any?) -> (x: Double, y: Double, w: Double, h: Double)? {
    guard let d = any as? [String: Any] else { return nil }
    func num(_ k: String) -> Double? {
      if let v = d[k] as? Double { return v }
      if let v = d[k] as? Int { return Double(v) }
      return nil
    }
    guard let x = num("x"), let y = num("y"), let w = num("w"), let h = num("h") else { return nil }
    return (x, y, w, h)
  }

  // CSS px (top-left origin) → AppKit points (bottom-left origin), honouring the
  // main view's page zoom. Re-run on resize/zoom so the panel stays registered.
  private func applyStoredVideoRect() {
    guard let r = lastVideoRect, let container = window.contentView else { return }
    let z = Double(web.pageZoom)
    let H = Double(container.bounds.height)
    videoWeb.frame = NSRect(
      x: r.x * z,
      y: H - (r.y + r.h) * z,
      width: max(1, r.w * z),
      height: max(1, r.h * z))
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }

  private func alert(_ title: String, _ body: String) {
    let a = NSAlert()
    a.messageText = title
    a.informativeText = body
    a.alertStyle = .critical
    a.runModal()
  }

  // ---------- self-test ----------
  private func slog(_ line: String) {
    guard selftest else { return }
    let path = "/tmp/monday_video_selftest.log"
    let msg = "[\(Date())] \(line)\n"
    if let h = FileHandle(forWritingAtPath: path) {
      h.seekToEndOfFile()
      h.write(msg.data(using: .utf8)!)
      h.closeFile()
    } else {
      try? msg.write(toFile: path, atomically: true, encoding: .utf8)
    }
  }

  // Prove the fixed contract end-to-end: post the exact messages the web half will
  // send, through the same window.webkit.messageHandlers.videoPane channel, from the
  // main page itself.
  private func runMainSelftest() {
    guard selftest, !selftestFired else { return }
    selftestFired = true
    slog("main page loaded; driving videoPane contract via evaluateJavaScript")
    let js = """
    (() => {
      const post = m => window.webkit.messageHandlers.videoPane.postMessage(m);
      post({ action: 'load', videoId: 'aqz-KE-bpKQ', t: 5 });
      post({ action: 'show', rect: { x: 40, y: 60, w: 1000, h: 620 } });
      post({ action: 'rect', rect: { x: 60, y: 80, w: 980, h: 600 } });
      return 'posted';
    })()
    """
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
      self?.web.evaluateJavaScript(js) { res, err in
        self?.slog("main selftest JS -> \(String(describing: res)) err=\(String(describing: err))")
      }
    }
  }

  private func scheduleVideoSelftest() {
    guard selftest else { return }
    slog("videoWeb didFinish url=\(videoWeb.url?.absoluteString ?? "nil")")
    DispatchQueue.main.asyncAfter(deadline: .now() + 10.0) { [weak self] in
      self?.runVideoDomCheck()
      self?.snapshotVideoWeb()
    }
  }

  private func runVideoDomCheck() {
    let js = """
    (() => {
      const vis = s => {
        const e = document.querySelector(s);
        if (!e) return 'absent';
        const r = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        return (cs.display === 'none' || r.width === 0 || r.height === 0) ? 'hidden' : 'VISIBLE';
      };
      const v = document.querySelector('video');
      return JSON.stringify({
        url: location.href,
        title: document.title,
        related: vis('ytd-watch-next-secondary-results-renderer'),
        comments: vis('#comments'),
        shortsShelf: vis('ytd-reel-shelf-renderer'),
        guide: vis('tp-yt-app-drawer#guide'),
        miniGuide: vis('ytd-mini-guide-renderer'),
        endscreen: vis('.ytp-ce-element'),
        autonavToggle: vis('.ytp-autonav-toggle-button-container'),
        homeGrid: vis("ytd-browse[page-subtype='home'] ytd-rich-grid-renderer"),
        video: v ? { paused: v.paused, currentTime: v.currentTime, duration: v.duration, readyState: v.readyState } : null,
        vsc: !!document.getElementById('monday-vsc')
      });
    })()
    """
    videoWeb.evaluateJavaScript(js) { [weak self] res, err in
      self?.slog("DOMCHECK \(String(describing: res)) err=\(String(describing: err))")
    }
    // exercise the speed controller: request 1.5x, then read the video's actual rate
    let vscJS = """
    (() => {
      var v = document.querySelector('video');
      if (v) { localStorage.setItem('monday-vsc-rate','1.5'); v.playbackRate = 1.5; }
      var lab = document.getElementById('monday-vsc-rate');
      return JSON.stringify({ widget: !!document.getElementById('monday-vsc'), rate: v ? v.playbackRate : null, label: lab ? lab.textContent : null });
    })()
    """
    videoWeb.evaluateJavaScript(vscJS) { [weak self] res, err in
      self?.slog("VSC \(String(describing: res)) err=\(String(describing: err))")
    }
  }

  private func snapshotVideoWeb() {
    videoWeb.takeSnapshot(with: nil) { [weak self] img, err in
      guard let img = img, let tiff = img.tiffRepresentation,
            let rep = NSBitmapImageRep(data: tiff),
            let png = rep.representation(using: .png, properties: [:]) else {
        self?.slog("snapshot FAILED err=\(String(describing: err))")
        return
      }
      try? png.write(to: URL(fileURLWithPath: "/tmp/monday_video_selftest.png"))
      self?.slog("snapshot written frame=\(String(describing: self?.videoWeb.frame)) hidden=\(String(describing: self?.videoWeb.isHidden))")
    }
  }

  // ---------- menus ----------
  // Without an explicit Edit menu the standard shortcuts are dead, which would break
  // pasting screenshots into the chat — the main input path for handwritten working.
  private func buildMenu() {
    let main = NSMenu()

    let appItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "About Monday", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Hide Monday", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    appMenu.addItem(withTitle: "Quit Monday", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu
    main.addItem(appItem)

    let editItem = NSMenuItem()
    let edit = NSMenu(title: "Edit")
    edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
    edit.addItem(.separator())
    edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = edit
    main.addItem(editItem)

    let viewItem = NSMenuItem()
    let view = NSMenu(title: "View")
    view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
    view.addItem(withTitle: "Actual Size", action: #selector(zoomReset), keyEquivalent: "0")
    view.addItem(withTitle: "Zoom In", action: #selector(zoomIn), keyEquivalent: "+")
    view.addItem(withTitle: "Zoom Out", action: #selector(zoomOut), keyEquivalent: "-")
    viewItem.submenu = view
    main.addItem(viewItem)

    let winItem = NSMenuItem()
    let win = NSMenu(title: "Window")
    win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    win.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
    winItem.submenu = win
    main.addItem(winItem)
    NSApp.windowsMenu = win

    NSApp.mainMenu = main
  }

  @objc private func reload() { web.reload() }
  @objc private func zoomIn() { web.pageZoom += 0.1; applyStoredVideoRect() }
  @objc private func zoomOut() { web.pageZoom = max(0.4, web.pageZoom - 0.1); applyStoredVideoRect() }
  @objc private func zoomReset() { web.pageZoom = 1.0; applyStoredVideoRect() }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
