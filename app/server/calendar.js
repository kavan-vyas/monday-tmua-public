// Google Calendar, read-only, via each calendar's secret iCal address
// (Calendar settings → "Secret address in iCal format"). No OAuth, no write scope,
// nothing to revoke server-side beyond rotating that URL.
//
// PRIVACY: calendar contents are personal and must never reach the public dashboard.
// Nothing in dashboard.js reads this module, and the config file lives under app/,
// outside tutor_data/ where the published records live.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ical from 'node-ical';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(__dirname, '..', '.calendar.json');
const TTL_MS = 5 * 60 * 1000;

let cache = { at: 0, events: [], errors: [] };

export function readConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    return { calendars: Array.isArray(c.calendars) ? c.calendars : [] };
  } catch {
    return { calendars: [] };
  }
}

export function writeConfig(calendars) {
  const clean = (calendars ?? [])
    .filter((c) => typeof c?.url === 'string' && /^https?:\/\//.test(c.url))
    .map((c) => ({ name: String(c.name ?? 'Calendar').slice(0, 40), url: c.url.trim() }));
  fs.writeFileSync(CONFIG, JSON.stringify({ calendars: clean }, null, 2));
  cache = { at: 0, events: [], errors: [] }; // force refetch
  return clean;
}

// Never hand the secret URLs back to a client — only whether one is configured.
export function safeConfig() {
  return readConfig().calendars.map((c) => ({ name: c.name, host: hostOf(c.url) }));
}
function hostOf(u) { try { return new URL(u).host; } catch { return 'invalid-url'; } }

const dayKey = (d) => {
  const z = new Date(d);
  return `${z.getFullYear()}-${String(z.getMonth() + 1).padStart(2, '0')}-${String(z.getDate()).padStart(2, '0')}`;
};

// Expand one parsed calendar into concrete occurrences inside [from, to].
function expand(parsed, from, to, calName) {
  const out = [];
  for (const ev of Object.values(parsed)) {
    if (!ev || ev.type !== 'VEVENT' || !ev.start) continue;
    const durMs = (ev.end?.getTime?.() ?? ev.start.getTime()) - ev.start.getTime();
    const allDay = ev.datetype === 'date';

    const push = (start) => {
      const end = new Date(start.getTime() + durMs);
      if (end < from || start > to) return;
      out.push({
        title: ev.summary ?? '(untitled)',
        start: start.toISOString(),
        end: end.toISOString(),
        allDay,
        location: ev.location ?? null,
        calendar: calName,
        day: dayKey(start),
      });
    };

    if (ev.rrule) {
      // dates the series would fall on, minus cancellations, plus moved instances
      const ex = new Set(Object.keys(ev.exdate ?? {}).map((k) => k.slice(0, 10)));
      for (const d of ev.rrule.between(from, to, true)) {
        if (ex.has(dayKey(d))) continue;
        const override = ev.recurrences?.[dayKey(d)];
        if (override) {
          const s = override.start ?? d;
          const e = override.end ?? new Date(s.getTime() + durMs);
          if (e >= from && s <= to) {
            out.push({
              title: override.summary ?? ev.summary ?? '(untitled)',
              start: s.toISOString(), end: e.toISOString(), allDay,
              location: override.location ?? ev.location ?? null,
              calendar: calName, day: dayKey(s),
            });
          }
        } else push(d);
      }
    } else {
      push(ev.start);
    }
  }
  return out;
}

// Events between now-ish and `days` ahead. Cached briefly so a chatty UI and the
// tutor tool don't hammer Google.
export async function getSchedule({ days = 7, force = false } = {}) {
  const { calendars } = readConfig();
  if (!calendars.length) return { configured: false, events: [], errors: [] };

  if (!force && Date.now() - cache.at < TTL_MS) {
    return { configured: true, cached: true, ...windowOf(cache.events, days), errors: cache.errors };
  }

  const from = new Date(); from.setHours(0, 0, 0, 0);
  const to = new Date(from.getTime() + 62 * 86400000); // fetch wide, slice per request

  const events = [];
  const errors = [];
  await Promise.all(calendars.map(async (c) => {
    try {
      const parsed = await ical.async.fromURL(c.url);
      events.push(...expand(parsed, from, to, c.name));
    } catch (err) {
      errors.push({ calendar: c.name, error: err.message });
    }
  }));

  events.sort((a, b) => a.start.localeCompare(b.start));
  cache = { at: Date.now(), events, errors };
  return { configured: true, cached: false, ...windowOf(events, days), errors };
}

function windowOf(events, days) {
  const from = new Date(); from.setHours(0, 0, 0, 0);
  const to = new Date(from.getTime() + days * 86400000);
  const inWin = events.filter((e) => new Date(e.end) >= from && new Date(e.start) <= to);
  const today = dayKey(new Date());
  return {
    events: inWin,
    today: inWin.filter((e) => e.day === today),
    next: inWin.find((e) => new Date(e.start) > new Date()) ?? null,
  };
}

// Compact text for the model — cheap to include, easy to read.
export function formatForModel(sched, days) {
  if (!sched.configured) return 'No calendar connected. The student can add one in the app (SCHEDULE tab).';
  if (sched.errors?.length) {
    const e = sched.errors.map((x) => `${x.calendar}: ${x.error}`).join('; ');
    if (!sched.events.length) return `Calendar unavailable — ${e}`;
  }
  if (!sched.events.length) return `Nothing scheduled in the next ${days} days.`;
  const byDay = new Map();
  for (const e of sched.events) {
    if (!byDay.has(e.day)) byDay.set(e.day, []);
    byDay.get(e.day).push(e);
  }
  const fmt = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const lines = [];
  for (const [day, list] of byDay) {
    const d = new Date(day + 'T00:00:00');
    lines.push(`${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}:`);
    for (const e of list) {
      lines.push(`  ${e.allDay ? 'all day' : `${fmt(e.start)}–${fmt(e.end)}`}  ${e.title}${e.location ? ` (${e.location})` : ''}`);
    }
  }
  return lines.join('\n');
}
