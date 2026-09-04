import { test } from "node:test"
import assert from "node:assert/strict"

import { HydraClient } from "../client.ts"
import { HydraDB, HydraWrapperError } from "../hydra/index.ts"
import type { HydraDBClient } from "@hydradb/sdk"

// The OpenClaw analog of the MCP client payload test (hydradb-mcp PR #36). The
// v1 client hit raw HTTP; the migrated `HydraClient` delegates to the wrapper,
// so we assert the HOST-LAYER contribution — ingest instructions, upsert,
// source_id, document_metadata, and the recall defaults (type=memory, alpha,
// mode) — by recording the args the wrapper receives, plus response adaptation.

type Recorded = { method: string; args: Record<string, unknown> }

function mockClient(dataByMethod: Record<string, unknown> = {}): {
	client: HydraClient
	calls: Recorded[]
} {
	const calls: Recorded[] = []
	const record = (method: string) => (args: Record<string, unknown>) => {
		calls.push({ method, args })
		return Promise.resolve(dataByMethod[method] ?? {})
	}
	const hydra = {
		context: {
			ingest: record("ingest"),
			query: record("query"),
			list: record("list"),
			inspect: record("inspect"),
			delete: record("delete"),
		},
	} as unknown as HydraDB

	const client = new HydraClient("test-key", "tenant-a", "sub-a", undefined, hydra)
	return { client, calls }
}

test("ingestText attaches the INGEST_INSTRUCTIONS, upsert and source/title", async () => {
	const { client, calls } = mockClient({
		ingest: { success: true, successCount: 1, failedCount: 0 },
	})

	const res = await client.ingestText("hello world", {
		sourceId: "source-1",
		title: "Title",
		infer: true,
	})

	const ingest = calls.find((c) => c.method === "ingest")!
	assert.equal(ingest.args.kind, "memory")
	assert.equal(ingest.args.text, "hello world")
	assert.equal(ingest.args.infer, true)
	assert.equal(ingest.args.upsert, true)
	assert.equal(ingest.args.sourceId, "source-1")
	assert.equal(ingest.args.title, "Title")
	// PII-capture clause is preserved verbatim (known divergence, separate ticket).
	assert.match(
		String(ingest.args.customInstructions),
		/Capture important personal details like name, age, email ids, phone numbers/,
	)
	// Response is adapted back to the legacy snake_case shape.
	assert.deepEqual(res, {
		success: true,
		message: "",
		results: [],
		success_count: 1,
		failed_count: 0,
	})
})

test("ingestText omits custom_instructions when infer is false", async () => {
	const { client, calls } = mockClient()
	await client.ingestText("note", { infer: false })
	const ingest = calls.find((c) => c.method === "ingest")!
	assert.equal(ingest.args.infer, false)
	assert.equal(ingest.args.customInstructions, undefined)
})

test("ingestConversation threads document_metadata and pairs through the wrapper", async () => {
	const { client, calls } = mockClient()
	await client.ingestConversation(
		[{ user: "hi", assistant: "hello" }],
		"hook_sess1",
		{ metadata: { captured_at: "2026-07-24T00:00:00Z", source: "openclaw_hook" } },
	)

	const ingest = calls.find((c) => c.method === "ingest")!
	assert.equal(ingest.args.kind, "memory")
	assert.deepEqual(ingest.args.pairs, [{ user: "hi", assistant: "hello" }])
	assert.equal(ingest.args.sourceId, "hook_sess1")
	assert.equal(ingest.args.userName, "User")
	assert.equal(ingest.args.upsert, true)
	assert.equal(
		ingest.args.documentMetadata,
		JSON.stringify({ captured_at: "2026-07-24T00:00:00Z", source: "openclaw_hook" }),
	)
})

test("recall maps to a memory query with the v1 defaults (alpha 0.8, mode thinking)", async () => {
	const { client, calls } = mockClient({ query: { chunks: [] } })
	await client.recall("what do I prefer")

	const query = calls.find((c) => c.method === "query")!
	assert.equal(query.args.query, "what do I prefer")
	assert.equal(query.args.kind, "memory")
	assert.equal(query.args.alpha, 0.8)
	assert.equal(query.args.mode, "thinking")
	assert.equal(query.args.maxResults, 10)
	assert.equal(query.args.recencyBias, 0)
	assert.equal(query.args.graphContext, true)
})

test("listSources scopes to knowledge on a split database and passes ids", async () => {
	const { client, calls } = mockClient({
		list: { inner: { sources: [], total: 0 } },
	})
	await client.listSources(["source-1"])

	const list = calls.find((c) => c.method === "list")!
	assert.equal(list.args.kind, "knowledge")
	assert.deepEqual(list.args.ids, ["source-1"])
})

test("deleteMemory maps to a memory delete and adapts the boolean result", async () => {
	const { client, calls } = mockClient({
		delete: { success: true, userMemoryDeleted: 1 },
	})
	const res = await client.deleteMemory("mem-123")

	const del = calls.find((c) => c.method === "delete")!
	assert.deepEqual(del.args.ids, ["mem-123"])
	assert.equal(del.args.kind, "memory")
	assert.deepEqual(res, { success: true, user_memory_deleted: true })
})

test("fetchContent adapts the SDK inspect shape and normalises empty error to null", async () => {
	const { client, calls } = mockClient({
		inspect: { success: true, id: "src-9", content: "body", error: "" },
	})
	const res = await client.fetchContent("src-9")

	const inspect = calls.find((c) => c.method === "inspect")!
	assert.equal(inspect.args.id, "src-9")
	assert.equal(inspect.args.mode, "content")
	assert.equal(res.success, true)
	assert.equal(res.source_id, "src-9")
	assert.equal(res.content, "body")
	assert.equal(res.error, null)
})

// Guards that the injected mock and the real wrapper share a constructor seam.
test("HydraClient exposes tenant/collection accessors", () => {
	const { client } = mockClient()
	assert.equal(client.getTenantId(), "tenant-a")
	assert.equal(client.getSubTenantId(), "sub-a")
})

// PRO-1618: on a unified database the server refuses `memory`, so every call
// the host layer makes must carry `unified` there and `memory` on a split one.
function mockClientWithLayout(
	layout: "split" | "unified",
	setting: "auto" | "split" | "unified" = "auto",
): { client: HydraClient; calls: Recorded[] } {
	const calls: Recorded[] = []
	const record = (method: string) => (args: Record<string, unknown>) => {
		calls.push({ method, args })
		return Promise.resolve({})
	}
	const hydra = {
		context: {
			ingest: record("ingest"),
			query: record("query"),
			list: record("list"),
			delete: record("delete"),
		},
		databases: { layout: () => Promise.resolve(layout) },
	} as unknown as HydraDB
	return { client: new HydraClient("k", "tenant-a", "sub-a", undefined, hydra, setting), calls }
}

test("auto layout: a unified database makes every call send kind unified", async () => {
	const { client, calls } = mockClientWithLayout("unified")
	await client.recall("q")
	await client.ingestText("note")
	await client.ingestConversation([{ user: "a", assistant: "b" }], "s1")
	await client.listMemories()
	await client.deleteMemory("m1")
	assert.deepEqual(
		calls.map((c) => [c.method, c.args.kind]),
		[["query", "unified"], ["ingest", "unified"], ["ingest", "unified"], ["list", "unified"], ["delete", "unified"]],
	)
})

test("auto layout: a split database keeps sending kind memory", async () => {
	const { client, calls } = mockClientWithLayout("split")
	await client.recall("q")
	await client.ingestText("note")
	assert.deepEqual(calls.map((c) => c.args.kind), ["memory", "memory"])
})

test("a pinned layout skips the probe", async () => {
	const { client, calls } = mockClientWithLayout("split", "unified")
	await client.recall("q")
	assert.equal(calls[0]!.args.kind, "unified")
})

test("listMemories reads the source shape a unified list returns", async () => {
	const calls: Recorded[] = []
	const hydra = {
		context: {
			list: (args: Record<string, unknown>) => {
				calls.push({ method: "list", args })
				return Promise.resolve({ sources: [{ id: "doc-1", title: "Ledger notes" }], total: 1 })
			},
		},
		databases: { layout: () => Promise.resolve("unified") },
	} as unknown as HydraDB
	const client = new HydraClient("k", "tenant-a", "sub-a", undefined, hydra)
	const res = await client.listMemories()
	assert.deepEqual(res.user_memories, [{ memory_id: "doc-1", memory_content: "Ledger notes" }])
})

// PRO-1618: `listSources` was the one method left outside `withKind`, so on a
// unified database it sent a hardcoded `knowledge` — an unconditional 400 that
// did not even get the retry the rest of the client has.
test("listSources sends kind unified on a unified database", async () => {
	const { client, calls } = mockClientWithLayout("unified")
	await client.listSources(["source-1"])
	const list = calls.find((c) => c.method === "list")!
	assert.equal(list.args.kind, "unified")
	assert.deepEqual(list.args.ids, ["source-1"])
})

// The refusal has two wordings. The ingest-body one ("this database is
// unified: …") is the one a `/unified database/i` pattern misses entirely.
test("a unified refusal worded as `this database is unified` still retries", async () => {
	const calls: Recorded[] = []
	const hydra = {
		context: {
			list: (args: Record<string, unknown>) => {
				calls.push({ method: "list", args })
				if (args.kind !== "unified") {
					return Promise.reject(
						new HydraWrapperError(
							"Hydra /context/list → 400: this database is unified: send the content as `items`",
							"/context/list",
							{ status: 400, body: { error: { code: "CORPUS_TYPE_UNSUPPORTED" } } },
						),
					)
				}
				return Promise.resolve({ sources: [], total: 0 })
			},
		},
		databases: { layout: () => Promise.reject(new Error("probe failed")) },
	} as unknown as HydraDB
	const client = new HydraClient("k", "tenant-a", "sub-a", undefined, hydra)
	await client.listSources()
	assert.deepEqual(calls.map((c) => c.args.kind), ["knowledge", "unified"])
})

// A retry that fails for an UNRELATED reason must not pin the layout: it never
// proved the database is unified, and pinning stranded the whole process.
test("a failed unified retry does not pin the layout", async () => {
	const kinds: unknown[] = []
	const hydra = {
		context: {
			query: (args: Record<string, unknown>) => {
				kinds.push(args.kind)
				if (args.kind === "unified") {
					return Promise.reject(
						new HydraWrapperError("Hydra /query → 503: upstream unavailable", "/query", {
							status: 503,
						}),
					)
				}
				return Promise.reject(
					new HydraWrapperError(
						'Hydra /query → 400: type "memory" is not valid on a unified database',
						"/query",
						{ status: 400 },
					),
				)
			},
		},
		databases: { layout: () => Promise.reject(new Error("probe failed")) },
	} as unknown as HydraDB
	const client = new HydraClient("k", "tenant-a", "sub-a", undefined, hydra)
	await assert.rejects(() => client.recall("q"), /503/)
	assert.equal(await client.layout(), "split", "the layout must NOT be pinned by a failed retry")
	assert.deepEqual(kinds, ["memory", "unified"])
})

// PRO-1618: on a unified database the list is the whole corpus, so it carries
// documents next to memories and the wording has to say so.
test("layout() reports what the plugin will call a stored item", async () => {
	const { client: unified } = mockClientWithLayout("unified")
	assert.equal(await unified.layout(), "unified")
	const { client: split } = mockClientWithLayout("split")
	assert.equal(await split.layout(), "split")
})

// The unified item gained the `attributes` half of the metadata pair; the split
// item carries the same value as `tenant_metadata`, so a caller sets it once.
test("ingest carries attributes on both layouts", async () => {
	const { client: unified, calls: unifiedCalls } = mockClientWithLayout("unified")
	await unified.ingestText("note", { attributes: { topic: "ui" } })
	assert.deepEqual(unifiedCalls[0]!.args.tenantMetadata, { topic: "ui" })

	const { client: split, calls: splitCalls } = mockClientWithLayout("split")
	await split.ingestConversation([{ user: "a", assistant: "b" }], "s1", {
		attributes: { topic: "ui" },
	})
	assert.deepEqual(splitCalls[0]!.args.tenantMetadata, { topic: "ui" })
})

// CORPUS_TYPE_UNSUPPORTED covers three refusals, and only one of them is ours.
// `unified` sent to a SPLIT database carries the same code, and retrying it as
// unified would turn a clear 400 into a second, more confusing one.
test("a split database refusing `unified` is not retried, despite the same code", async () => {
	const kinds: unknown[] = []
	const hydra = {
		context: {
			query: (args: Record<string, unknown>) => {
				kinds.push(args.kind)
				return Promise.reject(
					new HydraWrapperError(
						'Hydra /query → 400: type "unified" is only valid on a unified database; this database stores knowledge and memory separately',
						"/query",
						{ status: 400, body: { error: { code: "CORPUS_TYPE_UNSUPPORTED" } } },
					),
				)
			},
		},
		databases: { layout: () => Promise.resolve("split") },
	} as unknown as HydraDB
	const client = new HydraClient("k", "tenant-a", "sub-a", undefined, hydra)
	await assert.rejects(() => client.recall("q"), /only valid on a unified database/)
	assert.deepEqual(kinds, ["memory"], "no retry: this is the sibling refusal, not ours")
})

// The same code also covers `all` on an ingest and a `type` outside the
// vocabulary, so keying on the code alone would have retried a typo as unified.
test("a type outside the vocabulary is not a layout answer", async () => {
	const kinds: unknown[] = []
	const hydra = {
		context: {
			query: (args: Record<string, unknown>) => {
				kinds.push(args.kind)
				return Promise.reject(
					new HydraWrapperError(
						`Hydra /query → 400: invalid type "momory": must be 'knowledge', 'memory', 'unified' or 'all'`,
						"/query",
						{ status: 400, body: { detail: { error_code: "CORPUS_TYPE_UNSUPPORTED" } } },
					),
				)
			},
		},
		databases: { layout: () => Promise.reject(new Error("probe failed")) },
	} as unknown as HydraDB
	const client = new HydraClient("k", "tenant-a", "sub-a", undefined, hydra)
	await assert.rejects(() => client.recall("q"), /invalid type/)
	assert.deepEqual(kinds, ["memory"], "no retry: a bad value is not a layout answer")
})

// The code is read from `detail.error_code` as well as `error.code`, and it
// carries a refusal whose wording the regex cannot see.
test("the code alone can trigger the retry when the wording is unfamiliar", async () => {
	const kinds: unknown[] = []
	const hydra = {
		context: {
			query: (args: Record<string, unknown>) => {
				kinds.push(args.kind)
				if (args.kind === "unified") return Promise.resolve({ chunks: [] })
				return Promise.reject(
					new HydraWrapperError("Hydra /query → 400: the corpus refused this request", "/query", {
						status: 400,
						body: { detail: { error_code: "CORPUS_TYPE_UNSUPPORTED" } },
					}),
				)
			},
		},
		databases: { layout: () => Promise.reject(new Error("probe failed")) },
	} as unknown as HydraDB
	const client = new HydraClient("k", "tenant-a", "sub-a", undefined, hydra)
	await client.recall("q")
	assert.deepEqual(kinds, ["memory", "unified"])
})
