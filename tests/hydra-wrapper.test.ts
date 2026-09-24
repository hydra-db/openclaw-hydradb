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
import { UNIFIED_MAX_TEXT_BYTES } from "../hydra/client.ts"

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

// PRO-2224: every unified call goes through @hydradb/sdk (2.1.6+) except a
// unified database create, whose layout enum the SDK does not carry yet. These
// run the REAL SDK over a stub fetch and pin the exact wire each call sends.
type Sent = { url: string; method: string; json?: Record<string, unknown>; form?: Record<string, string> }

function sdkServer(
	answer: (path: string) => { status?: number; body: unknown },
): { fetch: typeof fetch; sent: Sent[] } {
	const sent: Sent[] = []
	const impl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input)
		const req = new Request(url, init)
		const entry: Sent = { url, method: req.method }
		const type = req.headers.get("content-type") ?? ""
		if (type.includes("multipart/form-data")) {
			const fd = await req.formData()
			entry.form = Object.fromEntries([...fd.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `<file ${v.name}>`]))
		} else if (req.method !== "GET") {
			const text = await req.text()
			if (text) entry.json = JSON.parse(text)
		}
		sent.push(entry)
		const { status = 200, body } = answer(new URL(url).pathname)
		return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
	}) as typeof fetch
	return { fetch: impl, sent }
}

const env = (data: unknown) => ({ success: true, data, meta: { request_id: "r1" } })

// The unified ingest item, exactly as the contract (hydradb-application#1653)
// spells it: `context` (never `items`), a conversation of exactly {role,
// content} turns, the speaker as the item's `user_name`, and enrich / upsert /
// instructions at request level. The SDK sends it as its multipart `context`
// field; the 202 comes back in its wire spelling with the context id as `id`.
test("unified ingest goes through the SDK with the strict item contract and returns the 202 in wire spelling", async () => {
	const { fetch, sent } = sdkServer(() => ({
		status: 202,
		body: env({
			success_count: 1,
			failed_count: 0,
			results: [{ id: "chat-1", status: "queued", error: null, error_code: null }],
		}),
	}))
	const hydra = new HydraDB({ token: "t", database: "db_u", collection: "c1", baseUrl: "https://api.test", fetch })
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
	assert.equal(result.results[0]!.id, "chat-1")
	assert.equal(result.success_count, 1)
	assert.equal(result.failed_count, 0)
	assert.equal(sent.length, 1)
	assert.equal(new URL(sent[0]!.url).pathname, "/context/ingest")
	const form = sent[0]!.form!
	assert.equal(form.database, "db_u")
	assert.equal(form.collection, "c1")
	assert.equal(form.enrich, "true")
	assert.equal(form.upsert, "true")
	assert.equal(form.instructions, "focus")
	assert.ok(!("type" in form), "no type on a unified database")
	assert.deepEqual(JSON.parse(form.context!), [
		{
			context_id: "chat-1",
			conversation: [
				{ role: "user", content: "I prefer dark mode" },
				{ role: "assistant", content: "Noted" },
			],
			user_name: "Ada",
			attributes: { topic: "ui" },
			custom_attributes: { source: "openclaw_hook" },
		},
	])
})

// Contract client rule 2: none of the split-era or alias names may reach a
// unified database, and a turn never carries `name`. Instructions follow the
// split omission rule and travel only when enrichment is on.
test("unified ingest never sends split-era or alias field names", async () => {
	const { fetch, sent } = sdkServer(() => ({ status: 202, body: env({ success_count: 1, failed_count: 0, results: [] }) }))
	const hydra = new HydraDB({ token: "t", database: "db_u", baseUrl: "https://api.test", fetch })
	await hydra.context.ingest({ kind: "unified", text: "note", infer: false, customInstructions: "not sent when enrich is off" })
	const form = sent[0]!.form!
	assert.deepEqual(form, { context: JSON.stringify([{ text: "note" }]), database: "db_u", enrich: "false" })
	const item = JSON.parse(form.context!)[0] as Record<string, unknown>
	const forbidden = [
		"type", "items", "contexts", "memories", "documents", "app_knowledge",
		"infer", "source_id", "custom_instructions", "metadata", "additional_metadata",
		"observation_date", "relations", "is_markdown", "user_assistant_pairs", "name",
	]
	const seen = new Set([...Object.keys(form), ...Object.keys(item)])
	for (const key of forbidden) assert.ok(!seen.has(key), `${key} must not be sent on a unified database`)
})

// A conversation keeps its LATEST turns within the server's per-item text cap:
// auto-capture re-sends the whole session under one id on every turn, and a
// refused item would stop the session being saved at all.
test("unified ingest keeps the latest turns within the per-item cap", async () => {
	const { fetch, sent } = sdkServer(() => ({ status: 202, body: env({ success_count: 1, failed_count: 0, results: [] }) }))
	const hydra = new HydraDB({ token: "t", database: "db_u", baseUrl: "https://api.test", fetch })
	const big = "x".repeat(300_000)
	const pairs = [0, 1, 2, 3, 4].map((i) => ({ user: `q${i} ${big}`, assistant: `a${i}` }))
	await hydra.context.ingest({ kind: "unified", pairs })
	const turns = JSON.parse(sent[0]!.form!.context!)[0].conversation as { role: string; content: string }[]
	const bytes = turns.reduce((n, t) => n + Buffer.byteLength(t.content), 0)
	assert.ok(bytes <= UNIFIED_MAX_TEXT_BYTES, `kept ${bytes} bytes`)
	assert.equal(turns.at(-1)!.content, "a4", "the newest turn is kept")
	assert.ok(turns[0]!.content.startsWith("q2"), "the oldest turns are the ones dropped")
})

test("an oversized newest exchange keeps the assistant's reply", async () => {
	const { fetch, sent } = sdkServer(() => ({ status: 202, body: env({ success_count: 1, failed_count: 0, results: [] }) }))
	const hydra = new HydraDB({ token: "t", database: "db_u", baseUrl: "https://api.test", fetch })
	await hydra.context.ingest({
		kind: "unified",
		pairs: [{ user: "p".repeat(UNIFIED_MAX_TEXT_BYTES + 5000), assistant: "the reply that must survive" }],
	})
	const turns = JSON.parse(sent[0]!.form!.context!)[0].conversation as { role: string; content: string }[]
	assert.deepEqual(turns.map((t) => t.role), ["user", "assistant"])
	assert.equal(turns[1]!.content, "the reply that must survive")
	assert.ok(turns.reduce((n, t) => n + Buffer.byteLength(t.content), 0) <= UNIFIED_MAX_TEXT_BYTES)
})

test("the hand-built unified create is bounded by a timeout", async () => {
	let signal: AbortSignal | undefined
	const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
		signal = init?.signal ?? undefined
		return new Response(JSON.stringify(env({ status: "accepted" })), { status: 200, headers: { "content-type": "application/json" } })
	}) as typeof fetch
	const hydra = new HydraDB({ token: "t", database: "a", baseUrl: "https://api.test", fetch: impl })
	await hydra.databases.create({ database: "new", type: "unified" })
	assert.ok(signal instanceof AbortSignal, "the request carries an abort signal")
})

test("unified ingest refuses a single text over the per-item cap before sending", async () => {
	const { fetch, sent } = sdkServer(() => ({ status: 202, body: env({}) }))
	const hydra = new HydraDB({ token: "t", database: "db_u", baseUrl: "https://api.test", fetch })
	await assert.rejects(
		() => hydra.context.ingest({ kind: "unified", text: "y".repeat(UNIFIED_MAX_TEXT_BYTES + 1) }),
		(err: unknown) => err instanceof HydraWrapperError && /at most 1048576/.test(err.message),
	)
	assert.equal(sent.length, 0)
})

// A unified database create is the one hand-built call (the SDK's layout enum
// has only "split"); a split or unspecified create goes through the SDK. The
// layout probe goes through the SDK with a short budget and no retries.
test("create sends type; layout() reads details through the SDK and falls back to split", async () => {
	const { fetch, sent } = sdkServer((path) =>
		path === "/databases"
			? { body: env({ status: "accepted", databases: ["a"], details: [{ database: "a", type: "unified" }] }) }
			: { status: 404, body: {} },
	)
	const hydra = new HydraDB({ token: "t", database: "a", baseUrl: "https://api.test", fetch })
	await hydra.databases.create({ database: "new", type: "unified" })
	await hydra.databases.create({ database: "old", type: "split" })
	await hydra.databases.create({ database: "plain" })
	assert.deepEqual(sent.map((s) => s.json), [
		{ database: "new", type: "unified" },
		{ database: "old", type: "split" },
		{ database: "plain" },
	])
	assert.equal(await hydra.databases.layout("a"), "unified")
	assert.equal(await hydra.databases.layout("missing"), "split")
	assert.equal(sent.filter((s) => s.method === "GET").length, 1, "one probe, reused")

	let probes = 0
	const failing = (async () => {
		probes += 1
		return new Response(JSON.stringify({ success: false }), { status: 503, headers: { "content-type": "application/json" } })
	}) as typeof fetch
	const broken = new HydraDB({ token: "t", database: "a", baseUrl: "https://api.test", fetch: failing })
	assert.equal(await broken.databases.layout("a"), "split", "a failed probe reads as split")
	assert.equal(probes, 1, "the probe is not retried: it runs before the first call")
})

test("a failed unified create keeps the status and body on the error", async () => {
	const { fetch } = sdkServer(() => ({
		status: 400,
		body: { success: false, error: { code: "VALIDATION_ERROR", message: "type=memory is not valid on a unified database" } },
	}))
	const hydra = new HydraDB({ token: "t", database: "db_u", baseUrl: "https://api.test", fetch })
	await assert.rejects(
		() => hydra.databases.create({ database: "x", type: "unified" }),
		(err: unknown) => {
			assert.ok(err instanceof HydraWrapperError)
			assert.equal(err.status, 400)
			assert.match(err.message, /^Hydra \/databases → 400: .*unified database/)
			return true
		},
	)
})

// A unified query sends NO `type`, carries follow_forceful_relations, and
// returns the contract's four-key body in its wire spelling, whichever
// spelling the SDK's union handed back.
test("unified query sends no type, carries follow_forceful_relations and returns the four-key body verbatim", async () => {
	const envelope = JSON.parse(
		readFileSync(new URL("./fixtures/unified-query-response.json", import.meta.url), "utf8"),
	) as { data: Record<string, unknown> }
	const { fetch, sent } = sdkServer(() => ({ body: envelope }))
	const hydra = new HydraDB({ token: "t", database: "db_u", collection: "c1", baseUrl: "https://api.test", fetch })
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
	assert.deepEqual(q, envelope.data)
	assert.deepEqual(sent[0]!.json, {
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

// The SDK's union returns a body that matches its four-key model camelCased,
// and one that does not (no enrichment_kind/temporal here) as sent. Both, and
// one with no forceful_relations (optional in the contract), come back in the
// wire spelling, key for key.
test("every unified answer comes back in the wire spelling", async () => {
	const plain = {
		chunks: [{ chunk_id: "a_0", context_id: "a", score: 0.9, content: "hi", enrichment: "e", received_at: "2026-09-23T00:00:00Z" }],
		graph: [
			{
				origin: "query_path",
				path_summary: "A -> B",
				triplets: [
					{
						source: { entity_id: "1", name: "A" },
						relation: { predicate: "p", context: "c", relationship_id: "r", chunk_id: "a_0" },
						target: { entity_id: "2", name: "B" },
					},
				],
			},
		],
		forceful_relations: [{ via: { from: "a", to: "b" }, chunk: { chunk_id: "b_0", context_id: "b", score: 0.5, content: "x" } }],
		llm_prompt: "# Query results",
	}
	const { forceful_relations: _dropped, ...noForceful } = plain
	for (const body of [plain, noForceful]) {
		const { fetch } = sdkServer(() => ({ body: env(body) }))
		const hydra = new HydraDB({ token: "t", database: "db_u", baseUrl: "https://api.test", fetch })
		const q = await hydra.context.query({ query: "q", kind: "unified" })
		assert.deepEqual(q, body)
	}
})

// Contract client rule 4: the shape decides. A server that still answers a
// unified query with the legacy shape is returned as the SDK parsed it,
// exactly as the split path is, instead of being mistaken for the new body.
test("a legacy-shaped answer to a unified query stays SDK-shaped", async () => {
	const { fetch } = sdkServer(() => ({
		body: env({ chunks: [{ chunk_uuid: "c1", id: "s1", chunk_content: "body", relevancy_score: 0.9 }], graph_context: null }),
	}))
	const hydra = new HydraDB({ token: "t", database: "db_u", baseUrl: "https://api.test", fetch })
	const q = await hydra.context.query({ query: "acme", kind: "unified" })
	assert.ok(!isUnifiedQueryResponse(q))
	assert.equal(q.chunks?.[0]?.chunkContent, "body")
})

// Unified list, relations and delete go through the SDK and simply send no
// `type` anywhere: not in a JSON body, not in a query string.
test("unified list, relations and delete send no type and keep SDK-shaped results", async () => {
	const answers: Record<string, unknown> = {
		"/context/list": { sources: [{ id: "s1", title: "T" }], total: 1 },
		"/context/relations": { relations: [], total: 0 },
		"/context": { success: true, deleted_count: 1, user_memory_deleted: 1, results: [] },
	}
	const { fetch, sent } = sdkServer((path) => ({ body: env(answers[path]) }))
	const hydra = new HydraDB({ token: "t", database: "db_u", collection: "c1", baseUrl: "https://api.test", fetch })

	const l = await hydra.context.list({ kind: "unified", ids: ["s1"] })
	assert.equal((l as unknown as { sources: { id: string }[] }).sources[0]?.id, "s1")
	assert.deepEqual(sent[0]!.json, { database: "db_u", collection: "c1", ids: ["s1"] })

	await hydra.context.relations({ kind: "unified", id: "s1", limit: 5 })
	const relationsUrl = new URL(sent[1]!.url)
	assert.equal(relationsUrl.pathname, "/context/relations")
	assert.equal(relationsUrl.searchParams.get("type"), null, "no type on a unified relations call")
	assert.equal(relationsUrl.searchParams.get("id"), "s1")
	assert.equal(relationsUrl.searchParams.get("limit"), "5")

	const d = await hydra.context.delete({ ids: ["a"], kind: "unified" })
	assert.equal(d.deletedCount, 1)
	assert.equal(sent[2]!.method, "DELETE")
	assert.deepEqual(sent[2]!.json, { database: "db_u", collection: "c1", ids: ["a"] })
})

// A write that failed WITHOUT a status (a timeout, a dropped socket) may already
// have been applied server-side, and an ingest with no caller `sourceId` sends
// no `context_id`, so re-sending would create a second context. The SDK only
// retries status-carrying failures (408/429/5xx), so a timed-out ingest is sent
// once.
test("a timed-out ingest is not retried", async () => {
	let attempts = 0
	const fetchImpl = (() => {
		attempts += 1
		const err = new Error("The operation was aborted")
		err.name = "AbortError"
		return Promise.reject(err)
	}) as typeof fetch
	const hydra = new HydraDB({ token: "t", database: "db_u", baseUrl: "https://api.test", fetch: fetchImpl })
	await assert.rejects(() => hydra.context.ingest({ kind: "unified", text: "note" }))
	assert.equal(attempts, 1, "a non-idempotent write must not be re-sent when the outcome is unknown")
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

// OpenClaw's error contract is `Hydra ${path} → …` (errors.ts): an SDK error
// reaches an agent tool, and therefore the model, in that form, both with a
// status and without one.
test("unified errors use OpenClaw's `Hydra …` template, not the MCP `Hydra DB …` one", async () => {
	const failing = (() =>
		Promise.resolve(
			new Response(JSON.stringify({ success: false, error: { message: "nope" } }), {
				status: 400,
				headers: { "content-type": "application/json" },
			}),
		)) as typeof fetch
	const hydra = new HydraDB({ token: "t", database: "db_u", baseUrl: "https://api.test", fetch: failing })
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
	const timing = new HydraDB({ token: "t", database: "db_u", baseUrl: "https://api.test", fetch: aborting })
	await assert.rejects(
		() => timing.context.ingest({ kind: "unified", text: "note" }),
		(err: unknown) => {
			assert.ok(err instanceof HydraWrapperError)
			assert.match(err.message, /^Hydra \/context\/ingest → ERR: /)
			return true
		},
	)
})

// A unified GET carries its scope in the query string. That URL is fine to
// SEND and wrong to keep: it would reach an agent tool, and the model, through
// the error. The error names the stable operation path only.
test("a failing unified relations call reports the operation path, not the request URL", async () => {
	let sentUrl = ""
	const failing = ((url: string | URL | Request) => {
		sentUrl = String(url instanceof Request ? url.url : url)
		return Promise.resolve(
			new Response(JSON.stringify({ success: false, error: { message: "nope" } }), {
				status: 400,
				headers: { "content-type": "application/json" },
			}),
		)
	}) as typeof fetch
	const hydra = new HydraDB({
		token: "t",
		database: "db_secret",
		collection: "col_secret",
		baseUrl: "https://api.test",
		fetch: failing,
	})
	await assert.rejects(
		() => hydra.context.relations({ kind: "unified", id: "src_private_123", limit: 5 }),
		(err: unknown) => {
			assert.ok(err instanceof HydraWrapperError)
			assert.equal(err.path, "/context/relations", "path must be the stable operation path")
			assert.match(err.message, /^Hydra \/context\/relations → 400: /)
			for (const secret of ["db_secret", "col_secret", "src_private_123", "limit"]) {
				assert.ok(!err.message.includes(secret), `the message must not expose ${secret} to an agent tool`)
			}
			return true
		},
	)
	assert.match(sentUrl, /\/context\/relations\?/)
	assert.ok(sentUrl.includes("src_private_123"), "the wire call still sends the real scope")
})
