// ACC-INT-01/02/03 and ACC-WS-07/08 — the sendUser asymmetry.
//
// The <monday-state> preamble must reach the SDK queue and NOTHING else. If it
// reaches broadcast() it is recorded into chats/<id>.json and, being the first
// user_message, becomes the chat title.
//
// The SDK is mocked so the prompt queue can be read directly.
// Requires --experimental-test-module-mocks.
import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox } from '../helpers/sandbox.mjs';
import { assertMondayState } from '../helpers/assertions.mjs';

let sbx, session, captured;

before(async () => {
  captured = [];
  mock.module('@anthropic-ai/claude-agent-sdk', {
    namedExports: {
      query: (opts) => { captured.push(opts); return (async function* () { /* never yields */ })(); },
      tool: (name, description, inputSchema, handler) => ({ name, description, inputSchema, handler }),
      createSdkMcpServer: (cfg) => ({ type: 'sdk', name: cfg.name, instance: cfg, tools: cfg.tools }),
    },
  });
  sbx = makeSandbox({ tag: 'asym' });
  session = await sbx.imp('session.js');
});
after(() => sbx.dispose());

/** A tutor wired to a recording broadcast, plus a reader for the SDK queue. */
function rig(initialConfig = {}) {
  captured.length = 0;
  const events = [];
  const tutor = session.createTutor(
    (event, record = true) => events.push({ event, record }),
    null, initialConfig, { getChat: () => null },
  );
  const queued = [];
  const drain = async () => {
    const prompt = captured[0]?.prompt;
    if (!prompt) return queued;
    const it = prompt[Symbol.asyncIterator]();
    // The queue's iterator parks for ever once drained, so race each pull.
    for (;;) {
      const next = await Promise.race([it.next(), new Promise((r) => setTimeout(() => r(null), 60))]);
      if (!next || next.done) break;
      queued.push(next.value);
    }
    return queued;
  };
  return { tutor, events, drain };
}

const textOf = (msg) => (msg.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

describe('§D4 the <monday-state> asymmetry', () => {
  test('ACC-INT-01 the state block is prepended to the user message in the SDK queue', async () => {
    const { tutor, drain } = rig();
    tutor.sendUser('How do I differentiate x squared?');
    const q = await drain();
    assert.equal(q.length, 1, 'ACC-INT-01 exactly one message was queued');
    const t = textOf(q[0]);
    assert.ok(t.includes('<monday-state>'), 'ACC-INT-01 no state block in the SDK-bound text');
    assert.ok(t.includes('</monday-state>'), 'ACC-INT-01 the block is not closed');
    assert.ok(t.includes('How do I differentiate x squared?'),
      'ACC-INT-01 the user\'s own text must survive alongside the block');
    assert.ok(t.indexOf('<monday-state>') < t.indexOf('How do I differentiate'),
      'ACC-INT-01 the block must come first — it is a preamble');
  });

  test('ACC-INT-02 the state block NEVER reaches broadcast', async () => {
    const { tutor, events } = rig();
    tutor.sendUser('First message of the chat');
    tutor.sendUser('Second message');
    for (const { event } of events) {
      const blob = JSON.stringify(event);
      assert.ok(!blob.includes('<monday-state>'),
        `ACC-INT-02 a broadcast ${event.type} event carries the state block: ${blob.slice(0, 200)}`);
    }
  });

  test('ACC-INT-02 the RECORDED user_message is the clean text only', async () => {
    const { tutor, events } = rig();
    tutor.sendUser('Clean text only');
    const recorded = events.filter((e) => e.record).map((e) => e.event);
    const um = recorded.find((e) => e.type === 'user_message');
    assert.ok(um, 'ACC-INT-02 a user_message was recorded');
    assert.equal(um.text, 'Clean text only',
      'ACC-INT-02 the recorded transcript text must be exactly what the student typed');
  });

  test('ACC-INT-03 the chat title derived from the first message is free of the state block', async () => {
    const { tutor, events } = rig();
    tutor.sendUser('Sequences question from 2019 paper 1');
    // index.js:141 takes the title from the first recorded user_message.
    const first = events.filter((e) => e.record).map((e) => e.event).find((e) => e.type === 'user_message');
    const title = first.text.slice(0, 48);
    assert.ok(!title.includes('<monday-state>'),
      `ACC-INT-03 the chat title would be "${title}"`);
    assert.ok(!title.includes('mood:'), 'ACC-INT-03 the title carries state-block content');
    assert.equal(title, 'Sequences question from 2019 paper 1', 'ACC-INT-03 the title is the student\'s words');
  });

  test('ACC-WS-07 monday_state is broadcast with record:false', async () => {
    const { tutor, events } = rig();
    tutor.sendUser('anything');
    const ms = events.find((e) => e.event.type === 'monday_state');
    assert.ok(ms, 'ACC-WS-07 a monday_state event was broadcast');
    assert.equal(ms.record, false,
      'ACC-WS-07 monday_state must be record:false — recording it puts state into chats/<id>.json');
    assertMondayState(ms.event, 'monday_state payload');   // ACC-WS-01
  });

  test('ACC-INT-01 a hidden proactive turn reaches the queue but is never broadcast', async () => {
    const { tutor, events, drain } = rig();
    tutor.sendHidden('[proactive: idle_nudge] say something');
    const q = await drain();
    assert.equal(q.length, 1, 'ACC-INT-01 the hidden turn was queued');
    assert.ok(textOf(q[0]).includes('idle_nudge'), 'ACC-INT-01 the instruction is in the queue');
    assert.equal(events.filter((e) => e.event.type === 'user_message').length, 0,
      'ACC-INT-01 a hidden turn must NOT be broadcast as a user_message — it would land in the transcript');
  });

  test('ACC-INT-06 buildSystemPrompt is called with no persona argument', async () => {
    const { tutor } = rig();
    tutor.sendUser('x');
    const opts = captured[0]?.options;
    assert.ok(opts, 'a query was started');
    assert.equal(typeof opts.systemPrompt, 'string', 'ACC-INT-06 a system prompt was built');
    assert.ok(!/PERSONA RULES|PERSONA_BLOCKS/.test(opts.systemPrompt),
      'ACC-INT-06 the frozen system prompt still carries a persona block');
  });

  test('ACC-SELF-05 Bash is disallowed at the SDK level', async () => {
    const { tutor } = rig();
    tutor.sendUser('x');
    const dis = captured[0]?.options?.disallowedTools ?? [];
    assert.ok(dis.includes('Bash'), `ACC-SELF-05 disallowedTools is ${JSON.stringify(dis)} — Bash must be in it`);
  });
});

describe('§D2 tool registration', () => {
  const registeredNames = () => {
    const server = captured[0]?.options?.mcpServers?.tutor;
    return (server?.tools ?? server?.instance?.tools ?? []).map((t) => t.name);
  };

  test('ACC-INT-04 Monday\'s three handlers are registered as SDK tools', async () => {
    const { tutor } = rig();
    tutor.sendUser('x');
    const names = registeredNames();
    for (const t of ['monday_recall', 'monday_note', 'monday_self']) {
      assert.ok(names.includes(t), `ACC-INT-04 ${t} is not registered (registered: ${names.join(', ')})`);
    }
  });

  test('ACC-SELF-03 the registered tool count matches what mondaySelf reports', async () => {
    const { tutor } = rig();
    tutor.sendUser('x');
    const names = registeredNames();
    assert.ok(names.length > 0, 'setup: tools were registered');
    const mem = await sbx.imp('mondaymem.js');
    const self = await mem.mondaySelf();
    assert.equal(self.tool_count, names.length,
      `ACC-SELF-03 mondaySelf reports ${self.tool_count} tools, the SDK server registers ${names.length}`);
    assert.deepEqual([...self.tools].sort(), [...names].sort(),
      'ACC-SELF-03 the reported tool list must be the registered tool list');
  });
});
