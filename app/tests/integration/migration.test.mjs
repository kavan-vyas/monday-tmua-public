// ACC-CFG-01..10 — §C4's .state.json migration, exercised by booting the real
// index.js against a genuine pre-Monday state file and reading back what it wrote.
// The migration lives at module scope in index.js, so this is the only honest way
// to test it.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeSandbox } from '../helpers/sandbox.mjs';
import { bootServer, freePort } from '../helpers/boot.mjs';
import { TRIGGER_IDS } from '../helpers/assertions.mjs';

const servers = [];
const boxes = [];
after(async () => {
  for (const s of servers) await s.stop();
  boxes.forEach((b) => b.dispose());
});

/** The shape .state.json really had before Monday: config with a persona. */
const PRE_MONDAY = {
  activeChatId: null,
  config: { model: 'sonnet', effort: 'high', persona: 'bubbly' },
  inboxSeen: ['tutor_data/inbox/2019-paper1.pdf', 'tutor_data/inbox/notes.pdf'],
};

async function migrate(state) {
  const port = await freePort();
  const box = makeSandbox({ tag: 'mig', port, state });
  boxes.push(box);
  const srv = await bootServer(box, port);
  servers.push(srv);
  await srv.stop();
  return { box, after: JSON.parse(fs.readFileSync(box.stateFile, 'utf8')), srv };
}

describe('§C4 .state.json migration', () => {
  test('ACC-CFG-01/02/03/05/06/07/08 one pass over a real pre-Monday state', async () => {
    const { after: st } = await migrate(PRE_MONDAY);

    // ACC-CFG-08: it got far enough to boot and write, so nothing threw.
    assert.ok(st.config, 'ACC-CFG-08 a config survived the migration');

    // ACC-CFG-01
    assert.ok(!('persona' in st.config),
      `ACC-CFG-01 config.persona survived: ${JSON.stringify(st.config.persona)}`);

    // ACC-CFG-02
    assert.deepEqual(st.config.voice, { enabled: true, volume: 0.9 }, 'ACC-CFG-02 voice defaults');

    // ACC-CFG-03 / ACC-CFG-04
    assert.ok(st.config.proactive, 'ACC-CFG-03 proactive block added');
    for (const id of TRIGGER_IDS) {
      assert.ok(id in st.config.proactive, `ACC-CFG-03 missing trigger switch ${id}`);
      const want = id === 'late_night' ? false : true;
      assert.equal(st.config.proactive[id], want, `ACC-CFG-03 ${id} default should be ${want}`);
    }
    assert.equal(st.config.proactive.late_night, false, 'ACC-CFG-04 late_night off by default');

    // ACC-CFG-05
    assert.equal(typeof st.config.examDate, 'string', 'ACC-CFG-05 examDate added');
    assert.match(st.config.examDate, /^\d{4}-\d{2}-\d{2}$/, 'ACC-CFG-05 examDate is ISO YYYY-MM-DD');

    // ACC-CFG-06
    assert.equal(st.config.model, 'sonnet', 'ACC-CFG-06 model preserved');
    assert.equal(st.config.effort, 'high', 'ACC-CFG-06 effort preserved');

    // ACC-CFG-07 — nothing outside config is lost either.
    assert.deepEqual(st.inboxSeen, PRE_MONDAY.inboxSeen, 'ACC-CFG-07 inboxSeen lost or altered');
  });

  const RICH = {
    activeChatId: null,
    config: { model: 'opus', effort: 'low', persona: 'standard', somethingCustom: 42, nested: { a: 1, b: [2, 3] } },
    inboxSeen: ['x.pdf'],
    aTopLevelExtra: { keep: 'me' },
  };

  test('ACC-CFG-07 every pre-existing config key except persona survives untouched', async () => {
    const { after: st } = await migrate(RICH);
    assert.ok(!('persona' in st.config), 'ACC-CFG-01 persona dropped');
    assert.equal(st.config.model, 'opus', 'ACC-CFG-07 model');
    assert.equal(st.config.effort, 'low', 'ACC-CFG-07 effort');
    assert.equal(st.config.somethingCustom, 42, 'ACC-CFG-07 an unknown config scalar was dropped');
    assert.deepEqual(st.config.nested, { a: 1, b: [2, 3] }, 'ACC-CFG-07 a nested config object was dropped');
    assert.deepEqual(st.inboxSeen, RICH.inboxSeen, 'ACC-CFG-07 inboxSeen');
  });

  test('ACC-CFG-07 a top-level key outside config also survives — "nothing is dropped except persona"', async () => {
    const { after: st } = await migrate(RICH);
    assert.deepEqual(st.aTopLevelExtra, { keep: 'me' },
      'ACC-CFG-07 the migration rebuilds .state.json from three known keys, so any other ' +
      'top-level key is silently discarded. §C4 says the migration loses nothing but persona.');
  });

  test('ACC-CFG-10 user values already set are not clobbered by the defaults', async () => {
    const chosen = {
      activeChatId: null,
      config: {
        model: 'sonnet', effort: 'high', persona: 'bubbly',
        voice: { enabled: false, volume: 0.3 },
        proactive: { late_night: true, idle_nudge: false },
        examDate: '2027-01-09',
      },
      inboxSeen: [],
    };
    const { after: st } = await migrate(chosen);
    assert.equal(st.config.voice.enabled, false, 'ACC-CFG-10 voice.enabled overwritten by the default');
    assert.equal(st.config.voice.volume, 0.3, 'ACC-CFG-10 volume overwritten by the default');
    assert.equal(st.config.proactive.late_night, true, 'ACC-CFG-10 an enabled late_night was reset');
    assert.equal(st.config.proactive.idle_nudge, false, 'ACC-CFG-10 a disabled trigger was re-enabled');
    assert.equal(st.config.examDate, '2027-01-09', 'ACC-CFG-10 a chosen exam date was overwritten');
    // A trigger the user never saw must still arrive with its default.
    assert.equal(st.config.proactive.backlog_due, true, 'ACC-CFG-03 an unseen trigger gets its default');
  });

  test('ACC-CFG-09 the migration is idempotent — a second boot changes nothing', async () => {
    const port = await freePort();
    const box = makeSandbox({ tag: 'mig-idem', port, state: PRE_MONDAY });
    boxes.push(box);

    const first = await bootServer(box, port);
    servers.push(first);
    await first.stop();
    const once = JSON.parse(fs.readFileSync(box.stateFile, 'utf8'));

    const second = await bootServer(box, port);
    servers.push(second);
    await second.stop();
    const twice = JSON.parse(fs.readFileSync(box.stateFile, 'utf8'));

    assert.deepEqual(twice.config, once.config,
      'ACC-CFG-09 the config differs after a second boot — the migration is not idempotent');
  });

  test('ACC-CFG-08 an empty or absent .state.json still boots with a full default config', async () => {
    const { after: st } = await migrate({});
    assert.equal(st.config.model, 'sonnet', 'ACC-CFG-08 model default');
    assert.equal(st.config.voice.enabled, true, 'ACC-CFG-08 voice default');
    assert.equal(Object.keys(st.config.proactive).length, TRIGGER_IDS.length,
      'ACC-CFG-08 all seven trigger switches present');
    assert.ok(!('persona' in st.config), 'ACC-CFG-01');
  });
});
