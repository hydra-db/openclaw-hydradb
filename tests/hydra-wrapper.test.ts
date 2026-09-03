import assert from "node:assert/strict"
import { test } from "node:test"

import { HydraDBClient, HydraDBError } from "@hydradb/sdk"

import { HydraDB, HydraWrapperError, translateError, unwrap } from "../hydra/index.ts"

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
	await hydra.context.ingest({
		kind: "unified",
		pairs: [{ user: "I prefer dark mode", assistant: "Noted" }],
		sourceId: "chat-1",
		userName: "Ada",
		infer: true,
		customInstructions: "focus",
		documentMetadata: JSON.stringify({ source: "openclaw_hook" }),
		upsert: true,
	})
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
