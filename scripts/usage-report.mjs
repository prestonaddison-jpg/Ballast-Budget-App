/**
 * Count exactly what a Claude Code session cost, from its own transcript.
 *
 * Claude Code writes every assistant message to
 * ~/.claude/projects/<slug>/<session-id>.jsonl with the API's usage block
 * attached. That is the real number — not a percentage bar, not an estimate
 * from a blog. This reads it back and totals it.
 *
 *   node scripts/usage-report.mjs              # newest transcript
 *   node scripts/usage-report.mjs --json       # machine-readable
 *   node scripts/usage-report.mjs <file.jsonl> # a specific one
 *
 * WHY THE FOUR NUMBERS ARE DIFFERENT. `cache_read` is context resent and
 * served from cache — cheap per token but it is what grows without bound as a
 * conversation gets longer, and it is the reason a fortieth turn costs many
 * times a fourth. `output` is what the model actually wrote. Watch the ratio:
 * a healthy session has output that is not dwarfed by cache reads.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const explicit = args.find((a) => a.endsWith('.jsonl'));

function newestTranscript() {
  const root = join(homedir(), '.claude', 'projects');
  const files = [];
  for (const dir of readdirSync(root)) {
    const full = join(root, dir);
    if (!statSync(full).isDirectory()) continue;
    for (const f of readdirSync(full)) {
      if (f.endsWith('.jsonl')) files.push(join(full, f));
    }
  }
  if (!files.length) throw new Error(`No transcripts under ${root}`);
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

const file = explicit ?? newestTranscript();

const totals = {
  input: 0,
  cacheCreate: 0,
  cacheRead: 0,
  output: 0,
  thinking: 0,
  webSearches: 0,
  webFetches: 0,
};
const byModel = new Map();
// Dedupe on the API message id: a transcript can replay the same assistant
// message (sidechains, resumes), and counting it twice inflates the answer.
const seen = new Set();
let assistantTurns = 0;
let firstAt = null;
let lastAt = null;

for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    continue;
  }

  if (entry.timestamp) {
    const t = Date.parse(entry.timestamp);
    if (!Number.isNaN(t)) {
      if (firstAt == null || t < firstAt) firstAt = t;
      if (lastAt == null || t > lastAt) lastAt = t;
    }
  }

  const message = entry.message;
  const usage = message?.usage;
  if (!usage || message.role !== 'assistant') continue;

  const id = message.id ?? entry.uuid;
  if (id && seen.has(id)) continue;
  if (id) seen.add(id);

  assistantTurns++;
  totals.input += usage.input_tokens ?? 0;
  totals.cacheCreate += usage.cache_creation_input_tokens ?? 0;
  totals.cacheRead += usage.cache_read_input_tokens ?? 0;
  totals.output += usage.output_tokens ?? 0;
  totals.thinking += usage.output_tokens_details?.thinking_tokens ?? 0;
  totals.webSearches += usage.server_tool_use?.web_search_requests ?? 0;
  totals.webFetches += usage.server_tool_use?.web_fetch_requests ?? 0;

  const model = message.model ?? 'unknown';
  const m = byModel.get(model) ?? { turns: 0, output: 0, cacheRead: 0, cacheCreate: 0, input: 0 };
  m.turns++;
  m.output += usage.output_tokens ?? 0;
  m.cacheRead += usage.cache_read_input_tokens ?? 0;
  m.cacheCreate += usage.cache_creation_input_tokens ?? 0;
  m.input += usage.input_tokens ?? 0;
  byModel.set(model, m);
}

const billedIn = totals.input + totals.cacheCreate + totals.cacheRead;
const grand = billedIn + totals.output;
const minutes = firstAt && lastAt ? Math.round((lastAt - firstAt) / 60000) : null;

const report = {
  transcript: file,
  assistantTurns,
  elapsedMinutes: minutes,
  tokens: {
    input: totals.input,
    cacheCreation: totals.cacheCreate,
    cacheRead: totals.cacheRead,
    totalInput: billedIn,
    output: totals.output,
    thinking: totals.thinking,
    grandTotal: grand,
  },
  perTurn: assistantTurns ? Math.round(grand / assistantTurns) : 0,
  serverTools: { webSearches: totals.webSearches, webFetches: totals.webFetches },
  byModel: Object.fromEntries(byModel),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const n = (x) => x.toLocaleString('en-US');
  console.log(`\ntranscript      ${file}`);
  console.log(`assistant turns ${n(assistantTurns)}`);
  if (minutes != null) console.log(`elapsed         ${n(minutes)} min`);
  console.log('');
  console.log(`input (fresh)   ${n(totals.input).padStart(12)}`);
  console.log(`cache creation  ${n(totals.cacheCreate).padStart(12)}`);
  console.log(`cache read      ${n(totals.cacheRead).padStart(12)}   <- context resent`);
  console.log(`                ${''.padStart(12, '-')}`);
  console.log(`total input     ${n(billedIn).padStart(12)}`);
  console.log(`output          ${n(totals.output).padStart(12)}`);
  console.log(`  of which thinking ${n(totals.thinking)}`);
  console.log(`                ${''.padStart(12, '=')}`);
  console.log(`GRAND TOTAL     ${n(grand).padStart(12)}`);
  console.log(`per turn        ${n(report.perTurn).padStart(12)}`);
  if (totals.webSearches || totals.webFetches) {
    console.log(`\nweb searches ${totals.webSearches} · web fetches ${totals.webFetches}`);
  }
  if (byModel.size > 1) {
    console.log('\nby model');
    for (const [model, m] of byModel) {
      console.log(`  ${model}  ${n(m.turns)} turns, ${n(m.output)} output`);
    }
  }
  console.log('');
}
