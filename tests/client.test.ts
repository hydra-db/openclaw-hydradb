import { test } from "node:test"
import assert from "node:assert/strict"

import { HydraClient } from "../client.ts"
import { HydraDB } from "../hydra/index.ts"
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

test("listSources scopes to knowledge and passes ids", async () => {
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
