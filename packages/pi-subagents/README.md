# pi-subagents

A re-implementation of the subagent architecture from
[nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents), built
for learning: the same core ideas, expressed in a compact, readable form.

`pi-subagents` lets Pi delegate work to focused child agents — code review,
scouting, implementation, second opinions, web research, and background jobs.
Each subagent is its own child `pi` session with its own job.

## Install / try

```bash
pi install /path/to/packages/pi-subagents
# or run once without installing:
pi -e /path/to/packages/pi-subagents
```

Then just ask Pi in plain language:

```text
Use scout to understand how the auth flow works, then ask me what's missing.
Ask oracle for a second opinion on my current plan. Challenge assumptions.
Use reviewer to review this diff.
Run this in the background.
```

Or call the `subagent` tool directly (async defaults to background):

```text
subagent(agent="reviewer", task="Review the diff of the last commit", async=false)
```

## Builtin agents

| Agent | Use it when you want... |
|-------|--------------------------|
| `scout` | Fast local codebase recon that returns compressed context for handoff |
| `researcher` | Web/docs research with sources and a concise brief |
| `worker` | Implementation work (strict tool allowlist, narrow edits) |
| `reviewer` | Evidence-based code/plan review, no edits |
| `oracle` | A second opinion before acting; challenges assumptions |
| `delegate` | A lightweight general-purpose child close to the parent session |

Custom agents are markdown files with YAML frontmatter:

- project: `.pi/subagents/<name>.md` (nearest `.pi/` wins)
- user: `~/.pi/agent/subagents/<name>.md`, `~/.pi/agent/agents/`, `~/.agents`

```markdown
---
name: lint-me
description: Runs the linter and fixes trivial issues
tools: read, bash, edit, write
thinking: low
---
You are the lint agent. Run `npm run lint`, fix trivial issues, report the rest.
```

Project agents override user agents override builtins by name; `aliases` are
supported. `/subagents` lists everything discovered.

## How it works

```
subagent tool / /run command
        │
        ▼
src/runs/executor.ts        resolve agent by name (builtin/user/project),
                            prepare child session (+ optional pruned fork),
                            depth guard, foreground vs background decision
        │
        ├── foreground → src/runs/execution.ts
        │        spawn `pi --mode json -p <Task: ...>` with the agent's
        │        system prompt, tools, model; decode the JSONL event
        │        stream (message_end / tool_execution_* / agent_settled)
        │        into live progress, usage and the final answer
        │
        └── background → src/runs/async.ts
                 detached child whose stdout is tee'd to
                 ~/.pi/agent/subagents/runs/<runId>/output.jsonl; a
                 watcher replays the file on exit, persists result.json
                 and delivers a notification card when done
```

### Key mechanisms (learned from the reference)

- **Agent files**: frontmatter `.md` parsed with a small hand-rolled YAML
  parser (`src/agents/frontmatter.ts`) — flat keys, block values, folded and
  literal scalars. The body becomes the child's system prompt.
- **Child launch** (`src/runs/pi-args.ts`): `pi --mode json -p` with
  `--model`, `--tools`, `--system-prompt` (replace) or
  `--append-system-prompt` (delegate), `--no-context-files`/`--no-skills`
  unless the agent opts in, `--session-dir` under the parent session root,
  long tasks delivered via `@file` to keep argv small.
- **PID resolution** (`src/shared/pi-spawn.ts`): `PI_SUBAGENT_PI_BINARY` env
  override → standalone pi binary → `node <pi-cli>` from the installed
  `@earendil-works/pi-coding-agent` → PATH fallback `pi`.
- **JSONL protocol**: the parent consumes the child's stdout events
  (`message_end` carries usage/model; `tool_execution_start/end` drive the
  progress card; `agent_settled` starts the exit drain) and computes the
  final output from the trailing clean assistant messages (up to 3, joined
  in order — a report split across analysis/tool round-trips/conclusion is
  no longer reduced to its last message).
- **Output delivery & truncation**: inline results are capped at 12,000
  characters (`DEFAULT_MAX_OUTPUT`). The complete output is persisted first
  — foreground: `<runsDir>/<runId>/output.txt`; background: `<runsDir>/<runId>/result.json`
  (which also keeps the full message list) — and the truncation marker
  carries the path (`… [truncated — full output: <path>]`), so a cut report
  is always one `read` away. Folded TUI cards say how many lines are folded
  and where the full output lives, instead of looking truncated.
- **Model/thinking inheritance**: a child inherits the parent's current
  model (the last assistant message's model in the parent session) unless
  the call or the agent definition pins one; frontmatter `thinking:` levels
  ride on `--model <m>:<level>` or the independent `--thinking <level>`
  flag.
- **Fork context** (`src/runs/fork-context.ts`): `oracle`/`worker` default to
  `context: fork` — the child session starts as a pruned copy of the parent
  conversation (last N assistant turns, text-only) so it can honor decisions
  already made without inheriting tool-output noise.
- **Background runs** survive parent reloads: state lives on disk, and
  `session_start` reconciles runs orphaned by a crash as interrupted.
- **Coordination env** (`PI_SUBAGENT_CHILD=1`, `PI_SUBAGENT_RUN_ID`,
  `PI_SUBAGENT_CHILD_AGENT`, `PI_SUBAGENT_PARENT_SESSION`,
  `PI_SUBAGENT_PARENT_DEPTH`) mirrors the reference protocol; children skip
  the parent machinery (so nesting is already prevented at registration) and
  the depth counter stays as a defensive guard for non-standard loads.

## Slash commands

| Command | What it does |
|---------|--------------|
| `/subagents` | List available agents with descriptions and sources |
| `/subagents-runs` | List recent background runs and their status |
| `/run <agent> <task...>` | Run a subagent; `--async` for background |

## Configuration

`~/.pi/agent/extensions/pi-subagents/config.json` (or `PI_SUBAGENT_CONFIG`):

```json
{
  "asyncByDefault": true,
  "defaultTimeoutMs": 300000,
  "forkContext": { "mode": "pruned", "maxTurns": 12 },
  "maxSubagentDepth": 8,
  "runsRetentionDays": 7
}
```

## Development

```bash
npm install            # dev deps for typechecking
npm run typecheck      # tsc --noEmit
npm test               # unit tests (node:test, type-stripped)
```

Layout:

- `src/agents/` — agent discovery, frontmatter parsing, name resolution
- `src/runs/` — child argv builder, foreground JSONL execution, background
  runs, fork context, executor
- `src/extension/` — tool registration, schemas, config, TUI rendering
- `src/slash/` — slash commands
- `src/shared/` — types, utils, pi-binary resolution
- `agents/` — builtin agent definitions shipped with the package