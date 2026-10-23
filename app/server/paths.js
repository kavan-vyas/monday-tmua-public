import path from 'node:path';

import { fileURLToPath } from 'node:url';

// Project root = two levels up from app/server/. Override with MONDAY_ROOT.
export const PROJECT_ROOT = process.env.MONDAY_ROOT
  ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TUTOR_DATA = path.join(PROJECT_ROOT, 'tutor_data');
export const INBOX = path.join(TUTOR_DATA, 'inbox');
// The paper collection. Watched alongside tutor_data so filing, renaming or
// moving a paper shows up in a running app instead of needing a restart.
export const PAPERS = path.join(PROJECT_ROOT, 'major exams');
export const MASTER_PROMPT = path.join(TUTOR_DATA, 'TMUA_Master_Prompt_v3.txt');

export function insideRoot(p) {
  const abs = path.resolve(PROJECT_ROOT, p);
  return abs === PROJECT_ROOT || abs.startsWith(PROJECT_ROOT + path.sep) ? abs : null;
}

export function insideTutorData(p) {
  const abs = path.resolve(PROJECT_ROOT, p);
  return abs === TUTOR_DATA || abs.startsWith(TUTOR_DATA + path.sep) ? abs : null;
}
