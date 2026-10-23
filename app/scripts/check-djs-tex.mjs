// Render every maths island in the DJS question files through KaTeX in strict mode and
// report any that fail — the exam screen would show them as red error text.
import fs from 'node:fs';
import path from 'node:path';
import katex from 'katex';
import { TUTOR_DATA } from '../server/paths.js';

const dir = path.join(TUTOR_DATA, 'exams', 'questions');
let bad = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.startsWith('djs_') || x.startsWith('tmua_') || x.startsWith('euc_'))) {
  const { questions } = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const q of questions) {
    for (const s of [q.stem, ...q.options.map((o) => o.latex)]) {
      for (const m of String(s).matchAll(/\$\$([\s\S]+?)\$\$|\$([^$]+)\$/g)) {
        try { katex.renderToString(m[1] ?? m[2], { throwOnError: true, displayMode: Boolean(m[1]) }); }
        catch (e) { bad += 1; console.log(`${f} Q${q.qnum}: ${e.message.split('\n')[0]}`); }
      }
    }
  }
}
console.log(bad ? `${bad} bad islands` : 'all maths renders');
