// ACC-HTTP-01..14 — the HTTP surface, over a real socket, against the real index.js
// booted in a sandbox on a spare port. The live app owns :3941 and nothing here goes
// near it or near the real tutor_data tree.
//
// Expectations come from the plan: §1.1 trap 2 (the SPA fallback masks missing assets —
// /assets/* must 404, and .mjs must be in the MIME table), §1.4 (GET/POST
// /api/annotations, autosave flushed by sendBeacon on unload) and §1.6 (a dropped PDF
// lands in the inbox and NOTHING else happens to it).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox } from '../helpers/sandbox.mjs';
import { bootServer, freePort } from '../helpers/boot.mjs';

let box, srv, port, PAPER;

const url = (p) => `http://127.0.0.1:${port}${p}`;
const get = (p) => fetch(url(p));
const postJson = (p, body, contentType = 'application/json') =>
  fetch(url(p), { method: 'POST', headers: { 'content-type': contentType }, body: JSON.stringify(body) });

before(async () => {
  port = await freePort();
  box = makeSandbox({ tag: 'http', port });

  // A built frontend, so "asset missing" and "frontend missing" cannot be confused.
  const dist = path.join(box.appDir, 'web', 'dist', 'assets');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(box.appDir, 'web', 'dist', 'index.html'), '<!doctype html><title>fixture</title>');
  fs.writeFileSync(path.join(dist, 'index-abc123.js'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(dist, 'pdf.worker-def456.mjs'), 'self.onmessage = () => {};\n');

  PAPER = path.join(box.root, 'major exams', 'TMUA 2019 Paper 1.pdf');
  fs.mkdirSync(path.dirname(PAPER), { recursive: true });
  fs.writeFileSync(PAPER, '%PDF-1.4 fixture');
  box.write('file_manifest.json', { generated: 'x', tmua: { 2019: { p1: PAPER } } });

  // A transcribed paper and its key, so the exam routes have something real to serve.
  box.write('exams/questions/her_s1_p1.json', {
    schema_version: 1, paper_id: 'her_s1_p1', set: 'A', paper: 1,
    source: 'JZMaths TMUA Mock Set A Paper 1', pdf: PAPER, transcribed: 'full',
    questions: Array.from({ length: 20 }, (_, i) => ({
      qnum: i + 1, id: `HER_S1_P1_Q${String(i + 1).padStart(2, '0')}`, cid: `JZ-A-P1-Q${String(i + 1).padStart(2, '0')}`,
      pdf_page: i + 2, stem: 'A stem with $x^2$.', display: null,
      options: [{ letter: 'A', latex: '$1$' }, { letter: 'B', latex: '$2$' }], figure: null, classification: null,
    })),
  });
  box.write('exams/answers/her_s1_p1.json', {
    schema_version: 1, paper_id: 'her_s1_p1', ms_pdf: PAPER,
    questions: Array.from({ length: 20 }, (_, i) => ({ qnum: i + 1, answer: 'A', jz_tags: ['General Algebra'], jz_difficulty: 5, solution: null })),
  });

  srv = await bootServer(box, port);
  port = srv.port;   // bootServer may have retried onto a different port
});
after(async () => { await srv?.stop(); box?.dispose(); });

describe('§1.1 trap 2 — a missing asset is a 404, not the SPA shell', () => {
  test('ACC-HTTP-01 an asset that exists is served', async () => {
    const r = await get('/assets/index-abc123.js');
    assert.equal(r.status, 200, 'ACC-HTTP-01 a real asset must still be served');
    assert.match(await r.text(), /export const x/, 'ACC-HTTP-01 and its actual bytes');
  });

  test('ACC-HTTP-02 an asset that does NOT exist 404s instead of returning index.html with a 200', async () => {
    const r = await get('/assets/pdf.worker-WRONGHASH.mjs');
    assert.equal(r.status, 404,
      'ACC-HTTP-02 the SPA fallback is still masking missing assets — a mis-pathed pdf.js worker will fail as a parse error, not a 404');
    assert.ok(!(await r.text()).includes('<!doctype'), 'ACC-HTTP-02 the body must not be the HTML shell');
  });

  test('ACC-HTTP-03 the rule covers any path that asks for a file, not just /assets/', async () => {
    for (const p of ['/nope.js', '/nope.mjs', '/nope.css', '/fonts/nope.woff2', '/cmaps/nope.bcmap']) {
      assert.equal((await get(p)).status, 404, `ACC-HTTP-03 ${p} fell through to the SPA shell`);
    }
  });

  test('ACC-HTTP-04 an extensionless client route still gets index.html — the SPA is not broken', async () => {
    const r = await get('/some/client/route');
    assert.equal(r.status, 200, 'ACC-HTTP-04 client routing must survive the 404 rule');
    assert.match(await r.text(), /<!doctype/i, 'ACC-HTTP-04 it is the shell');
  });

  test('ACC-HTTP-05 .mjs is served as JavaScript, or a module worker refuses to run', async () => {
    const r = await get('/assets/pdf.worker-def456.mjs');
    assert.equal(r.status, 200, 'ACC-HTTP-05 the worker is served');
    assert.match(r.headers.get('content-type') ?? '', /javascript/,
      `ACC-HTTP-05 content-type is "${r.headers.get('content-type')}" — pdfjs-dist ships .mjs and the browser will refuse a non-JS type`);
  });
});

describe('§1.4 GET/POST /api/annotations', () => {
  const marks = {
    7: [
      { type: 'highlight', quads: [[70, 700, 300, 715]], text: 'for all real x' },
      { type: 'ink', paths: [[80, 400], [120, 360], [140, 400]], width: 1.6 },
    ],
  };

  test('ACC-HTTP-06 a paper with no marks reads back an empty, well-formed document', async () => {
    const r = await get(`/api/annotations?path=${encodeURIComponent(PAPER)}`);
    assert.equal(r.status, 200, 'ACC-HTTP-06 status');
    const doc = await r.json();
    assert.equal(doc.schema_version, 1, 'ACC-HTTP-06 schema_version');
    assert.equal(doc.key, 'tmua/2019/p1', 'ACC-HTTP-06 the key comes from the manifest');
    assert.deepEqual(doc.pages, {}, 'ACC-HTTP-06 no marks yet');
  });

  test('ACC-HTTP-07 a path outside the project root is refused', async () => {
    assert.equal((await get('/api/annotations?path=/etc/passwd')).status, 403, 'ACC-HTTP-07 GET');
    assert.equal((await postJson('/api/annotations', { path: '/etc/passwd', pages: {} })).status, 403, 'ACC-HTTP-07 POST');
  });

  test('ACC-HTTP-08 a POST stores the marks and they survive a re-read', async () => {
    const r = await postJson('/api/annotations', { path: PAPER, pages: marks, page_sizes: { 7: [595.28, 841.89] } });
    assert.equal(r.status, 200, 'ACC-HTTP-08 status');
    const body = await r.json();
    assert.equal(body.ok, true, 'ACC-HTTP-08 ok');
    assert.equal(body.changed, true, 'ACC-HTTP-08 the first write changes something');
    assert.equal(body.marks, 2, 'ACC-HTTP-08 both marks were stored');

    const doc = await (await get(`/api/annotations?path=${encodeURIComponent(PAPER)}`)).json();
    assert.equal(doc.pages['7'].length, 2, 'ACC-HTTP-08 read back');
    assert.equal(doc.pages['7'].find((m) => m.type === 'highlight').text, 'for all real x',
      'ACC-HTTP-08 the highlighted text survived the round trip');
    assert.deepEqual(doc.page_sizes['7'], [595.28, 841.89], 'ACC-HTTP-08 the real page geometry was kept');
  });

  test('ACC-HTTP-09 a sendBeacon flush posts text/plain and must still be accepted', async () => {
    // navigator.sendBeacon(url, JSON.stringify(...)) sends text/plain;charset=UTF-8.
    // Refusing on content-type would lose the last strokes of every session.
    const r = await fetch(url('/api/annotations'), {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ path: PAPER, pages: { 7: [...marks['7'], { type: 'arrow', from: [200, 300], to: [260, 250] }] } }),
    });
    assert.equal(r.status, 200, 'ACC-HTTP-09 a beacon was rejected on content-type');
    assert.equal((await r.json()).marks, 3, 'ACC-HTTP-09 the beacon\'s marks landed');
  });

  test('ACC-HTTP-10 re-posting the same marks is idempotent and writes nothing', async () => {
    const doc = await (await get(`/api/annotations?path=${encodeURIComponent(PAPER)}`)).json();
    const again = await (await postJson('/api/annotations', { path: PAPER, pages: doc.pages })).json();
    assert.equal(again.changed, false,
      'ACC-HTTP-10 an unchanged autosave must not rewrite the file — the client flushes on blur, page change, visibilitychange and unload');
    assert.equal(again.marks, 3, 'ACC-HTTP-10 and nothing was lost by the no-op');
  });

  test('ACC-HTTP-11 malformed JSON is a 400, not a 500 and not a corrupted document', async () => {
    const r = await fetch(url('/api/annotations'), { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{oops' });
    assert.equal(r.status, 400, 'ACC-HTTP-11 status');
    const doc = await (await get(`/api/annotations?path=${encodeURIComponent(PAPER)}`)).json();
    assert.equal(doc.pages['7'].length, 3, 'ACC-HTTP-11 the stored document is untouched');
  });

  test('ACC-HTTP-12 the document is written under tutor_data/annotations and nowhere else', () => {
    const file = path.join(box.tutorData, 'annotations', 'tmua__2019__p1.json');
    assert.ok(fs.existsSync(file), `ACC-HTTP-12 expected ${file}`);
    const strays = fs.readdirSync(path.join(box.tutorData, 'annotations')).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(strays, [], `ACC-HTTP-12 temp files left behind: ${strays.join(', ')}`);
  });
});

describe('§1.6 the dropzone files nothing', () => {
  test('ACC-HTTP-13 a dropped PDF lands in the inbox and is not filed, registered or classified', async () => {
    const manifestBefore = box.read('file_manifest.json');
    const r = await postJson('/api/paper', { name: 'scan_0421.pdf', data: Buffer.from('%PDF-1.4 dropped').toString('base64') });
    assert.equal(r.status, 200, 'ACC-HTTP-13 status');
    const body = await r.json();
    assert.equal(body.filed, false, 'ACC-HTTP-13 the response must not claim the file was filed');
    assert.equal(body.path, path.join(box.tutorData, 'inbox', 'scan_0421.pdf'), 'ACC-HTTP-13 it lands in the inbox');

    // Give the watcher every chance to do the thing it must no longer do.
    await new Promise((r2) => setTimeout(r2, 2500));

    assert.ok(fs.existsSync(body.path), 'ACC-HTTP-13 the file is STILL in the inbox — nothing moved it');
    assert.equal(box.read('file_manifest.json'), manifestBefore, 'ACC-HTTP-13 the manifest was modified by a mere drop');
    const exams = path.join(box.root, 'major exams');
    assert.ok(!fs.existsSync(path.join(exams, 'tmua')), 'ACC-HTTP-13 a drop created a filing tree under "major exams"');
    assert.ok(!srv.log().includes('[paper]'), `ACC-HTTP-13 the auto-ingest pipeline ran on a drop:\n${srv.log()}`);
  });

  test('ACC-HTTP-14 the source no longer contains an implicit auto-ingest path', () => {
    const src = fs.readFileSync(path.join(box.serverDir, 'index.js'), 'utf8');
    assert.ok(!/function acceptPaper/.test(src), 'ACC-HTTP-14 acceptPaper is still there');
    assert.ok(!/\benqueuePaper\(/.test(src),
      'ACC-HTTP-14 index.js still enqueues papers itself — the only caller must be the add_paper tool');
  });
});

// ── ACC-HTTP-15..20 — the exam simulator's routes ──────────────────────────────
// The exam surface is reachable over the wire, and the one property that cannot be
// allowed to regress — the answer key staying out of the browser during the sitting —
// is asserted here against a real socket, not only against the module.

describe('exam simulator routes', () => {
  let sittingId;

  test('ACC-HTTP-15 GET /api/exam/papers lists every registry paper', async () => {
    const res = await get('/api/exam/papers');
    assert.equal(res.status, 200);
    const { papers } = await res.json();
    // Counted off the registry, not hard-coded: adding a paper is one row in papers.js.
    const { PAPERS, OFFICIAL_PAPERS } = await import('../../server/papers.js');
    assert.equal(papers.length, OFFICIAL_PAPERS.length + PAPERS.length);
    const one = papers.find((p) => p.id === 'her_s1_p1');
    assert.equal(one.transcribed, 'full');
    assert.equal(one.has_answers, true);
  });

  test('ACC-HTTP-16 POST /api/exam/sitting starts one, and ships no answers', async () => {
    const res = await postJson('/api/exam/sitting', { paperId: 'her_s1_p1', timing: 'real' });
    assert.equal(res.status, 200);
    const body = await res.json();
    sittingId = body.sittingId;
    assert.ok(sittingId);
    assert.equal(body.durationSec, 4500);
    assert.equal(body.questions.length, 20);
    assert.equal(JSON.stringify(body).includes('correctAnswer'), false);
  });

  test('ACC-HTTP-17 an untranscribed paper is refused with 409, not a half-empty sitting', async () => {
    // A registry paper with no transcription yet: registered and tagged, but not sittable.
    const res = await postJson('/api/exam/sitting', { paperId: 'her_s2_p2', timing: 'real' });
    assert.equal(res.status, 409);
  });

  test('ACC-HTTP-18 telemetry is accepted as text/plain, the way sendBeacon posts it', async () => {
    const res = await postJson('/api/exam/events',
      { sittingId, events: [{ t: 1, type: 'question_enter', qnum: 1 }, { t: 2, type: 'click', x: 4, y: 5 }] },
      'text/plain;charset=UTF-8');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).accepted, 2);
  });

  test('ACC-HTTP-19 results are refused until the sitting is finished, then served', async () => {
    const early = await get(`/api/exam/results?id=${sittingId}`);
    assert.equal(early.status, 409);

    await postJson('/api/exam/answer', { sittingId, qnum: 1, choice: 'A' });
    const fin = await postJson('/api/exam/finish', { sittingId, reason: 'submitted' });
    assert.equal(fin.status, 200);

    const res = await get(`/api/exam/results?id=${sittingId}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.score.raw, 1);
    assert.equal(body.score.answered, 1);
    assert.equal(body.questions.find((q) => q.qnum === 1).correctAnswer, 'A');
  });

  test('ACC-HTTP-20 /exam is served the SPA shell, not a 404', async () => {
    const res = await get('/exam');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
  });
});
