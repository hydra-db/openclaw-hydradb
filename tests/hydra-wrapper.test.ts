import assert from "node:assert/strict"
import { test } from "node:test"

import { HydraDBClient, HydraDBError } from "@hydradb/sdk"

import {
	HydraDB,
	HydraWrapperError,
	isUnifiedLayoutRefusal,
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

test("unified ingest posts items[] as a JSON body", async () => {
	const { fetch, calls } = fetchStub({ success: true, data: { success: true, success_count: 1, failed_count: 0 } })
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
		upsert: true,
	})
	// The counts survive the raw path in the SDK's camelCase, so the host
	// adapter reports them instead of zeros (Greptile on #26).
	assert.equal(result.successCount, 1)
	assert.equal(result.failedCount, 0)
	assert.equal(calls.length, 1)
	assert.equal(calls[0]!.url, "https://api.test/context/ingest")
	assert.equal((calls[0]!.init.headers as Record<string, string>)["API-Version"], "2")
	assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
		database: "db_u",
		collection: "c1",
		upsert: true,
		items: [
			{
				conversation: [
					{ role: "user", content: "I prefer dark mode", name: "Ada" },
					{ role: "assistant", content: "Noted" },
				],
				context_id: "chat-1",
				enrich: true,
				custom_instructions: "focus",
				custom_attributes: { source: "openclaw_hook" },
			},
		],
	})
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

// The pinned SDK's REQUEST serializers reject `type: "unified"` before anything
// is sent, so unified reads and deletes are built by hand and their results
// parsed with the SDK's own response serializer (same camelCase either way).
test("unified query, list and delete bypass the SDK request serializers and return SDK-shaped results", async () => {
	const answers: Record<string, unknown> = {
		"/query": { chunks: [{ chunk_uuid: "c1", id: "s1", chunk_content: "body", relevancy_score: 0.9 }], sources: [] },
		"/context/list": { sources: [{ id: "s1", title: "T" }], total: 1 },
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
		query() { throw new Error("SDK query must not be used for unified") },
		context: {
			list() { throw new Error("SDK list must not be used for unified") },
			delete() { throw new Error("SDK delete must not be used for unified") },
		},
	} as unknown as HydraDBClient
	const hydra = new HydraDB({ token: "t", database: "db_u", collection: "c1", baseUrl: "https://api.test", fetch: fetchImpl }, sdk)

	const q = await hydra.context.query({ query: "acme", kind: "unified", maxResults: 5, mode: "thinking", alpha: 0.8 })
	assert.equal(q.chunks?.[0]?.chunkContent, "body")
	assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
		database: "db_u", collection: "c1", query: "acme", type: "unified", max_results: 5, mode: "thinking", alpha: 0.8,
	})

	const l = await hydra.context.list({ kind: "unified" })
	assert.equal((l as unknown as { sources: { id: string }[] }).sources[0]?.id, "s1")
	assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { database: "db_u", collection: "c1", type: "unified" })

	const d = await hydra.context.delete({ ids: ["a"], kind: "unified" })
	assert.equal(d.deletedCount, 1)
	assert.equal(calls[2]!.init.method, "DELETE")
	assert.deepEqual(JSON.parse(String(calls[2]!.init.body)), { database: "db_u", collection: "c1", ids: ["a"], type: "unified" })
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
