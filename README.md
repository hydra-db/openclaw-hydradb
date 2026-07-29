# Hydra DB — OpenClaw Plugin

State-of-the-art agentic memory for OpenClaw powered by [Hydra DB](https://hydradb.com). Automatically captures conversations, recalls relevant context with knowledge-graph connections, and injects them before every AI turn.

## Install

```bash
openclaw plugins install @hydradb/openclaw
```

Restart OpenClaw after installing.

If you run OpenClaw via the local gateway, restart it too:

```bash
openclaw gateway restart
```

## Get Your Credentials
1. Get your Hydra API Key from [Hydra DB](https://app.hydradb.com)
2. Get your Tenant ID from the Hydra dashboard

## Interactive Onboarding

Run the interactive CLI wizard (recommended):

```bash
# Basic onboarding (API key, tenant ID, sub-tenant, ignore term)
openclaw hydra onboard

# Advanced onboarding (all options including recall mode, graph context, etc.)
openclaw hydra onboard --advanced
```

The wizard guides you through configuration with colored prompts and **writes your config to** `plugins.entries.openclaw.config` inside OpenClaw's settings file.

The path is resolved in the same order OpenClaw itself uses:

1. `$OPENCLAW_CONFIG_PATH` — if set, used directly
2. `$OPENCLAW_STATE_DIR/openclaw.json` — if `OPENCLAW_STATE_DIR` is set
3. `$OPENCLAW_HOME/.openclaw/openclaw.json` — if `OPENCLAW_HOME` is set
4. Default: `~/.openclaw/openclaw.json` (macOS/Linux) or `%USERPROFILE%\.openclaw\openclaw.json` (Windows)

No manual adjustment needed — the wizard auto-detects the correct path.

After onboarding, restart the gateway:

```bash
openclaw gateway restart
```

## Manual Configuration

If you prefer, you can configure credentials manually.

Two required values:

- **API key**
- **Tenant ID**

Environment variables (recommended for secrets):

```bash
export HYDRADB_API_KEY="your-api-key"
export HYDRADB_DATABASE="your-database-id"
```

> The legacy `HYDRA_OPENCLAW_API_KEY` / `HYDRA_OPENCLAW_TENANT_ID` variables are
> still honoured but emit a one-time deprecation warning naming the canonical
> `HYDRADB_*` replacement. The canonical name wins if both are set.

Or configure directly in OpenClaw's settings file:

- **macOS / Linux:** `~/.openclaw/openclaw.json`
- **Windows:** `%USERPROFILE%\.openclaw\openclaw.json`

```json5
{
  "plugins": {
    "entries": {
      "openclaw": {
        "enabled": true,
        "config": {
          "apiKey": "${HYDRA_OPENCLAW_API_KEY}",
          "tenantId": "${HYDRA_OPENCLAW_TENANT_ID}"
        }
      }
    }
  }
}
```

After changing config, restart the gateway so the plugin reloads:

```bash
openclaw gateway restart
```

### Options

| Key                  | Type        | Default               | Description                                                                    |
| -------------------- | ----------- | --------------------- | ------------------------------------------------------------------------------ |
| `subTenantId`      | `string`  | `"hydra-openclaw-plugin"` | Sub-tenant for data partitioning within your tenant                      |
| `autoRecall`       | `boolean` | `true`              | Inject relevant memories before every AI turn                                  |
| `autoCapture`      | `boolean` | `true`              | Store conversation exchanges after every AI turn                               |
| `maxRecallResults` | `number`  | `10`                | Max memory chunks injected into context per turn                               |
| `recallMode`       | `string`  | `"fast"`            | `"fast"` or `"thinking"` (deeper personalised recall with graph traversal) |
| `graphContext`     | `boolean` | `true`              | Include knowledge graph relations in recalled context                          |
| `ignoreTerm`       | `string`  | `"hydra-ignore"`    | Messages containing this term are excluded from recall & capture              |
| `debug`            | `boolean` | `false`             | Verbose debug logs                                                             |

## How It Works

- **Auto-Recall** — Before every AI turn, queries Hydra for relevant memories and injects graph-enriched context (entity paths, chunk relations, extra context).
- **Auto-Capture** — After every AI turn, the last user/assistant exchange is sent to Hydra as conversation pairs with `infer: true` and `upsert: true`. The session ID is used as `source_id` so Hydra groups exchanges per session and builds a knowledge graph automatically.

All requests go through the generated `@hydradb/sdk` (v2 API), behind a thin
hand-owned wrapper (`hydra/`) that owns the SDK at an exact pin — see
[`CONTRACT.md`](./CONTRACT.md).

## Slash Commands

The canonical `/hydradb-*` names are shown below. The previous `/hydra-*` names
still work as **deprecated aliases** (each emits a one-time warning).

| Command                       | Deprecated alias         | Description                           |
| ----------------------------- | ------------------------ | ------------------------------------- |
| `/hydradb-ingest <text>`   | `/hydra-remember`      | Save something to Hydra memory        |
| `/hydradb-query <query>`   | `/hydra-recall`        | Search memories with relevance scores |
| `/hydradb-list`            | `/hydra-list`          | List all stored user memories         |
| `/hydradb-delete <id>`     | `/hydra-delete`        | Delete a specific memory by its ID    |
| `/hydradb-inspect <source_id>` | `/hydra-get`       | Fetch the full content of a source    |
| `/hydra-onboard`           | —                        | Show current configuration status     |

## AI Tools

The canonical `hydradb_*` names are shown below. The previous `hydra_*` names
still work as **deprecated aliases** (each emits a one-time warning).

| Tool               | Deprecated alias        | Description |
| ------------------ | ----------------------- | ----------- |
| `hydradb_ingest`  | `hydra_store`          | Save the recent conversation history to Hydra as memory |
| `hydradb_query`   | `hydra_search`         | Search Hydra memories (returns graph-enriched context) |
| `hydradb_list`    | `hydra_list_memories`  | List all stored user memories (IDs + summaries) |
| `hydradb_inspect` | `hydra_get_content`    | Fetch full content for a specific `source_id` |
| `hydradb_delete`  | `hydra_delete_memory`  | Delete a memory by `memory_id` (use only when user explicitly asks) |

## CLI

The canonical root is `hydradb`. The previous `hydra <verb>` commands still work
as **deprecated aliases** (each emits a one-time warning).

```bash
openclaw hydradb onboard             # Interactive onboarding wizard
openclaw hydradb onboard --advanced  # Advanced onboarding wizard
openclaw hydradb query <query>       # Search memories        (was: hydra search)
openclaw hydradb ingest <text>       # Save a memory
openclaw hydradb list                # List all user memories (was: hydra list)
openclaw hydradb delete <id>         # Delete a memory        (was: hydra delete)
openclaw hydradb inspect <source_id> # Fetch source content   (was: hydra get)
openclaw hydradb status              # Show plugin configuration
```

## Troubleshooting

### `Not configured. Run openclaw hydra onboard`

This means the plugin is enabled, but credentials are missing.

Run:

```bash
openclaw hydra onboard
openclaw gateway restart
```

### CLI says a command is unknown

Update/restart the gateway so it reloads the plugin:

```bash
openclaw gateway restart
```

## Context Injection

Recalled context is injected inside `<hydra-context>` tags containing:

- **Entity Paths** — Knowledge graph paths connecting entities relevant to the query
- **Context Chunks** — Retrieved memory chunks with source titles, graph relations, and linked extra context

## Contributing / Developer Setup

To work on the plugin locally:

```bash
# One-command bootstrap: installs deps, runs type-check, creates .env
make bootstrap

# — or run the script directly —
bash scripts/bootstrap.sh
```

Copy `.env.example` to `.env` and fill in your Hydra credentials (the bootstrap
script does this automatically if `.env` doesn't exist yet):

```bash
cp .env.example .env
# Then edit .env with your HYDRA_OPENCLAW_API_KEY and HYDRA_OPENCLAW_TENANT_ID
```

### Available Make targets

| Target        | Description                                      |
| ------------- | ------------------------------------------------ |
| `make help`         | Show all available targets                 |
| `make bootstrap`    | Full project bootstrap (install + check)   |
| `make install`      | Install dependencies (`npm ci`)            |
| `make check-types`  | Run TypeScript type-checking               |
| `make test`         | Run tests (if configured)                  |
| `make clean`        | Remove `node_modules/` and `dist/`         |
