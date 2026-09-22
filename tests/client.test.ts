import { test } from "node:test"
import assert from "node:assert/strict"

import { HydraClient } from "../client.ts"
import type { HydraPluginConfig } from "../config.ts"
import { buildRecalledContext, envelopeForInjection } from "../context.ts"
import { createRecallHook } from "../hooks/recall.ts"
import { HydraDB, HydraWrapperError, isUnifiedQueryResponse } from "../hydra/index.ts"
import type { UnifiedQueryResponse } from "../hydra/index.ts"
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

// PRO-1618: the unified query fixture, all four keys, exactly as the contract
// spells them. Through `recall` the body is surfaced as it came, and the text
// injected for the agent is `llm_prompt` verbatim: nothing is re-rendered from
// chunks[] or graph[].
const UNIFIED_QUERY_FIXTURE: UnifiedQueryResponse = {
	chunks: [
		{
			chunk_id: "ck_9f2",
			context_id: "chat-2026-07-29#w2",
			score: 0.87,
			content: "user: Keep answers short please\nassistant: Got it.",
			enrichment: { text: "User prefers short, bullet-point answers.", kind: "user_preference" },
		},
	],
	graph: [
		{
			triplets: [
				{
					source: { entity_id: "ent_a3f", name: "John" },
					relation: {
						predicate: "subscribed to",
						context: "John subscribed to the Pro plan.",
						temporal_details: "since June",
						relationship_id: "rel_1",
						chunk_id: "ck_9f2",
					},
					target: { entity_id: "ent_9c1", name: "Pro plan" },
				},
			],
			path_summary: "John is on the Pro plan since June 2026.",
		},
	],
	relations: [
		{
			via: { from: "linear-PRO-1169", to: "linear-PRO-1169-comment-4" },
			chunk: { chunk_id: "ck_r1", context_id: "linear-PRO-1169-comment-4", score: 0.5, content: "Comment 4 body" },
		},
	],
	llm_prompt:
		"=== CONTEXT ===\nCite anything you use from this context with its bracketed label, e.g. [1].\n\n" +
		"[1] context_id: chat-2026-07-29#w2\nuser: Keep answers short please\nassistant: Got it.\n\n" +
		"=== RELATED CONTEXT ===\n[R1] context_id: linear-PRO-1169-comment-4 (via linear-PRO-1169)\nComment 4 body\n\n" +
		"=== GRAPH ===\n[P1] John is on the Pro plan since June 2026.\n    John -> subscribed to -> Pro plan [1]",
}

const RECALL_CFG = {
	maxRecallResults: 10,
	recallMode: "thinking",
	graphContext: true,
	ignoreTerm: "hydra-ignore",
} as HydraPluginConfig

function unifiedRecallClient(body: unknown): { client: HydraClient; calls: Recorded[] } {
	const calls: Recorded[] = []
	const hydra = {
		context: {
			query: (args: Record<string, unknown>) => {
				calls.push({ method: "query", args })
				return Promise.resolve(body)
			},
		},
		databases: { layout: () => Promise.resolve("unified") },
	} as unknown as HydraDB
	return { client: new HydraClient("k", "tenant-a", "sub-a", undefined, hydra), calls }
}

test("unified recall surfaces the four-key body and the injected text is llm_prompt verbatim", async () => {
	const { client, calls } = unifiedRecallClient(UNIFIED_QUERY_FIXTURE)
	const res = await client.recall("what does the user prefer")

	assert.equal(calls[0]!.args.kind, "unified")
	assert.equal(calls[0]!.args.followForcefulRelations, true, "follow_forceful_relations is sent on a unified query")
	assert.ok(isUnifiedQueryResponse(res))
	assert.deepEqual(res, UNIFIED_QUERY_FIXTURE)

	// The structured fields are the contract's own names.
	assert.equal(res.chunks[0]!.context_id, "chat-2026-07-29#w2")
	assert.equal(res.chunks[0]!.score, 0.87)
	assert.equal(res.chunks[0]!.content, "user: Keep answers short please\nassistant: Got it.")
	assert.equal(res.chunks[0]!.enrichment?.text, "User prefers short, bullet-point answers.")
	assert.equal(res.graph[0]!.path_summary, "John is on the Pro plan since June 2026.")
	assert.equal(res.relations[0]!.via.to, "linear-PRO-1169-comment-4")

	// The rendered context IS llm_prompt, byte for byte.
	assert.equal(buildRecalledContext(res), UNIFIED_QUERY_FIXTURE.llm_prompt)

	// And the recall hook wraps exactly that string in the injection envelope.
	const hook = createRecallHook(client, RECALL_CFG)
	const injected = await hook({ prompt: "what does the user prefer" })
	assert.ok(injected && typeof injected.prependContext === "string")
	assert.equal(injected.prependContext, envelopeForInjection(UNIFIED_QUERY_FIXTURE.llm_prompt))
	assert.ok(injected.prependContext.includes(UNIFIED_QUERY_FIXTURE.llm_prompt))
})

// The server sends a blank llm_prompt when chunks, graph and relations are all
// empty; that is "nothing matched", so nothing is injected.
test("a blank unified llm_prompt injects nothing", async () => {
	const { client } = unifiedRecallClient({ chunks: [], graph: [], relations: [], llm_prompt: "" })
	const hook = createRecallHook(client, RECALL_CFG)
	assert.equal(await hook({ prompt: "anything at all" }), undefined)
})

// The split fixture is unchanged: the legacy shape still goes through the split
// adapter and the legacy renderer, byte for byte.
test("split recall still adapts the SDK shape and renders the legacy context", async () => {
	const { client, calls } = mockClient({
		query: { chunks: [{ chunkUuid: "c1", id: "s1", chunkContent: "Chunk body", sourceTitle: "Doc A", relevancyScore: 0.9 }] },
	})
	const res = await client.recall("q")
	assert.equal(calls[0]!.args.kind, "memory")
	assert.ok(!isUnifiedQueryResponse(res))
	assert.equal(res.chunks[0]!.chunk_content, "Chunk body")
	assert.equal(res.chunks[0]!.source_title, "Doc A")
	assert.equal(buildRecalledContext(res), "=== CONTEXT ===\nChunk 1\nSource: Doc A\nChunk body")
})

// The unified 202 is parsed from the wire: `results[].source_id` is the
// item's context_id (the row keeps the old spelling, as the contract says).
test("unified ingest parses the 202: results[].source_id is the context id", async () => {
	const wire = {
		success: true,
		message: "queued",
		results: [{ source_id: "hook_sess1", title: null, status: "queued", infer: true, error: null, error_code: null }],
		success_count: 1,
		failed_count: 0,
	}
	const hydra = {
		context: { ingest: () => Promise.resolve(wire) },
		databases: { layout: () => Promise.resolve("unified") },
	} as unknown as HydraDB
	const client = new HydraClient("k", "tenant-a", "sub-a", undefined, hydra)
	const res = await client.ingestConversation([{ user: "hi there", assistant: "hello!" }], "hook_sess1")
	assert.deepEqual(res, {
		success: true,
		message: "queued",
		results: [{ source_id: "hook_sess1", title: null, status: "queued", infer: true, error: null, error_code: null }],
		success_count: 1,
		failed_count: 0,
	})
})

// The `all`-on-ingest advice is layout-aware and now says "This database is
// unified, so send 'unified'…" inside a refusal that is NOT ours. Excluding on
// `invalid type` BEFORE reading the code is what keeps that sentence from being
// read as a layout answer, and stops a SPLIT database being pinned to unified.
test("the layout-aware `all` advice is not mistaken for a layout answer", async () => {
	const kinds: unknown[] = []
	const hydra = {
		context: {
			ingest: (args: Record<string, unknown>) => {
				kinds.push(args.kind)
				return Promise.reject(
					new HydraWrapperError(
						"Hydra /context/ingest → 400: invalid type 'all': it selects both corpora for reads " +
							"and deletes, but an ingest must name the one it writes to. This database is " +
							"unified, so send 'unified' or omit `type` entirely.",
						"/context/ingest",
						{ status: 400, body: { error: { code: "CORPUS_TYPE_UNSUPPORTED" } } },
					),
				)
			},
		},
		databases: { layout: () => Promise.resolve("split") },
	} as unknown as HydraDB
	const client = new HydraClient("k", "tenant-a", "sub-a", undefined, hydra)
	await assert.rejects(() => client.ingestText("note"), /invalid type 'all'/)
	assert.deepEqual(kinds, ["memory"], "no retry, and the split layout is not pinned to unified")
})
