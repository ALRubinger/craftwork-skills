// Regression guard for feedback #8: the Resolve stage runs park subagents in
// PARALLEL over a SHARED working tree (no isolation: 'worktree'). The old
// parkPrompt told every subagent to fetch its issue body into a FIXED filename
// `body.md`, so two concurrent parks raced on the same path — A wrote #1206's
// body, B clobbered it with #1190's, then A appended its open-questions and
// pushed #1190's content onto #1206. The fix: route the write-back through a
// per-issue, collision-free sink and add a title/Observation match guard that
// aborts the write when the read was contaminated.
//
// parkPrompt is a non-exported template-string builder inside workflow.js, so —
// like mirror.test.mjs — we assert against the extracted source of that builder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const workflowSrc = readFileSync(join(here, '..', 'workflow.js'), 'utf8');

// Extract the `const parkPrompt = ...` assignment. The builder is one outer
// template literal that NESTS inner template literals inside `${...}`
// interpolations (the umbrella/open-questions ternary), so brace/backtick
// matching is fragile. Instead, slice from this declaration up to the start of
// the next top-level `const NAME =` declaration — a stable, syntax-light anchor
// that captures the whole builder regardless of nested literals.
function extractParkPrompt(src) {
  const start = src.indexOf('const parkPrompt =');
  assert.notEqual(start, -1, 'const parkPrompt not found in workflow.js');
  const next = src.indexOf('\nconst ', start + 1);
  assert.notEqual(next, -1, 'no declaration follows parkPrompt');
  return src.slice(start, next);
}

const parkPromptSrc = extractParkPrompt(workflowSrc);

test('parkPrompt no longer routes the body through a shared `body.md` file', () => {
  // The shared mutable filename is the exact collision the operator hit; it must
  // be gone entirely (not as a destination, not as a --body-file argument).
  assert.ok(
    !/\bbody\.md\b/.test(parkPromptSrc),
    'parkPrompt still references the shared `body.md` filename — concurrent park subagents would race on it',
  );
});

test('parkPrompt routes the body through a per-issue, collision-free sink', () => {
  // A per-issue-keyed path or process substitution makes the sink unique per
  // subagent so two concurrent parks cannot clobber each other.
  const perIssuePath = /body-\$\{p\.issue\}\.md/.test(parkPromptSrc);
  const processSubstitution = /--body-file\s+<\(/.test(parkPromptSrc);
  assert.ok(
    perIssuePath || processSubstitution,
    'parkPrompt must write back via a per-issue path (body-${p.issue}.md) or process substitution (--body-file <(...))',
  );
});

test('the --body-file write-back targets a per-issue sink, not a shared file', () => {
  const m = parkPromptSrc.match(/--body-file\s+(\S+)/);
  assert.ok(m, 'parkPrompt must still write the body back with gh issue edit --body-file');
  const target = m[1];
  assert.notEqual(target, 'body.md', '--body-file must not target the shared body.md');
  const perIssue = target.includes('${p.issue}') || target.startsWith('<(');
  assert.ok(perIssue, `--body-file target ${target} must be per-issue-unique or process substitution`);
});

test('parkPrompt adds a title/Observation match guard that aborts a contaminated write', () => {
  // Before pushing, the subagent must verify the fetched body still belongs to
  // THIS issue (title/Observation match) and abort the write if it does not.
  assert.match(
    parkPromptSrc,
    /GUARD/,
    'parkPrompt must include an explicit pre-write GUARD step',
  );
  assert.match(
    parkPromptSrc,
    /\.title/,
    'the guard must re-check the issue title to detect a contaminated read',
  );
  assert.match(
    parkPromptSrc,
    /ABORT|abort/,
    'the guard must abort the write when the read does not match this issue',
  );
  // The guard must key its comparison to THIS issue number, not a generic check.
  assert.match(
    parkPromptSrc,
    /#\$\{p\.issue\}/,
    'the guard must compare against this issue (#${p.issue})',
  );
});
