// ═══════════════ MONDAY — quick settings popover ═══════════════
//
// The full settings surface is a PANE now (SettingsPane.jsx): it tiles, drags
// and persists like any other tab. This popover survives because a few controls
// are wanted mid-question and are not worth opening a pane for — mute, volume,
// and "stop interrupting me". Everything else is one click away.
//
// The rule the switches enforce has not changed: nothing fires unless its own
// switch is on, and all of it goes quiet in EXAM.
//
// Writes go through `onPatch`, which POSTs /api/config as a sparse patch. The
// server validates and clamps, then echoes the stored config back on the
// `config` event — so what you see here is what was actually kept.

import React from 'react';
import { PROACTIVE_TRIGGERS } from './constants.js';

function Switch({ on, disabled, onChange, label, hint }) {
  return (
    <div className={`sw-row ${disabled ? 'off' : ''}`} onClick={() => !disabled && onChange(!on)}>
      <span className={`sw ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={label}>
        <span className="sw-knob" />
      </span>
      <span className="sw-body">
        <span className="sw-label">{label}</span>
        {hint && <span className="sw-hint">{hint}</span>}
      </span>
    </div>
  );
}

export default function Settings({ voice, proactive, proactiveMaster, onPatch, onClose, onOpenPane, mode }) {
  const examLocked = mode === 'EXAM';
  return (
    <>
      <div className="menu-backdrop" onClick={onClose} />
      <div className="menu settings-pop">
        <div className="set-head">
          <span>Quick settings</span>
          <button
            className="btn tiny"
            onClick={() => { onOpenPane?.(); onClose(); }}
            title="Voice, prosody, model, modes, appearance, study and data"
          >
            All settings
          </button>
        </div>

        <div className="set-group">
          <div className="set-title">Voice</div>
          <Switch
            label="Monday speaks"
            hint={examLocked ? 'forced silent — EXAM mode' : 'local maths TTS, spoken aloud'}
            on={!!voice.enabled && !examLocked}
            disabled={examLocked}
            onChange={(v) => onPatch({ voice: { enabled: v } })}
          />
          <div className="set-vol">
            <span className="set-vol-label">Volume</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              aria-label="Volume"
              value={voice.volume ?? 0.9}
              onChange={(e) => onPatch({ voice: { volume: Number(e.target.value) } })}
            />
            <span className="set-vol-num tabular">{Math.round((voice.volume ?? 0.9) * 100)}%</span>
          </div>
        </div>

        <div className="set-group">
          <div className="set-title">Proactivity</div>
          <Switch
            label="Monday may interrupt"
            hint={examLocked ? 'all triggers suppressed in EXAM' : 'master switch — off means never'}
            on={!!proactiveMaster && !examLocked}
            disabled={examLocked}
            onChange={(v) => onPatch({ proactiveEnabled: v })}
          />
          <div className="set-sub">
            {PROACTIVE_TRIGGERS.map(([key, label, hint]) => (
              <Switch
                key={key}
                label={label}
                hint={hint}
                on={!!proactive[key]}
                disabled={!proactiveMaster || examLocked}
                onChange={(v) => onPatch({ proactive: { ...proactive, [key]: v } })}
              />
            ))}
          </div>
        </div>

        <div className="set-foot">
          Speaking rate, per-mood prosody, model, modes, appearance, the exam date and the
          data paths all live in the settings pane — “All settings”, or ⌘T.
        </div>
      </div>
    </>
  );
}
