import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { HydraDBClient, HydraDBError } from "@hydradb/sdk"

import {
	HydraDB,
	HydraWrapperError,
	isUnifiedIngestResponse,
	isUnifiedLayoutRefusal,
	isUnifiedQueryResponse,
	translateError,
	unwrap,
} from "../hydra/index.ts"

test("unwrap returns .data for an envelope and passes through bare payloads", () => {
	assert.deepEqual(unwrap({ data: { a: 1 }, success: true, meta: {} }), { a: 1 })
	// A bare payload that itself has `success` but no top-level `data`.
	assert.deepEqual(unwrap({ success: true, content: "x" }), {
		success: true,
		content: "x",
	})
	assert.equal(unwrap(null), null)
})

test("translateError reproduces OpenClaw's v1 `Hydra …` error template for SDK errors", () => {
	const err = new HydraDBError({ statusCode: 404, body: { code: "NOT_FOUND" } })
	const translated = translateError("/query", err)
	assert.ok(translated instanceof HydraWrapperError)
	assert.equal(
		translated.message,
		`Hydra /query → 404: ${JSON.stringify({ code: "NOT_FOUND" })}`,
	)
	assert.equal(translated.status, 404)
	assert.equal(translated.path, "/query")
})

test("translateError handles non-SDK failures without a status", () => {
	const translated = translateError("/context/ingest", new Error("socket hang up"))
	assert.equal(translated.message, "Hydra /context/ingest → ERR: socket hang up")
})

test("wrapper catches SDK errors and rethrows the byte-identical message", async () => {
	const failingSdk = {
		query() {
			return Promise.reject(new HydraDBError({ statusCode: 500, body: "boom" }))
		},
	} as unknown as HydraDBClient

	const hydra = new HydraDB(
		{ token: "t", database: "db_test", collection: "col_test" },
		failingSdk,
	)

	await assert.rejects(
		() => hydra.context.query({ query: "hi", kind: "memory" }),
		(e: unknown) => {
			assert.ok(e instanceof HydraWrapperError)
			assert.equal(e.message, "Hydra /query → 500: boom")
			return true
		},
	)
})

test("wrapper unwraps the envelope and returns .data", async () => {
	const okSdk = {
		context: {
			list() {
				return Promise.resolve({
					data: { inner: { sources: [{ id: "s1" }], total: 1 } },
					success: true,
					meta: {},
				})
			},
		},
	} as unknown as HydraDBClient

	const hydra = new HydraDB(
		{ token: "t", database: "db_test", collection: "col_test" },
		okSdk,
	)
	const data = await hydra.context.list({ kind: "knowledge" })
	assert.deepEqual(data, { inner: { sources: [{ id: "s1" }], total: 1 } })
})

// PRO-1618: the three v2 calls the pinned SDK cannot make go over the raw
// transport; these pin the wire shape and the split fallback.
function fetchStub(body: unknown, status = 200): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } {
	const calls: { url: string; init: RequestInit }[] = []
	const impl = ((url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} })
		return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))
	}) as typeof fetch
	return { fetch: impl, calls }
}

// PRO-1618: the unified ingest body, exactly as the contract spells it. The
// list key is `context` (never `items`), the item is text or a conversation of
// {role, content, name?} turns, and enrich / upsert / instructions travel at
// request level. The 202 comes back as it came off the wire, so its
// `results[].source_id` (the context_id) is readable by the host adapter.
test("unified ingest posts the contract body under `context` and returns the 202 verbatim", async () => {
	const { fetch, calls } = fetchStub({
		success: true,
		data: {
			success: true,
			message: "queued",
			results: [{ source_id: "chat-1", title: null, status: "queued", infer: true, error: null, error_code: null }],
			success_count: 1,
			failed_count: 0,
		},
	})
	const sdk = { context: { ingest() { throw new Error("SDK path must not be used") } } } as unknown as HydraDBClient
	const hydra = new HydraDB({ token: "t", database: "db_u", collection: "c1", baseUrl: "https://api.test", fetch }, sdk)
	const result = await hydra.context.ingest({
		kind: "unified",
		pairs: [{ user: "I prefer dark mode", assistant: "Noted" }],
		sourceId: "chat-1",
		userName: "Ada",
		infer: true,
		customInstructions: "focus",
		documentMetadata: JSON.stringify({ source: "openclaw_hook" }),
		tenantMetadata: { topic: "ui" },
		upsert: true,
	})
	assert.ok(isUnifiedIngestResponse(result))
	assert.equal(result.results[0]!.source_id, "chat-1")
	assert.equal(result.success_count, 1)
	assert.equal(result.failed_count, 0)
	assert.equal(calls.length, 1)
	assert.equal(calls[0]!.url, "https://api.test/context/ingest")
	assert.equal((calls[0]!.init.headers as Record<string, string>)["API-Version"], "2")
	assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
		database: "db_u",
		collection: "c1",
		context: [
			{
				context_id: "chat-1",
				conversation: [
					{ role: "user", content: "I prefer dark mode", name: "Ada" },
					{ role: "assistant", content: "Noted" },
				],
				attributes: { topic: "ui" },
				custom_attributes: { source: "openclaw_hook" },
			},
		],
		enrich: true,
		upsert: true,
		instructions: "focus",
	})
})

// Contract client rule 2: none of the split-era or alias names may reach a
// unified database. Instructions follow the split omission rule and travel
// only when enrichment is on.
test("unified ingest never sends split-era or alias field names", async () => {
	const { fetch, calls } = fetchStub({
		success: true,
		data: { success: true, message: "", results: [], success_count: 1, failed_count: 0 },
	})
	const hydra = new HydraDB({ token: "t", database: "db_u", baseUrl: "https://api.test", fetch }, {} as HydraDBClient)
	await hydra.context.ingest({
		kind: "unified",
		text: "note",
		infer: false,
		customInstructions: "not sent when enrich is off",
	})
	const body = JSON.parse(String(calls[0]!.init.body)) as { context: Record<string, unknown>[] } & Record<string, unknown>
	assert.deepEqual(body, { database: "db_u", context: [{ text: "note" }], enrich: false })
	const forbidden = [
		"type", "items", "contexts", "memories", "documents", "app_knowledge",
		"infer", "source_id", "custom_instructions", "metadata", "additional_metadata",
		"observation_date", "relations", "is_markdown", "user_name", "user_assistant_pairs",
	]
	const seen = new Set([...Object.keys(body), ...Object.keys(body.context[0]!)])
	for (const key of forbidden) assert.ok(!seen.has(key), `${key} must not be sent on a unified database`)
})

test("create with a layout posts type; layout() reads details and falls back to split", async () => {
	const { fetch, calls } = fetchStub({
		success: true,
		data: { databases: ["a"], details: [{ database: "a", type: "unified" }] },
	})
	const hydra = new HydraDB({ token: "t", database: "a", baseUrl: "https://api.test", fetch }, {} as HydraDBClient)
	await hydra.databases.create({ database: "new", type: "unified" })
	assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { database: "new", type: "unified" })
	assert.equal(await hydra.databases.layout("a"), "unified")
	assert.equal(await hydra.databases.layout("missing"), "split")
	assert.equal(calls.length, 2, "one create, one memoised probe")

	const failing = fetchStub({ success: false }, 500)
	const broken = new HydraDB({ token: "t", database: "a", baseUrl: "https://api.test", fetch: failing.fetch }, {} as HydraDBClient)
	assert.equal(await broken.databases.layout("a"), "split")
})

test("a raw failure keeps the status and body on the error", async () => {
	const { fetch } = fetchStub({ success: false, error: { code: "VALIDATION_ERROR", message: "type=memory is not valid on a unified database" } }, 400)
	const hydra = new HydraDB({ token: "t", database: "db_u", baseUrl: "https://api.test", fetch }, {} as HydraDBClient)
	await assert.rejects(
		() => hydra.databases.create({ database: "x", type: "unified" }),
		(err: unknown) => {
			assert.ok(err instanceof HydraWrapperError)
			assert.equal(err.status, 400)
			assert.match(err.message, /unified database/)
			return true
		},
	)
})

// PRO-1618: a unified query sends NO `type` (absent is the unified default;
// memory and knowledge are 400 there), carries follow_forceful_relations, and
// gets the contract's four-key body back exactly as it came off the wire. The
// envelope's unified `meta` has no tenant_id, sub_tenant_id or source_type, and
// the result needs none of them.
test("unified query sends no type, carries follow_forceful_relations and returns the four-key body verbatim", async () => {
	// A real unified envelope, exactly as the server renders it: `enrichment`
	// is a string, `enrichment_kind` its sibling, `llm_prompt` markdown.
	const envelope = JSON.parse(
		readFileSync(new URL("./fixtures/unified-query-response.json", import.meta.url), "utf8"),
	) as { data: Record<string, unknown> }
	const unifiedBody = envelope.data
	const { fetch, calls } = fetchStub(envelope)
	const sdk = { query() { throw new Error("SDK query must not be used for unified") } } as unknown as HydraDBClient
	const hydra = new HydraDB({ token: "t", database: "db_u", collection: "c1", baseUrl: "https://api.test", fetch }, sdk)

	const q = await hydra.context.query({
		query: "acme",
		kind: "unified",
		maxResults: 5,
		mode: "thinking",
		alpha: 0.8,
		graphContext: true,
		followForcefulRelations: true,
	})
	assert.ok(isUnifiedQueryResponse(q))
	assert.deepEqual(q, unifiedBody)
	assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
		database: "db_u",
		collection: "c1",
		query: "acme",
		max_results: 5,
		mode: "thinking",
		graph_context: true,
		follow_forceful_relations: true,
		alpha: 0.8,
	})
})

// Contract client rule 4: the shape decides. A server that still answers a
// unified query with the legacy shape is run through the SDK's deserialiser,
// exactly as the split path is, instead of being mistaken for the new body.
test("a legacy-shaped answer to a unified query still parses through the SDK path", async () => {
	const { fetch } = fetchStub({
		success: true,
		data: { chunks: [{ chunk_uuid: "c1", id: "s1", chunk_content: "body", relevancy_score: 0.9 }], graph_context: null },
	})
	const hydra = new HydraDB({ token: "t", database: "db_u", baseUrl: "https://api.test", fetch }, {} as HydraDBClient)
	const q = await hydra.context.query({ query: "acme", kind: "unified" })
	assert.ok(!isUnifiedQueryResponse(q))
	assert.equal(q.chunks?.[0]?.chunkContent, "body")
})

// Unified list, relations and delete keep their SDK-shaped results and simply
// send no `type` anywhere: not in a JSON body, not in a query string.
test("unified list, relations and delete send no type and keep SDK-shaped results", async () => {
	const answers: Record<string, unknown> = {
		"/context/list": { sources: [{ id: "s1", title: "T" }], total: 1 },
		"/context/relations": { relations: [], total: 0 },
		"/context": { success: true, deleted_count: 1, user_memory_deleted: 1, results: [] },
	}
	const calls: { url: string; init: RequestInit }[] = []
	const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
		const path = new URL(String(url)).pathname
		calls.push({ url: String(url), init: init ?? {} })
		return Promise.resolve(
			new Response(JSON.stringify({ success: true, data: answers[path] }), { status: 200, headers: { "content-type": "application/json" } }),
		)
	}) as typeof fetch
	const sdk = {
		context: {
			list() { throw new Error("SDK list must not be used for unified") },
			relations() { throw new Error("SDK relations must not be used for unified") },
			delete() { throw new Error("SDK delete must not be used for unified") },
		},
	} as unknown as HydraDBClient
	const hydra = new HydraDB({ token: "t", database: "db_u", collection: "c1", baseUrl: "https://api.test", fetch: fetchImpl }, sdk)

	const l = await hydra.context.list({ kind: "unified", ids: ["s1"] })
	assert.equal((l as unknown as { sources: { id: string }[] }).sources[0]?.id, "s1")
	assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { database: "db_u", collection: "c1", ids: ["s1"] })

	await hydra.context.relations({ kind: "unified", id: "s1", limit: 5 })
	const relationsUrl = new URL(calls[1]!.url)
	assert.equal(relationsUrl.pathname, "/context/relations")
	assert.equal(relationsUrl.searchParams.get("type"), null, "no type on a unified relations call")
	assert.equal(relationsUrl.searchParams.get("id"), "s1")
	assert.equal(relationsUrl.searchParams.get("limit"), "5")

	const d = await hydra.context.delete({ ids: ["a"], kind: "unified" })
	assert.equal(d.deletedCount, 1)
	assert.equal(calls[2]!.init.method, "DELETE")
	assert.deepEqual(JSON.parse(String(calls[2]!.init.body)), { database: "db_u", collection: "c1", ids: ["a"] })
})

// PRO-1618 / hook budget: a write that failed WITHOUT a status (an AbortError
// timeout, a dropped socket) may already have been applied server-side, and
// `ingestMemory` with no caller `sourceId` sends no `context_id`, so re-sending
// creates a second context rather than upserting the first. It also spends the
// whole per-attempt timeout again inside a hook budget the host will not wait
// for. So a status-less failure is never replayed on those paths.
test("a timed-out ingest is not retried", async () => {
	let attempts = 0
	const fetchImpl = (() => {
		attempts += 1
		const err = new Error("The operation was aborted")
		err.name = "AbortError"
		return Promise.reject(err)
	}) as typeof fetch
	const hydra = new HydraDB(
		{ token: "t", database: "db_u", baseUrl: "https://api.test", fetch: fetchImpl },
		{} as HydraDBClient,
	)
	await assert.rejects(() => hydra.context.ingest({ kind: "unified", text: "note" }))
	assert.equal(attempts, 1, "a non-idempotent write must not be re-sent when the outcome is unknown")
})

// Reads keep the full budget: replaying one costs nothing but time.
test("a timed-out read still retries", async () => {
	let attempts = 0
	const fetchImpl = (() => {
		attempts += 1
		const err = new Error("The operation was aborted")
		err.name = "AbortError"
		return Promise.reject(err)
	}) as typeof fetch
	const hydra = new HydraDB(
		{ token: "t", database: "db_u", baseUrl: "https://api.test", fetch: fetchImpl },
		{} as HydraDBClient,
	)
	assert.equal(await hydra.databases.layout("db_u"), "split", "a failed probe reads as split")
	assert.ok(attempts > 1, "a read is safe to replay and keeps the SDK's retry budget")
})

// The client half of the server's TestCorpusRefusalWordingIsAClientContract.
//
// ONE code, CORPUS_TYPE_UNSUPPORTED, covers six refusals and they do not point
// the same way: two mean "retry as unified", four mean the caller must change
// something else. Retrying one of the four would turn a clear 400 into a second
// one AND pin a SPLIT database to `unified` for the life of the process. So the
// code cannot decide direction on its own and the wording is a contract on both
// sides of the wire — the server asserts these strings, this asserts we still
// read them correctly.
//
// Verbatim from application/internal/api/handler/{corpus,context,errors}.go and
// platform/storagelayout/corpus_type.go.
test("every CORPUS_TYPE_UNSUPPORTED refusal is classified in the right direction", () => {
	const DOCS = "See https://docs.hydradb.com/api-reference/v2/endpoint/ingest for usage details. "
	const refusals: [string, boolean, string][] = [
		[
			"an unknown type (validateCorpusSyntax)",
			false,
			`invalid type "momory": must be 'knowledge', 'memory', 'unified' or 'all'. ${DOCS}`,
		],
		[
			"knowledge/memory on a UNIFIED database (ValidateCorpusType) — ours",
			true,
			`type "memory" is not valid on a unified database: knowledge and memory are one corpus here, ` +
				`so there is nothing to select between. Omit \`type\` (or send "unified") and filter on the ` +
				`is_memory attribute if you need one kind. ${DOCS}`,
		],
		[
			"`unified` on a SPLIT database (ValidateCorpusType) — the opposite direction",
			false,
			`type "unified" is only valid on a unified database; this database stores knowledge and ` +
				`memory separately, so use "knowledge", "memory" or "all", or create a new unified ` +
				`database. ${DOCS}`,
		],
		[
			"`all` on an ingest, unified advice — the phrase-inside-the-advice trap",
			false,
			"invalid type 'all': it selects both corpora for reads and deletes, but an ingest must " +
				"name the one it writes to. This database is unified, so send 'unified' or omit `type` " +
				"entirely. " + DOCS,
		],
		[
			"`all` on an ingest, split advice",
			false,
			"invalid type 'all': it selects both corpora for reads and deletes, but an ingest must " +
				"name the one it writes to. Use 'knowledge' or 'memory'. " + DOCS,
		],
		[
			"items[] combined with type=knowledge",
			false,
			"items cannot be combined with type=knowledge: items are memory-shaped (text or a " +
				"conversation); omit type or use the unified default. " + DOCS,
		],
		[
			"split-era fields against a unified database (ingest body) — ours",
			true,
			"this database is unified: send the content as `items` (a JSON array of text or " +
				"conversation items), either as a form field or as an application/json body; documents, " +
				"app_knowledge and memories are only accepted on a split database. " + DOCS,
		],
	]

	for (const [name, shouldRetry, serverMessage] of refusals) {
		const body = { success: false, error: { code: "CORPUS_TYPE_UNSUPPORTED", message: serverMessage } }
		const err = new HydraWrapperError(
			`Hydra /context/ingest → 400: ${JSON.stringify(body)}`,
			"/context/ingest",
			{ status: 400, body },
		)
		assert.equal(isUnifiedLayoutRefusal(err), shouldRetry, `${name}: retry=${shouldRetry}`)
	}
})

// context_category carries its OWN code, so it can never reach this branch.
// Pinned anyway: the message names a unified database, and the fix is to stop
// sending the field, never to retry with a different `type`.
test("the context_category refusal is never read as a layout answer", () => {
	const body = {
		success: false,
		error: {
			code: "CONTEXT_CATEGORY_UNSUPPORTED",
			message:
				"context_category is only supported on a unified database, where knowledge and memory " +
				'are one corpus. This database is split, so `type` already selects the corpus; omit ' +
				'context_category (or send "auto"). ',
		},
	}
	const err = new HydraWrapperError(
		`Hydra /query → 400: ${JSON.stringify(body)}`,
		"/query",
		{ status: 400, body },
	)
	assert.equal(isUnifiedLayoutRefusal(err), false)
})

// The raw transport was ported from the MCP wrapper and brought its `Hydra DB …`
// prefix with it. OpenClaw's contract is `Hydra ${path} → …` (errors.ts), and
// `translateError` returns a HydraWrapperError untouched, so a raw-built message
// reaches an agent tool — and therefore the model — exactly as written. Both raw
// branches are pinned: the status one and the status-less one.
test("raw errors use OpenClaw's `Hydra …` template, not the MCP `Hydra DB …` one", async () => {
	const failing = (() =>
		Promise.resolve(
			new Response(JSON.stringify({ success: false, error: { message: "nope" } }), {
				status: 400,
				headers: { "content-type": "application/json" },
			}),
		)) as typeof fetch
	const hydra = new HydraDB(
		{ token: "t", database: "db_u", baseUrl: "https://api.test", fetch: failing },
		{} as HydraDBClient,
	)
	await assert.rejects(
		() => hydra.context.ingest({ kind: "unified", text: "note" }),
		(err: unknown) => {
			assert.ok(err instanceof HydraWrapperError)
			assert.match(err.message, /^Hydra \/context\/ingest → 400: /)
			assert.ok(!err.message.startsWith("Hydra DB "), "the MCP prefix must not leak into OpenClaw")
			return true
		},
	)

	const aborting = (() => {
		const err = new Error("The operation was aborted")
		err.name = "AbortError"
		return Promise.reject(err)
	}) as typeof fetch
	const timing = new HydraDB(
		{ token: "t", database: "db_u", baseUrl: "https://api.test", fetch: aborting },
		{} as HydraDBClient,
	)
	await assert.rejects(
		() => timing.context.ingest({ kind: "unified", text: "note" }),
		(err: unknown) => {
			assert.ok(err instanceof HydraWrapperError)
			assert.match(err.message, /^Hydra \/context\/ingest → ERR: timed out after \d+ms$/)
			return true
		},
	)
})

// A unified GET carries its scope in the query string, so the URL handed to the
// transport varies per request: database, collection, item id, cursor. That URL
// is fine to SEND and wrong to keep — it reaches an agent tool, and therefore
// the model, through both `HydraWrapperError.path` and the message. `path` is
// also the field the error contract is keyed on, so a per-request value cannot
// be matched on and anything branching on it silently stops working for exactly
// the unified GET calls. Both halves are pinned here.
test("a failing unified relations call reports the operation path, not the request URL", async () => {
	let sentUrl = ""
	const failing = ((url: string | URL | Request) => {
		sentUrl = String(url)
		return Promise.resolve(
			new Response(JSON.stringify({ success: false, error: { message: "nope" } }), {
				status: 400,
				headers: { "content-type": "application/json" },
			}),
		)
	}) as typeof fetch
	const hydra = new HydraDB(
		{ token: "t", database: "db_secret", collection: "col_secret", baseUrl: "https://api.test", fetch: failing },
		{} as HydraDBClient,
	)

	await assert.rejects(
		() => hydra.context.relations({ kind: "unified", id: "src_private_123", limit: 5 }),
		(err: unknown) => {
			assert.ok(err instanceof HydraWrapperError)
			assert.equal(err.path, "/context/relations", "path must be the stable operation path")
			assert.match(err.message, /^Hydra \/context\/relations → 400: /)
			for (const secret of ["db_secret", "col_secret", "src_private_123", "limit"]) {
				assert.ok(
					!err.message.includes(secret),
					`the message must not expose ${secret} to an agent tool`,
				)
			}
			return true
		},
	)

	// The request itself still carries the full URL — only the error is trimmed.
	assert.match(sentUrl, /\/context\/relations\?/)
	assert.ok(sentUrl.includes("src_private_123"), "the wire call still sends the real scope")
})
