// The registered tutor tool names, in one place.
//
// Registering a tool is a five-file contract: this list, the startup verification in
// session.js, the tools array itself, the prompt catalogue in prompt.js, the test
// contract list in tests/helpers/assertions.mjs, and the first-person captions in
// web/src/monday/constants.js. Miss one and it fails silently at runtime or loudly in CI.
//
// This lives in its own module rather than in session.js because prompt.js states the
// tool COUNT in the catalogue Monday reads about itself, and prompt.js is imported BY
// session.js — importing back the other way makes a cycle that leaves TOOL_COUNT in the
// temporal dead zone whenever session.js is the entry point. A leaf module has no cycle.
//
// The count is computed, never typed. A hand-kept number goes stale the first time a
// tool is added and becomes a false fact Monday repeats about itself.
export const TOOL_NAMES = [
  'show_pdf', 'get_pdf_page', 'find_in_pdf',
  'read_annotations', 'annotate_pdf', 'clear_annotations',
  'add_backlog', 'list_backlog', 'relabel_backlog',
  'remove_backlog',
  'complete_backlog',
  'read_backlog_notes', 'write_backlog_note',
  'query_tag_index', 'question_profile', 'drill_set', 'index_stats', 'audit_paper',
  'triage_pdf',
  'add_paper', 'file_to_library',
  'show_video', 'find_video',
  'get_schedule', 'start_timer', 'exam_sittings', 'sitting_report', 'log_activity', 'journal_note',
  'monday_recall', 'monday_note', 'monday_self',
];

export const TOOL_COUNT = TOOL_NAMES.length;
