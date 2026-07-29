# Conformance

`vectors.json` is the **shared** HydraDB client conformance fixture (PRO-1298).
It is identical across all four client repos (`hydradb-cli`, `hydradb-mcp`,
`openclaw-hydradb`, `hydradb-claude-code`) and is maintained centrally alongside
`CONTRACT.md`. Do not edit this repo's copy in isolation.

`conformance.test.ts` is this repo's runner. It drives every vector through the
plugin's HydraDB wrapper (`hydra/`) against a **mocked SDK transport** and
asserts the canonical SDK call the wrapper produces. This is the anti-drift gate:
a wrapper that renames an action, drops scope, changes a default, or regresses
ingest content-type fails its own CI here.

## How a vector is checked

Each vector's `call` (`op` + `args`) is invoked on the wrapper. The mocked SDK
records the leaf method it received and the request object passed to it. The
runner then checks `expect.sdk`:

| Field | Meaning | How it is asserted |
|---|---|---|
| `method` | SDK leaf method the wrapper must call | recorded method name equals it |
| `args_include` | fields that must appear on the SDK request | deep-equal against the recorded request object |
| `args_scope` | the `database` / `collection` scope the wrapper injects | deep-equal against the recorded request object |
| `content_type` | required request content type | `context.ingest` is multipart; other calls are JSON |
| `forbid_content_type` | content type the call must NOT use | recorded content type differs |
| `forbid_field` | field the SDK request must NOT carry | recorded request has no such key (e.g. knowledge ingest never sends `app_sources`) |
| `source_field_in` | knowledge source must ride in one of these fields | recorded request carries at least one (`app_knowledge` or `documents`) |

Vectors whose `optional_for` lists `openclaw` are skipped here — they exercise
behaviour this client does not do (e.g. stable client-assigned source ids).

The final two tests assert the alias policy (CONTRACT §3): every
`aliases.openclaw_tool` and `aliases.openclaw_slash` entry resolves, via
`ALIAS_REPLACEMENTS` / `SLASH_ALIAS_REPLACEMENTS`, to a registered canonical
name — so a deprecated user-facing name and its canonical name drive the same
operation.

## Running

```sh
npm run test:conformance   # just the vectors
npm test                   # unit + conformance
```
