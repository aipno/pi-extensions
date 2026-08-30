# pi-tools

Pi extension that replaces pi's built-in file tools with **self-implemented**
versions, in the spirit of [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi)'s
grep/read/write/glob: no external file-tool binaries required, everything is
implemented in this package.

Same-name registration replaces pi's built-ins transparently — the model calls
`grep`, `read`, `write`, `find`, `ls`, `edit` exactly as before; schemas,
output formats, error strings and truncation notices are kept pi-identical.

## What gets overridden

| Tool | pi built-in | pi-tools replacement |
|---|---|---|
| `grep` | spawns/downloads the `rg` binary | pure-TS search engine (gitignore/`/`ignore-aware walker, smart-case, context lines, literal mode, match limits) **with an optional `rg` fast path** when the binary happens to be on PATH; `--no-require-git` keeps ignore semantics consistent everywhere |
| `read` | text + images | text + images (png/jpg/gif/webp/bmp attachments), **SQLite preview** (`node:sqlite`, tables + rows), **ZIP/TAR archive listing and member reading** (`archive.zip::dir/file.txt`), binary detection |
| `write` | plain write | atomic write (temp + rename), parent-dir creation, joins pi's per-file mutation queue (safe alongside built-in `edit`) |
| `find` | spawns/downloads the `fd` binary or uses a glob lib | own glob engine (`**`, `*`, `?`, `{a,b}`, `[abc]`) over the gitignore-aware walker |
| `ls` | built-in | own directory listing (case-insensitive sort, `/` suffix, dotfiles) |
| `edit` | built-in | exact-text multi-edit with fuzzy fallback (trailing whitespace / smart punctuation tolerant), uniqueness + overlap validation, BOM/CRLF preservation, display diff + unified patch in details |

## Install

```bash
pi install git:github.com/aipno/pi-extensions@main --package pi-tools   # or your local path
# or, from this repo:
pi -e ./packages/pi-tools/index.ts   # quick test
```

## Configuration

Optional `pi-tools.json` in pi's agent directory (`~/.pi`):

```json
{
  "tools": { "grep": true, "read": true, "write": true, "find": true, "ls": true, "edit": true },
  "grep": { "rgFirst": false }
}
```

- `tools.<name>` — disable an override to fall back to pi's built-in
- `grep.rgFirst` — `false` forces the pure-TS engine even when `rg` is on PATH

## Commands

`/tools` — shows which of the six tools are overridden and active; toggles any
tool at runtime (`/tools disable grep`), with no reload required.

## Design notes

- **Override mechanism**: pi's tool registry resolves same-name extension
  tools last (`Map.set` wins), so registering `grep`/`read`/`write`/`find`/`ls`/`edit`
  shadows the built-ins, including their system-prompt snippets.
- **grep dual path**: the rg fast path spawns `rg --json` with the same
  arguments pi's built-in uses; the TS fallback implements the walker,
  gitignore scoping and the line matcher in this package. Both produce
  byte-identical output (`path:line: text`, context `path-line- text`,
  `No matches found`, `[N matches limit reached…]` notices).
- **Beyond pi**: `outputMode` (`content`/`count`/`filesWithMatches`) on grep,
  archive/SQLite reading on read, empty-directory and limit notices on ls.
- **Safety**: write and edit run inside `withFileMutationQueue` so parallel
  tool calls touching the same file stay serialized; edit preserves BOM and
  the original line ending.

## Development

```bash
npm install
npm run typecheck
npm test          # node --test test/unit/*.test.ts
```