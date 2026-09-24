# Architecture: translator agent (interpreter)

A self-contained agent for structure-aware Markdown translation (and, in
time, other formats). It depends on no parent monorepo; it is integrated via
HTTP/MCP or used directly from the CLI.

> 🌐 Русский вариант: [architecture.ru.md](architecture.ru.md).

## Principles

1. **Operate on structure, not raw text.** A document opens as a set of
   addressable units (block → table row / list item → inline node → cell). The
   LLM never emits a whole document.
2. **Lossless by construction.** Non-translatable content (code, HTML, URLs,
   inline code, frontmatter) physically never enters the editable payload; the
   final document is assembled by splicing edited slices back into the original
   (the byte-slice pattern), with an identity check.
3. **Every edit passes a structural gate** (node type, geometry, URLs, code
   spans, language, length) before it is accepted; a rejection returns a
   human-readable error, so the agent iteratively fixes it (diagnose → fix loop).
4. **Thin core.** The agent loop is a few hundred lines of TS: provider
   abstraction, tools, skills, session JSONL, turn budget. No heavy framework.

## Components (as-built)

```
interpreter/
├── src/
│   ├── engine/            # document structure (no LLM)
│   │   ├── md.ts          # remark+gfm parser, frontmatter, signatures (structure/url/code/language)
│   │   ├── addresses.ts   # mdast → addressable units (Unit/BlockInfo/Document), cell context
│   │   ├── session.ts     # DocSession: edits map + assemble + validateOne + finish (integrity gate)
│   │   └── index.ts       # re-exports
│   ├── agent/             # harness
│   │   ├── provider.ts    # OpenAI-compatible chat+tools; MockProvider for tests
│   │   ├── config.ts      # TOML-subset + env overrides (AppConfig)
│   │   ├── skills.ts      # skills/<name>/SKILL.md → system prompt by `when:` triggers
│   │   ├── session.ts     # A2A-style states + append-only JSONL (status.json/result.md/session.jsonl)
│   │   ├── tools.ts       # TranslatorTools: list/get/translate/batch/skip/progress/finish/abort
│   │   ├── loop.ts        # agent loop observe→tool→observe, turn budget
│   │   ├── pipeline.ts    # batch mode (JSON array, no tool loop)
│   │   └── language.ts    # source-language detection by script
│   ├── server/
│   │   ├── http.ts        # job API to be driven BY other agents (+ SSE)
│   │   ├── jobs.ts        # live-job registry (submit/status/result/cancel)
│   │   └── mcp.ts         # the agent as an MCP server (stdio JSON-RPC)
│   ├── translate.ts       # orchestrator (config→provider→prompt→engine→agent/pipeline)
│   ├── cli.ts             # translate / status / serve / mcp
│   └── demo.ts            # offline demo on MockProvider
├── skills/                # prompt-skills (example: markdown-tables)
├── config.toml            # provider(s), model, mode, toggles
├── tests/                 # engine + agent(mock) + pipeline(mock) + server(HTTP)
└── samples/               # fixtures: a README with tables/code/frontmatter
```

## Addressing model (the "work with structure" core)

The editable grain is an mdast **text leaf**. Addresses are stable across edits
and look like this (as-built):

| Address | Targets | Unit context |
|---|---|---|
| `b3.u0` | text leaf #0 inside top-level block #3 | `blockType`, `container` |
| `b7.u2` | a leaf inside table block b7 | `cell: {row, col}` (row 0 is the header; the GFM delimiter row is not a `tableRow`) |
| `b5.u1` | a leaf inside a list item | `listIndex` |
| `b1.u0` | a leaf inside emphasis/strong/link | `emphasis`/`strong`/`linkHref` |

- inline code (`code`) and the contents of protected blocks (`code` fences, HTML,
  frontmatter, …) get an address but are `translatable: false` — they never reach
  the payload.
- An edit changes only the byte range of a node's text content in the source;
  assembly splices edits from `end` to `start`, so neighbouring offsets never
  shift and markup (`|`, `-`, `[]()`, `**`) stays untouched.
- Leaf numbering (rather than a raw `b7.r2c1` path) is chosen because the leaf
  enumeration cannot change while structure is unchanged — which is exactly what
  the structural gate guarantees: block structure signature matches ⇒ addresses
  stay valid.

## Agent tools (tool surface, as-built)

Defined in `src/agent/tools.ts` (Zod schemas). The LLM neither sees nor returns
a whole document — only calls over the open DocSession:

Read:
- `list_units({block?, limit?})` — pending units: address + source + context
  (`cell rNcM`, `keepUrl`, `emphasis`/`strong`)
- `get_unit({address})` — the unit plus the raw enclosing block (context window)
- `progress()` — translated / skipped / pending / rejected

Write (each goes through `canTranslate` — a dry-run gate; an error returns to the
agent):
- `translate_unit({address, text})` — translate one text unit
- `batch_translate({rows:[{address,text}]})` — atomic: dry-run every row first,
  commit only if all pass; otherwise report `failedIndex` + reason
- `skip_unit({address, reason?})` — legitimately leave as-is (brand names, code lexicon)

Control:
- `finish()` — assemble + whole-document QC (`validateDocumentIntegrity`);
  returns the markdown or the failure reason (stops the loop)
- `abort({reason})` — stop without a result

Note: the `translate_cell` from the original plan is just `translate_unit` on a
unit whose context is `cell`; a separate tool is unnecessary — cell safety is the
same structural gate (introducing a `|` ⇒ rejected).

System prompt = base (`translate.ts`) + active skills (by `when:`). The
preservation rules live in the gates (enforced hard), not just in the prompt
(softly mirrored).

## Skills

Markdown files `skills/<name>/SKILL.md` with frontmatter `name/description/when`
(same shape as Qoder/Claude skills, for portability). Example skills:
`readme-tone` (README style, imperatives), `tables-<lang>` (line-break rules in
cells), `glossary-<domain>` (fixed term mappings), `qc-repair` (how to fix
gate-rejected edits). `skills/markdown-tables/` ships as a worked example.

## Providers

`provider.ts` is a single OpenAI-compatible chat-completions client taking
`baseURL/model/apiKey/temperature`. Multiple `[providers.*]` sections can be
declared and selected via `activeProvider`. Real values come from the
environment (`LLM_BASE_URL`/`LLM_MODEL`/`LLM_API_KEY`, see `.env.example`) — no
endpoint is baked into the published defaults, and `makeProvider()` throws a
clear error if the provider is unconfigured. Token usage is recorded on the
session (prompt/completion) for cost accounting.

## External interface (launch by another agent + status)

State semantics are A2A-like: `queued → running → input-required →
succeeded | failed | cancelled`.

1. **HTTP job API** (`server/http.ts`, default `127.0.0.1:4100`, optional
   Bearer token):
   - `POST /jobs {text|file_b64, source?, target, mode?}` → `{job_id, state}`
     (source language auto-detected; asynchronous)
   - `GET /jobs/:id` → `{state, progress:{units_total,translated,skipped,rejected},
     cost:{prompt_tokens,completion_tokens}, last_error?}`
   - `GET /jobs/:id/result` → translated markdown
   - `GET /jobs/:id/events` (SSE) — tool-call stream (debug/observation)
   - `POST /jobs/:id/cancel`
2. **MCP server** (`mcp.ts`, stdio JSON-RPC 2.0): tools `translate_markdown`
   (sync, small documents), `start_job`, `job_status`, `job_result`. This is the
   native interface for operator agents via their MCP config.
3. **CLI** (`cli.ts`): `interpreter translate <file> --to <lang> [--from] [--mode
   agent|pipeline] [--out]`, `interpreter status <id>`, `interpreter serve`,
   `interpreter mcp` — the same kernel the server uses.

Each job's session is a JSONL transcript in `./.interpreter/jobs/<id>/` (audit,
resume; there is no rollback — every edit is idempotent against the gates). This
directory is gitignored.

## Implementation status (v0 — done)

1. ✅ `engine/` — remark/mdast addressing down to the text leaf + structural/integrity
   gates + tests (address/cell-edit/pipe-guard/language/finish).
2. ✅ `agent/` — loop + provider (+ Mock) + tools + skills + config + session JSONL.
3. ✅ Mock-provider tests: full run over a table-bearing document (agent mode) and
   pipeline mode.
4. ✅ `server/http.ts` job API (+ SSE + bearer) and `server/mcp.ts`; CLI
   `translate`/`status`/`serve`/`mcp`; offline `demo.ts`.

Next (not in v0): an `input-required` Q&A round-trip (`POST /jobs/:id/answer`),
`job://{id}` resources in MCP, extracting a shared `md-translate-engine`
package, and wiring into an existing translation queue.

## Risks

- Address stability under bulk edits — mitigated because edits never change
  structure (gate-enforced), and the post-edit re-parse re-checks the schema.
- Small models mangle "untranslatables" — language-ratio gate + glossary skill;
  the batch tool gives a cheap path for simple paragraphs.
- Nested tables/HTML inside markdown — we refuse honestly (integrity fails ⇒
  fall back to whole-block mode or manual markup) rather than silently corrupt.
