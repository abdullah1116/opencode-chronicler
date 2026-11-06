# opencode-chronicler

A **read-only** Model Context Protocol server that exposes opencode session
history as well-formed Markdown over streamable HTTP. Point an MCP client at it,
ask for a session, and you get back the metadata block, every message in
authoritative `seq` order, and the tool calls with their results, rendered as
clean Markdown. Model reasoning/thinking blocks are omitted by design.

The database is opened with `{ readonly: true }` and is never written to,
migrated, or locked for writing.

## Requirements

- **Bun ≥ 1.2** — runtime, test runner, and package manager. The project uses
  `bun:sqlite`, `Bun.serve`, and `bun test`.

## Install and run

```bash
bun install
bun run start          # boots src/index.ts
```

The server listens on port `31701`: MCP is served at `/mcp` and a liveness probe
at `/health`.

## Configuration

All variables are optional; the defaults are shown below. Invalid values fail
fast at boot with an error naming the offending variable.

| Variable | Default | Description |
|---|---|---|
| `OPENCODE_DB_PATH` | `~/.local/share/opencode/opencode.db` | opencode session database (a leading `~` is expanded). |
| `HOST` | `0.0.0.0` | HTTP bind address. |
| `PORT` | `31701` | HTTP port serving `/mcp` and `/health`. |
| `LOG_LEVEL` | `info` | One of `debug`, `info`, `warn`, `error`. |
| `CHRONICLER_DIR` | `.` | Output directory. |
| `CHRONICLER_LOG_PATH` | `./chronicler.log` | Log file. |
| `OPENCODE_E2E_SESSION` | *(unset)* | Session id used by the live-database end-to-end test; unset means the test skips. |

If the database file does not exist, the server refuses to start rather than
silently creating an empty one.

## MCP tools

### `read_session`

Render one opencode session as Markdown: a metadata block (id, directory,
timestamps, project, parent, version, message count), a horizontal rule, then one
`## <role> — <time>` section per message in `seq` order.

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `session_id` | string (min 1) | — | opencode session id, e.g. `ses_...`. |
| `include_tool_output` | boolean | `true` | Include tool-result output in the Markdown. |
| `max_part_chars` | int, 100–50000 | `2000` | Per-part truncation budget. |

Model reasoning/thinking blocks are omitted from the output.

Example call:

```json
{
  "name": "read_session",
  "arguments": {
    "session_id": "ses_11111111111111111111111111",
    "max_part_chars": 4000
  }
}
```

Example output (abridged):

```markdown
# Alpha Session

- **ID**: `ses_11111111111111111111111111`
- **Directory**: /home/you/projects/alpha
- **Created**: 2026-01-01T00:00:00.000Z
- **Updated**: 2026-01-01T00:00:05.000Z
- **Project**: 0123456789abcdef0123456789abcdef01234567
- **Parent**: ses_11111111111111111111111112 — subagent session
- **Version**: 1.0.0
- **Messages**: 2

---

## user — 2026-01-01T00:00:00.000Z

Summarize the release notes.

## assistant — 2026-01-01T00:00:05.000Z

**Tool: bash** (`call_abc123`)

```json
{ "command": "git branch --show-current" }
```

**Output:**

```text
main
```
```

An unknown session id returns an error result with the text
`Session not found: <id>`.

### `list_sessions`

List recent sessions newest-first as a Markdown table.

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `query` | string | — | Case-insensitive filter on title or directory. |
| `limit` | int, 1–200 | `20` | Maximum rows to return. |

Example call:

```json
{ "name": "list_sessions", "arguments": { "limit": 5 } }
```

Example output:

```markdown
| ID | Title | Msgs | Updated | Directory | Preview |
|---|---|---|---|---|---|
| ses_11111111111111111111111111 | Alpha Session | 2 | 2026-01-01T00:00:05.000Z | /home/you/projects/alpha | Summarize the release notes. |
```

When no sessions match, the tool returns the single line `No sessions found.`

## Connecting an MCP client

Register the chronicler as a **remote** MCP server in your opencode config
(`opencode.json`, or `opencode.jsonc` on installs that use the JSONC extension —
strict JSON content either way):

```json
{
  "mcp": {
    "chronicler": {
      "type": "remote",
      "url": "http://localhost:31701/mcp"
    }
  }
}
```

That is the opencode 1.18.x V1 schema, where MCP servers live directly under the
`mcp` key. V2-style configs document them under `mcp.servers.<name>` with a
`disabled` field:

```json
{
  "mcp": {
    "servers": {
      "chronicler": {
        "type": "remote",
        "url": "http://localhost:31701/mcp",
        "disabled": false
      }
    }
  }
}
```

Replace `localhost` with the host running the chronicler when it is not on the
same machine. The chronicler never edits your opencode config or database — it
is a strictly read-only consumer of the session DB. Wiring the server into a
client is user-side setup.

## Running on boot

Any process supervisor works. On a normal machine, a systemd **user** service:

```ini
# ~/.config/systemd/user/opencode-chronicler.service
[Unit]
Description=opencode-chronicler (read-only opencode session MCP server)

[Service]
WorkingDirectory=%h/opencode-chronicler
ExecStart=/usr/bin/bun run start
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now opencode-chronicler
```

Cron alternative (a `@reboot` line in `crontab -e`):

```cron
@reboot cd "$HOME/opencode-chronicler" && /usr/bin/bun run start >>"$HOME/.local/share/opencode-chronicler.log" 2>&1
```

For opencode hosts without an init system, the repo ships an opencode **plugin**
at `plugin-src/chronicler-keeper/`. On opencode server boot the plugin spawns
the chronicler detached after a `/health` probe — idempotent, so a reload never
double-spawns, and spawn failures are logged and swallowed. Copy the directory
into your opencode plugin path and reference it from the config's `plugin`
array.

## How it works

| module | responsibility |
|---|---|
| `config/env.ts` | Env → `AppConfig` (db path, directory, log path). |
| `log.ts` | Level-filtered logger. |
| `domain/types.ts` | Frozen type contract shared by the data and render layers. |
| `db/rows.ts` | Schemas for raw `session_v2` / `session_message` rows. |
| `db/opencode-db.ts` | Read-only `bun:sqlite` handle plus the `ChroniclerDb` facade. |
| `db/v2parse.ts` | v2 row JSON → domain shapes (defensive, never throws). |
| `db/queries.ts` | `listSessions$`, `loadSessionDoc$` RxJS pipelines. |
| `render/session-md.ts` | `renderSession(doc, opts)`. |
| `render/sessions-table.ts` | `renderSessionsTable(summaries)`. |
| `render/parts.ts` | Per-kind part renderer registry with a never-crash fallback. |
| `mcp/server-factory.ts` | Builds a fresh `McpServer` with both tools registered. |
| `mcp/http.ts` | `Bun.serve` routing: stateless `/mcp`, `/health`. |
| `mcp/tools/*.ts` | The `read_session` and `list_sessions` handlers. |
| `index.ts` | Boot: env → logger → DB → HTTP app → graceful shutdown. |

Data flows through RxJS end to end: tool input → deferred DB read → `v2parse` →
`toArray` → `map(render)` → `Observable<string>`, with `firstValueFrom` the only
Promise-shaped edge, inside the MCP handler.

Each `/mcp` request constructs a fresh `McpServer` and a fresh single-use
transport, so there is no session state to leak between callers.

## Health check

```bash
curl http://localhost:31701/health
# {"status":"ok","service":"opencode-chronicler"}
```

`GET /health` returns HTTP 200 with that JSON body; any unknown route returns
HTTP 404 `{"error":"not found"}`.

## Read-only guarantee

The chronicler is strictly a **consumer** of `opencode.db`. The database is
opened as `new Database(path, { readonly: true, create: false })`, so SQLite
itself rejects any write attempt, and the codebase contains no `INSERT`,
`UPDATE`, `DELETE`, or migration path against it. No schema changes, no WAL
checkpoints, no config edits. The end-to-end test asserts this mechanically: it
records the database's `sha256`, mtime, and size before boot and re-asserts
byte-identical equality after a full real-client MCP run. Without a configured
database the test skips with a clear message rather than failing.

## Development and testing

```bash
bun run dev      # watch mode
bun run check    # tsc --noEmit (strict, ESM)
bun test         # unit + real-client HTTP end-to-end tests
```

The end-to-end suite runs against a live opencode database when
`OPENCODE_DB_PATH` points at one; set `OPENCODE_E2E_SESSION` to a session id to
include live session rendering, otherwise that case skips.

## License

MIT — see [LICENSE](LICENSE).
