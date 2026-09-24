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
| `maxRecallChars`   | `number`  | `16000`             | Unified databases: upper bound on the recalled context per turn (and on the `hydradb_query` result). Long result bodies are shortened, each marked with its id; headings, ids and citation labels are kept. `0` = no bound |
| `recallMode`       | `string`  | `"fast"`            | `"fast"` or `"thinking"` (deeper personalised recall with graph traversal) |
| `graphContext`     | `boolean` | `true`              | Include knowledge graph relations in recalled context                          |
| `ignoreTerm`       | `string`  | `"hydra-ignore"`    | Messages containing this term are excluded from recall & capture              |
| `debug`            | `boolean` | `false`             | Verbose debug logs                                                             |
| `layout`           | `string`  | `"auto"`            | Storage layout of the database: `auto` reads it from Hydra once; `unified` (one corpus, created with `type: "unified"`) or `split` pin it |

## How It Works

- **Unified databases** (PRO-1618): a database created with `type: "unified"` keeps knowledge and memory in one corpus and refuses `type: memory`. With `layout: "auto"` the plugin reads the layout from `GET /databases` (a 5 s check, re-read every 5 minutes) and, on a unified database, sends no `type` on any call. Unified calls go through `@hydradb/sdk` 2.1.6 (PRO-2224); only creating a unified database is built by hand, because the SDK's layout enum does not carry `unified` yet. Captures send one item in the `context` list: either `text` or a `conversation` of exactly `{role, content}` turns, with the speaker as the item's `user_name`, the session id as its `context_id`, and `enrich`, `upsert` and `instructions` at request level. A long session keeps its latest turns within the server's 1 MiB per-item cap. The 202's `results[].id` is that context id. `POST /query` answers with the four-key unified body (`chunks`, `graph`, `forceful_relations`, `llm_prompt`); the plugin injects `llm_prompt`, bounded by `maxRecallChars`. On a split database nothing changes.

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

On a unified database (PRO-1618) the body inside the tags is instead the server-built `llm_prompt` from `POST /query`. It is injected as sent when it fits `maxRecallChars` (16,000 by default); a longer one has its long result bodies shortened, each marked with its id, and never loses a heading, id or citation label. It is markdown: a `# Query results` heading with `**Query:**`, `**Found:**` and a line on citing results by number, then `## Results` (one `### 1. <title>` per result with its relevance and category, the content, and `**Enrichment:**` when there is any), `## Forceful relations` (`### R1. <title>` with `**Linked from:**`: context the author linked to a result at ingest time, not matched by relevance), `## Related facts` (graph facts labelled `[P1]`, with the result they came from), `## Temporal facts` and `## Sources`, each section only when there is anything to show. The `hydradb_query` tool returns the same `llm_prompt`, under the same bound. `/hydradb-query` and `openclaw hydradb query` read the same body's `chunks[].content`, `chunks[].enrichment` (a plain string; `chunks[].enrichment_kind` beside it names the declared category), `chunks[].temporal`, `graph[].path_summary` and `forceful_relations[]` for their structured output, listing every chunk the server returned with its content, enrichment and temporal facts whole. One host limit applies outside the plugin: OpenClaw caps a single tool result at `agents.defaults.contextLimits.toolResultMaxChars` (16,000 characters by default, and at most about 30% of the model's context window), so a longer `hydradb_query` result is cut by OpenClaw itself; raise that setting if you need more. The injected context (`prependContext`) is not a tool result and is not subject to that cap. Each `graph[]` path carries an `origin`: `query_path` (grown from the query's entities) or `chunk_relation` (the neighbourhood of a returned chunk).

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
