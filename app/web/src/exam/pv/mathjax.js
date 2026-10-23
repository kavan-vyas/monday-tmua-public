// MathJax 4 with the STIX2 font — a common choice for computer-based maths tests
// (@mathjax/mathjax-stix2-font + CHTML output, context menu disabled). KaTeX's Computer
// Modern looks nothing like the Times-style maths on the real screen; STIX2 does.
//
// Our transcriptions are TeX, so the input jax is TeX rather than the driver's MathML.
// Served from node_modules by the app server (/vendor/...), never bundled.
let ready = null;

export function loadMathJax() {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    window.MathJax = {
      loader: { paths: { mathjax: '/vendor/mathjax' } },
      tex: {
        inlineMath: [['$', '$']],
        displayMath: [['$$', '$$']],
        processEscapes: false,
      },
      output: {
        font: 'mathjax-stix2',
        fontPath: '/vendor/mathjax-stix2-font',
        // Display lines are indented by Screens.jsx itself (the driver's tab stop).
        displayAlign: 'left',
        displayIndent: '0',
      },
      options: { enableMenu: false, enableExplorerHelp: false, menuOptions: { settings: { help: false } } },
      startup: {
        typeset: false,
        ready() {
          window.MathJax.startup.defaultReady();
          window.MathJax.startup.promise.then(resolve, reject);
        },
      },
    };
    const s = document.createElement('script');
    s.src = '/vendor/mathjax/tex-chtml-nofont.js';
    s.async = true;
    s.onerror = () => reject(new Error('MathJax failed to load'));
    document.head.appendChild(s);
  });
  return ready;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Text with $…$ / $$…$$ islands → HTML, maths converted by MathJax up front.
 *
 * Converting each formula with tex2chtmlPromise and handing React a finished HTML string
 * avoids MathJax's document-wide typeset pass entirely: that pass keeps its own state
 * about which nodes it has seen, and React replacing nodes underneath it left formulas
 * unrendered on every first visit to a question.
 */
export async function texToHtml(text, { displayStyle = false } = {}) {
  await loadMathJax();
  const MJ = window.MathJax;
  const s = String(text ?? '');
  const re = /\$\$([\s\S]+?)\$\$|\$([^$]+)\$/g;
  let out = ''; let last = 0; let m;
  while ((m = re.exec(s))) {
    out += esc(s.slice(last, m.index));
    const display = m[1] != null;
    try {
      // Answer options set their fractions full size, as the real items do.
      const src = display ? m[1] : (displayStyle ? `\\displaystyle ${m[2]}` : m[2]);
      const node = await MJ.tex2chtmlPromise(src, { display });
      out += node.outerHTML;
    } catch {
      out += esc(m[0]);
    }
    last = m.index + m[0].length;
  }
  return out + esc(s.slice(last));
}

/** After a batch of conversions: (re)write MathJax's CHTML stylesheet for every glyph used. */
export function refreshMathStyles() {
  const doc = window.MathJax?.startup?.document;
  if (!doc) return;
  doc.clear();
  doc.updateDocument();
}

/** Typeset maths already in the DOM (dialogs that render plain $…$ text). */
export async function typeset(el) {
  if (!el) return;
  await loadMathJax();
  const MJ = window.MathJax;
  MJ.startup.document.reset();
  await MJ.typesetPromise([el]);
  await MJ.typesetPromise([el]);
}
