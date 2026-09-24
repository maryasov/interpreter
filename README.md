# interpreter

**Structure-aware Markdown translation agent.** It translates documents by
editing the *structure*, not the raw text: every text leaf is addressed, every
edit passes a structural gate, and the final document is re-assembled by
splicing edits back into the original — so tables, code, links and frontmatter
stay byte-for-byte intact.

Works as a CLI, an HTTP job API, and an MCP server, so **other agents** can
launch a translation and poll its status. Self-contained (no dependency on any
parent monorepo); talks to any OpenAI-compatible chat-completions endpoint.

> 🌐 This README is also available in [Russian](README.ru.md).

## Why

Translating Markdown with a plain LLM round-trip breaks layout: a translated
table cell sprouts a stray `|`, code gets "fixed", links get rewritten. This
agent never lets the model emit a whole document. It exposes addressable text
units and refuses any edit that would change the document's structure.

## Quick start

Requires **Node ≥ 22.18** (native TypeScript via `--experimental-transform-types`).

```sh
pnpm install --ignore-workspace     # deps: unified / remark-gfm / zod (+ typescript for typecheck)
cp .env.example .env                # then fill in LLM_BASE_URL / LLM_MODEL / LLM_API_KEY

pnpm demo                           # offline demo (MockProvider, no network / no key)
pnpm test                           # 15 tests: engine + agent + pipeline + server
pnpm typecheck                      # tsc --noEmit

pnpm cli translate README.ru.md --to en --out /tmp/en.md
pnpm cli translate big.md --to zh --mode pipeline     # batch mode (cheaper, deterministic)
pnpm cli status <jobId>                               # read a job's state from disk
pnpm serve                                            # HTTP job API (drive it from another agent)
pnpm mcp                                              # MCP server (stdio)
```

> `pnpm demo` and `pnpm test` run fully offline against a scripted `MockProvider`.
> A real translation is the only step that needs the `.env` credentials.

## How it works

1. **Addressing** (`src/engine/addresses.ts`) — remark/mdast parses the document
   and every text leaf gets a stable address `b<block>.u<leaf>`. Inline code and
   protected blocks are marked non-translatable. Context (block type, table
   `cell {row,col}`, list index, emphasis/strong, link href) is exposed to the
   translator.
2. **Editing** (`src/engine/session.ts`) — `translate(address, text)` replaces
   only that unit's byte range. Before it is accepted the enclosing block is
   re-parsed and its **structure signature** (node types + geometry, text
   ignored) must be unchanged; URLs, inline code and a soft language gate are
   checked too. Inventing `|`, `` ` `` or `[ ]` in plain text is rejected.
3. **Assembly** — accepted edits are spliced into the original from last to
   first (original offsets, so they never interfere), then `finish()` runs a
   whole-document integrity gate (block-type sequence, byte-equal protected
   blocks, table geometry, plausible target language).
4. **Two modes** — `agent` (a tool-calling loop for hard documents) and
   `pipeline` (batched JSON for cheap, high-volume translation).

## Layout

```
src/engine/     md.ts (parse + signatures) · addresses.ts (units) · session.ts (DocSession + gates)
src/agent/      provider.ts (OpenAI-compatible + Mock) · config.ts (TOML + env) · skills.ts ·
                session.ts (JSONL transcript, A2A-style states) · tools.ts · loop.ts · pipeline.ts · language.ts
src/server/     http.ts (job API + SSE) · jobs.ts (registry) · mcp.ts (stdio JSON-RPC)
src/translate.ts   orchestrator shared by CLI / HTTP / MCP
src/cli.ts · src/demo.ts
config.toml · .env.example · skills/<name>/SKILL.md · samples/ · tests/
```

## Configuration

All settings resolve in this order: **defaults → `config.toml` → environment**
(real env vars win over the local `.env` file). Provider credentials come from
the environment, never from a committed file.

| Variable | Meaning |
|---|---|
| `LLM_BASE_URL` | OpenAI-compatible endpoint, e.g. `https://api.openai.com/v1` |
| `LLM_MODEL` | chat model name |
| `LLM_API_KEY` | bearer token for the endpoint (keep it in `.env` only) |
| `INTERPRETER_HOST` / `INTERPRETER_PORT` | HTTP job API bind address |
| `INTERPRETER_TOKEN` | when set, HTTP/MCP callers need `Authorization: Bearer <token>` |
| `INTERPRETER_CONFIG` | path to the config file (default `config.toml`) |

Providers, system-prompt file, mode and turn budget can also be set in
`config.toml`. Skills are Markdown prompt-modules in `skills/<name>/SKILL.md`
(frontmatter `name`/`description`/`when`) injected into the system prompt when
their triggers match.

## Driving it from another agent

- **HTTP job API** — `POST /jobs` → `{job_id}`; `GET /jobs/:id` returns
  A2A-style state (`queued → running → input-required → succeeded | failed |
  cancelled`) with progress and token cost; `GET /jobs/:id/result` returns the
  translated Markdown; `GET /jobs/:id/events` is an SSE transcript;
  `POST /jobs/:id/cancel` aborts. `GET /healthz` is unauthenticated.
- **MCP server** (stdio) — tools `translate_markdown` (sync, small docs),
  `start_job`, `job_status`, `job_result`.
- **CLI** — same kernel: `translate`, `status`, `serve`, `mcp`.

Each job persists to `.interpreter/jobs/<id>/` (`status.json`, `result.md`,
`session.jsonl`) for audit and resume. This directory is gitignored.

## Documentation

| File | Contents |
|---|---|
| [architecture.md](architecture.md) | Design: addressing model, tool surface + gates, modes, skills, providers, HTTP/MCP interfaces ([Russian version](architecture.ru.md)) |

Deep-research notes (Markdown↔structure tooling, agent-harness landscape) are
kept in `research/`, which is intentionally gitignored and not part of the
published repo.

## License

MIT (see `LICENSE`).
