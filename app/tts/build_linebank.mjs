#!/usr/bin/env node
// Pre-render Monday's fixed lines into the audio cache.
//
// This is the target for `npm run voice:build` (agent D adds the package.json
// entry). It drives the real voice.js interface rather than shelling out to
// Python directly, so a green run here is also an end-to-end check that the
// Node side, the worker protocol and the cache all agree with each other.
//
//   node app/tts/build_linebank.mjs            build the voice, then warm
//   node app/tts/build_linebank.mjs --no-voice skip build_voice.py
//
// Exits non-zero only if the worker never came up; individual line failures are
// reported and skipped, because a missing line means a slower first play, not a
// broken app.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PYTHON = process.env.MONDAY_PYTHON || 'python3';

const { startVoice, warmLineBank, stopVoice, voiceReady, voiceStatus, getLineBank } =
  await import(path.join(HERE, '..', 'server', 'voice.js'));

const skipVoice = process.argv.includes('--no-voice');

if (!skipVoice) {
  console.log('> building the Monday voice tensor');
  const r = spawnSync(PYTHON, [path.join(HERE, 'build_voice.py')], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('build_voice.py failed; the worker will fall back to bm_george');
  }
}

const bank = getLineBank();
console.log(`> line bank: ${bank.lines.length} lines`);

console.log('> starting the voice worker (first run loads Kokoro, ~5s)');
await startVoice({ onAudio: () => {} });

if (!voiceReady()) {
  console.error('voice worker unavailable:', JSON.stringify(voiceStatus()));
  console.error('The app still runs; it will simply be silent.');
  await stopVoice();
  process.exit(1);
}

const result = await warmLineBank();
console.log(`> warmed ${result.rendered}/${result.total} renders`);

const stats = spawnSync(PYTHON, [path.join(HERE, 'monday_tts.py'), '--cache-stats'], {
  encoding: 'utf8',
});
process.stderr.write(stats.stderr || '');

await stopVoice();
process.exit(0);
