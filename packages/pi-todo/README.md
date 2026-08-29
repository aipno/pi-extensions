# pi-todo

Give the model a task list you can see. This extension adds a `todo` tool, a
`/todos` command, and a live panel above the editor to
[Pi Agent](https://github.com/badlogic/pi-mono), so you always know what the
agent is doing now, what it finished, and what is queued. The list is rebuilt
from the conversation itself, so it survives `/reload` and compaction — useful
on long research → design → implement sessions.

Modeled on [`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo), ported into this repo's package layout with the rpiv config/i18n dependencies folded in (English-only UI).

## Install

```bash
pi install /path/to/packages/pi-todo
# or run once without installing:
pi -e /path/to/packages/pi-todo
```

Global drop-in: `~/.pi/agent/extensions/pi-todo/` (directory with `index.ts`). Project-local: `.pi/extensions/`. Then restart Pi, or `/reload`.

## Quick start

Run `/todos` after the restart to confirm the extension is loaded. On a fresh
session it prints:

```
No todos yet. Ask the agent to add some!
```

Then ask for something with several steps — "add a repository layer with tests,
and track it as todos". The model calls `todo` and the panel appears above your
input box, updating as work moves. The panel shows every task with a status
glyph, the label of whatever is in progress, a `Todos (done/total)` heading, and
a `+N more (… )` summary when the list overflows the row budget.

Press `ctrl+shift+t` to collapse the panel to its heading plus a one-line hint,
and again to expand it. Run `/todos` at any time to print the full list grouped
by status.

## What you get

- **The plan stays on screen.** A panel above the editor shows every task with a
  status glyph, the label of whatever is in progress, and a `Todos (done/total)`
  heading — including the pending / in-progress split when either is non-zero —
  so you never have to ask the agent where it is. The in-progress row's glyph
  spins while the agent is on it.
- **Tasks survive `/reload` and compaction.** Each tool call carries the full
  post-mutation snapshot, and the list is replayed from the session branch. No
  disk writes, nothing to lose.
- **Finished work gets out of the way.** Completed rows stay visible for the rest
  of the turn, then drop at the start of the next one; the panel disappears
  entirely when the list empties.
- **The overlay never eats your terminal.** Past the row budget it drops
  completed tasks first, truncates unfinished ones last, and tells you what it
  hid with `+3 more (2 completed, 1 pending)` — statuses are reported
  accurately, never lumped together.
- **The agent can sequence work, not just list it.** `blockedBy` dependencies are
  validated before anything is written — dangling ids, deleted dependencies,
  self-blocks, and cycles are all rejected. Starting a new `in_progress` task
  auto-demotes the previous one.
- **The model keeps the board without extra `list` calls.** Each mutation result
  includes a compact id/status snapshot, and the current list is injected into
  the system prompt at the start of every turn — so ids survive `/compact`.
  An `in_progress` task that goes untouched for several turns gets a gentle
  "no update for N turns" reminder in that injection, so the agent reconsiders
  a stalled step instead of grinding on it.
- **Parallel sessions stay separate.** Task state is keyed by session, so a
  detached or child session can neither read nor overwrite the foreground list.
  Todo mutations themselves run sequentially, even when other tools run in parallel.
- **The list cannot grow without bound.** Create is rejected at 50 visible tasks;
  delete or clear to add more.

## Configuration

Optional. Settings live in `~/.config/pi-todo/config.json` (override with the
`PI_TODO_CONFIG` env var); the file is read, never written.

| Setting | What it does | Default |
| --- | --- | --- |
| `maxWidgetLines` | Content rows the overlay may use, heading included. Minimum `3`. Applies on the next repaint. Pi's tool-output expansion mode shows all tasks. | `12` |
| `collapseKey` | Key that collapses and expands the panel, in Pi keybinding form (`alt+o`, `ctrl+shift+t`). Set `"off"` to register no shortcut. Needs `/reload` to rebind. | `"ctrl+shift+t"` |
| `guidance.promptSnippet` | Replaces the one-line tool description the model sees. Needs `/reload`. | built-in snippet |
| `guidance.promptGuidelines` | Replaces the usage guidelines given to the model, as a list of strings. Needs `/reload`. | 8 built-in guidelines |

```json
{ "maxWidgetLines": 8, "collapseKey": "alt+t" }
```

Malformed JSON falls back to the defaults with a warning; an individual
unusable value is silently dropped back to its default. Never an error.

## Architecture

```
index.ts                  extension entry — registers tool + command + overlay lifecycle
todo.ts                   tool + /todos command registration shell, public re-exports
todo-overlay.ts           TodoOverlay widget (setWidget contract, collapse, auto-hide)
config.ts                 config loader (PI_TODO_CONFIG → XDG → legacy), guidance,
                          maxWidgetLines, collapse-key grammar
state/state.ts            TaskState shape (tasks + nextId)
state/store.ts            per-session live state, foreground render pointer
state/state-reducer.ts    pure reducer (create/update/list/get/delete/clear)
state/invariants.ts       4-state transition legality (completed is one-way)
state/task-graph.ts       blockedBy cycle detection + blocks derivation
state/selectors.ts        visible/counted/grouped/layout derivations
state/replay.ts           branch replay (last-write-wins TaskDetails snapshot)
state/i18n-bridge.ts      t(key, fallback) English bridge — localized UI swap point
tool/types.ts             tool identity, TypeBox schema, domain types, MAX_TASKS
tool/board.ts             compact LLM-facing board (mutation suffix + prompt injection)
tool/sanitize.ts          terminal control-character stripping for model text
tool/response-envelope.ts LLM-facing result envelope + content formatter
view/format.ts            glyphs/colors, overlay rows, /todos rows, render hooks
locales/en.json           canonical key set for the UI chrome strings
```

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test test/unit/*.test.ts
```

## License

MIT — see [LICENSE](LICENSE).