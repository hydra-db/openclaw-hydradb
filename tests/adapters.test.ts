import { test } from "node:test"
import assert from "node:assert/strict"

import type { HydraDB as SDK } from "@hydradb/sdk"

import {
	toAddMemoryResponse,
	toDeleteMemoryResponse,
	toFetchContentResponse,
	toListMemoriesResponse,
	toListSourcesResponse,
	toRecallResponse,
} from "../adapters.ts"
import { buildRecalledContext } from "../context.ts"

// Regression guard for the camelCase→snake_case seam. The SDK deserializes v2
// responses to camelCase; OpenClaw's tools/slash/CLI/hooks and context.ts read
// v1 snake_case field names. Every adapter is fed a camelCased SDK-shaped
// response and asserted to emit exactly the snake_case fields those readers use.
// A field that stops being mapped (the delete-no-op / empty-recall class of bug)
// fails here instead of silently degrading a surface.

test("toRecallResponse maps camelCase chunks + graph, and buildRecalledContext renders it", () => {
	const sdkResult = {
		chunks: [
			{
				chunkUuid: "c1",
				id: "s1",
				chunkContent: "Chunk body text",
				sourceTitle: "Doc A",
				relevancyScore: 0.9,
				extraContextIds: ["ec1"],
			},
		],
		graphContext: {
			queryPaths: [
				{ relevancyScore: 0.9, combinedContext: "Alice -> prefers -> tea", triplets: [] },
			],
			chunkRelations: [
				{
					relevancyScore: 0.8,
					groupId: "g1",
					// Triplet innards stay RAW snake_case in the SDK (untyped) — they
					// must pass through untouched for context.ts to read them.
					triplets: [
						{
							source: { name: "Alice", type: "person", entity_id: "e1" },
							relation: {
								canonical_predicate: "prefers",
								raw_predicate: "likes",
								context: "morning routine",
								relationship_id: "r1",
								chunk_id: "c1",
							},
							target: { name: "Tea", type: "drink", entity_id: "e2" },
						},
					],
				},
			],
			chunkIdToGroupIds: { c1: ["g1"] },
		},
		additionalContext: {
			ec1: {
				chunkUuid: "ec1",
				id: "s2",
				chunkContent: "Tea helps Alice focus",
				sourceTitle: "Doc B",
			},
		},
	} as unknown as SDK.SearchV2RetrievalResult

	const res = toRecallResponse(sdkResult)

	// snake_case fields the surfaces read directly
	assert.equal(res.chunks[0]!.chunk_content, "Chunk body text")
	assert.equal(res.chunks[0]!.relevancy_score, 0.9)
	assert.equal(res.chunks[0]!.source_title, "Doc A")
	assert.equal(res.chunks[0]!.chunk_uuid, "c1")
	assert.deepEqual(res.chunks[0]!.extra_context_ids, ["ec1"])
	assert.equal(res.graph_context?.query_paths[0]!.combined_context, "Alice -> prefers -> tea")
	assert.equal(res.graph_context?.chunk_relations[0]!.group_id, "g1")
	assert.equal(res.graph_context?.chunk_relations[0]!.relevancy_score, 0.8)
	assert.deepEqual(res.graph_context?.chunk_id_to_group_ids, { c1: ["g1"] })
	assert.equal(res.additional_context?.ec1!.chunk_content, "Tea helps Alice focus")

	// End-to-end: the recall renderer produces the injected context string.
	const rendered = buildRecalledContext(res)
	assert.match(rendered, /Chunk body text/)
	assert.match(rendered, /Alice -> prefers -> tea/)
	assert.match(rendered, /\(Alice\) —\[likes\]→ \(Tea\) \[morning routine\]/)
	assert.match(rendered, /Related Context \(Doc B\): Tea helps Alice focus/)
})

test("toDeleteMemoryResponse reads camelCase userMemoryDeleted / deletedCount (no-op guard)", () => {
	assert.deepEqual(
		toDeleteMemoryResponse({ success: true, userMemoryDeleted: 1 } as SDK.SourcesMemoryDeleteResponse),
		{ success: true, user_memory_deleted: true },
	)
	assert.deepEqual(
		toDeleteMemoryResponse({ success: true, deletedCount: 2 } as SDK.SourcesMemoryDeleteResponse),
		{ success: true, user_memory_deleted: true },
	)
	// A zero-match delete must read as NOT deleted, not silently succeed.
	assert.deepEqual(
		toDeleteMemoryResponse({
			success: true,
			userMemoryDeleted: 0,
			deletedCount: 0,
		} as SDK.SourcesMemoryDeleteResponse),
		{ success: true, user_memory_deleted: false },
	)
})

test("toFetchContentResponse maps contentBase64 and normalises empty error to null", () => {
	const res = toFetchContentResponse({
		success: true,
		id: "s9",
		content: "body",
		contentBase64: "YWJj",
		error: "",
	} as SDK.FetchV2SourceFetchResponse)
	assert.equal(res.success, true)
	assert.equal(res.source_id, "s9")
	assert.equal(res.content, "body")
	assert.equal(res.content_base64, "YWJj")
	assert.equal(res.error, null)

	// A real error string is preserved (surfaces branch on `res.error`).
	const failed = toFetchContentResponse({
		success: false,
		error: "not found",
	} as SDK.FetchV2SourceFetchResponse)
	assert.equal(failed.error, "not found")
})

test("toAddMemoryResponse maps successCount / failedCount", () => {
	assert.deepEqual(
		toAddMemoryResponse({
			success: true,
			message: "ok",
			successCount: 3,
			failedCount: 1,
		} as SDK.IngestionV2SourceUploadResponse),
		{ success: true, message: "ok", results: [], success_count: 3, failed_count: 1 },
	)
})

test("toListMemoriesResponse maps records defensively to user_memories", () => {
	// The live API returns memories at top-level `user_memories`.
	const direct = toListMemoriesResponse({
		user_memories: [{ memory_id: "m1", memory_content: "hi" }],
	} as unknown as SDK.ListV2SourceListResponse)
	assert.deepEqual(direct.user_memories, [{ memory_id: "m1", memory_content: "hi" }])

	// Fallback field names (id / title) when v2 records differ.
	const fallback = toListMemoriesResponse({
		user_memories: [{ id: "s1", title: "A title" }],
	} as unknown as SDK.ListV2SourceListResponse)
	assert.deepEqual(fallback.user_memories, [{ memory_id: "s1", memory_content: "A title" }])
})

test("toListSourcesResponse maps knowledge rows and total", () => {
	// The live API returns knowledge sources at top-level `sources`/`total`.
	const res = toListSourcesResponse({
		sources: [{ id: "s1", title: "T", type: "pdf" }],
		total: 1,
	} as unknown as SDK.ListV2SourceListResponse)
	assert.equal(res.total, 1)
	assert.equal(res.sources[0]!.id, "s1")
	assert.equal(res.sources[0]!.title, "T")
	assert.equal(res.sources[0]!.type, "pdf")
})
