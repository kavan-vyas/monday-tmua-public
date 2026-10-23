// ACC-INT-08/09/10/11 and ACC-MODE-03..08 — EXAM must simultaneously mute the
// voice AND suppress every proactive trigger, both enforced in code rather than
// merely asserted in the prompt.
//
// The SDK is driven by hand so a real assistant_delta stream reaches the voice
// gate. Requires --experimental-test-module-mocks.
import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox, defaultTutorData } from '../helpers/sandbox.mjs';
import { TRIGGER_IDS } from '../helpers/assertions.mjs';

let sbx, session, channels;

before(async () => {
  // Voice degraded on purpose: this test is about the GATE, not the worker.
  process.env.MONDAY_PYTHON = '/nonexistent/no/python/here';
  process.env.MONDAY_VOICE_READY_MS = '300';
  channels = [];
  mock.module('@anthropic-ai/claude-agent-sdk', {
    namedExports: {
      query: () => {
        const items = [];
        let notify = null;
        const ch = {
          send(m) { items.push(m); notify?.(); },
          [Symbol.asyncIterator]: async function* () {
            for (;;) {
              while (items.length) yield items.shift();
              await new Promise((r) => { notify = r; });
            }
          },
        };
        channels.push(ch);
        return ch;
      },
      tool: (name, description, inputSchema, handler) => ({ name, description, inputSchema, handler }),
      createSdkMcpServer: (cfg) => ({ type: 'sdk', name: cfg.name, instance: cfg, tools: cfg.tools }),
    },
  });
  sbx = makeSandbox({ tag: 'exam' });
  session = await sbx.imp('session.js');
});
after(() => {
  delete process.env.MONDAY_PYTHON;
  delete process.env.MONDAY_VOICE_READY_MS;
  sbx.dispose();
});

const tick = () => new Promise((r) => setTimeout(r, 40));

/** Start a turn and stream a reply back through the real pump. */
async function reply(config) {
  channels.length = 0;
  const events = [];
  const tutor = session.createTutor((event, record = true) => events.push({ event, record }),
    null, config, { getChat: () => null });
  tutor.sendUser('Explain the chain rule.');
  await tick();
  const ch = channels[0];
  assert.ok(ch, 'setup: a query channel was opened');
  ch.send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'The chain rule says. ' } } });
  ch.send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Differentiate the outside, then the inside. ' } } });
  ch.send({ type: 'assistant', message: { content: [{ type: 'text', text: 'The chain rule says. Differentiate the outside, then the inside.' }] } });
  ch.send({ type: 'result', total_cost_usd: 0, duration_ms: 1, is_error: false });
  await tick();
  return { tutor, events, assistant: events.map((e) => e.event).find((e) => e.type === 'assistant_message') };
}

describe('§D5 the voice gate', () => {
  test('ACC-INT-08 DRILL with voice on engages the speech path', async () => {
    const { assistant } = await reply({ mode: 'DRILL', voice: { enabled: true, volume: 0.9 } });
    assert.ok(assistant, 'setup: an assistant_message was broadcast');
    assert.ok(assistant.utteranceId,
      'ACC-INT-08 no utteranceId — the assistant_delta stream never reached speak()');
  });

  test('ACC-INT-10 EXAM mutes the voice even with config.voice.enabled true', async () => {
    const { assistant } = await reply({ mode: 'EXAM', voice: { enabled: true, volume: 0.9 } });
    assert.ok(assistant, 'setup: an assistant_message was broadcast');
    assert.equal(assistant.utteranceId, null,
      'ACC-INT-10 EXAM produced a spoken utterance — the mode gate is not enforced in code');
  });

  test('ACC-INT-09 config.voice.enabled=false silences DRILL too', async () => {
    const { assistant } = await reply({ mode: 'DRILL', voice: { enabled: false, volume: 0.9 } });
    assert.equal(assistant.utteranceId, null,
      'ACC-INT-09 the user\'s own voice switch was ignored');
  });

  test('ACC-INT-08 both gates are required — either one alone silences', async () => {
    for (const [mode, enabled] of [['EXAM', false], ['EXAM', true], ['DRILL', false]]) {
      const { assistant } = await reply({ mode, voice: { enabled, volume: 0.9 } });
      assert.equal(assistant.utteranceId, null,
        `ACC-INT-08 mode=${mode} voice.enabled=${enabled} still spoke`);
    }
  });

  test('ACC-INT-10 switching into EXAM mid-session cancels the live speech at once', async () => {
    const { tutor, assistant } = await reply({ mode: 'DRILL', voice: { enabled: true, volume: 0.9 } });
    assert.ok(assistant.utteranceId, 'setup: DRILL spoke');
    await tutor.setConfig({ mode: 'EXAM' });
    const st = tutor.getState();
    assert.equal(st.mode, 'EXAM', 'ACC-INT-10 the mode changed');
    assert.equal(st.gates.voiceEnabled, false, 'ACC-INT-10 the gate closed immediately');
    assert.equal(st.mood, 'clinical', 'ACC-MODE-06 the mood locked to clinical on entry');
  });
});

describe('§D5+§B2 EXAM does both things at once', () => {
  test('ACC-INT-11 in one EXAM state, voice is muted AND all seven triggers are suppressed', async () => {
    const { tutor } = await reply({ mode: 'EXAM', voice: { enabled: true, volume: 0.9 } });
    const st = tutor.getState();

    // 1. Voice.
    assert.equal(st.gates.voiceEnabled, false, 'ACC-INT-11 EXAM does not mute the voice');

    // 2. Proactivity, over the same state object the server hands the module.
    const pro = await sbx.imp('proactive.js');
    const emitted = [];
    const queued = [];
    const p = pro.createProactive({
      emit: (e) => emitted.push(e),
      queueInstruction: (s) => queued.push(s),
      getState: () => ({ ...st, proactiveEnabled: true, sessionActive: true, lastUserMessageAt: Date.now() - 60 * 60000 }),
      toggles: Object.fromEntries(TRIGGER_IDS.map((id) => [id, true])),
    });
    assert.equal(st.gates.proactiveEnabled, false, 'ACC-INT-11 the EXAM gate does not close proactivity');
    for (const id of TRIGGER_IDS) {
      assert.equal(p.tick({ force: id }).fired, null, `ACC-INT-11 ${id} fired inside EXAM`);
    }
    assert.equal(emitted.length + queued.length, 0, 'ACC-INT-11 EXAM emitted or queued something');
  });

  test('ACC-MODE-03/04 EXAM forces the timer and refuses hints, in code', async () => {
    const { tutor } = await reply({ mode: 'EXAM' });
    const g = tutor.getState().gates;
    assert.equal(g.timerForced, true, 'ACC-MODE-03');
    assert.equal(g.hintsAllowed, false, 'ACC-MODE-04');
  });

  test('ACC-MODE-08 the gates travel on the state, so the UI cannot disagree with the server', async () => {
    const { tutor } = await reply({ mode: 'EXAM' });
    const modes = await sbx.imp('modes.js');
    assert.deepEqual(tutor.getState().gates, modes.modeGates('EXAM'),
      'ACC-MODE-08 the state\'s gates differ from modeGates(mode)');
  });
});

describe('§C4 the config surface the settings popover writes to', () => {
  test('ACC-CFG-10 setConfig merges without clobbering unrelated switches', async () => {
    const { tutor } = await reply({ mode: 'DRILL', proactive: { late_night: true } });
    const after = await tutor.setConfig({ voice: { enabled: false } });
    assert.equal(after.proactive.late_night, true,
      'ACC-CFG-10 a voice patch reset an unrelated proactive switch');
    assert.equal(after.voice.enabled, false, 'ACC-CFG-10 the patch applied');
    assert.equal(after.voice.volume, 0.9, 'ACC-CFG-10 the omitted volume kept its value');
  });

  test('ACC-CFG-01 a persona key is stripped rather than carried', async () => {
    const { tutor } = await reply({});
    const after = await tutor.setConfig({ persona: 'bubbly' });
    assert.ok(!('persona' in after), 'ACC-CFG-01 setConfig accepted and stored a persona');
  });
});
