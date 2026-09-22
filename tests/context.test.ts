import { test } from "node:test"
import assert from "node:assert/strict"

import { buildRecalledContext, recallIsEmpty, unifiedRecallLines } from "../context.ts"
import type { RecallResponse, UnifiedQueryResponse } from "../types/hydra.ts"

// Ported from the MCP context tests (hydradb-mcp PR #36). Only the two tests
// that match OpenClaw's actual renderer are ported: entity paths / graph
// relations / extra context, and the default low-score relation filter. The
// MCP `maxGroupOccurrences` cap tests are intentionally NOT ported — OpenClaw's
// `buildRecalledContext` does not implement that cap, and this migration does
// not add behaviour.

test("buildRecalledContext includes entity paths, graph relations and extra context", () => {
	const response: RecallResponse = {
		chunks: [
			{
				chunk_uuid: "c1",
				source_id: "s1",
				chunk_content: "Chunk one body",
				source_title: "Doc A",
				extra_context_ids: ["ec1"],
			},
		],
		graph_context: {
			query_paths: [
				{
					relevancy_score: 0.9,
					combined_context: "Alice -> prefers -> tea",
					triplets: [],
				},
			],
			chunk_relations: [
				{
					relevancy_score: 0.8,
					group_id: "g1",
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
			chunk_id_to_group_ids: {
				c1: ["g1"],
			},
		},
		additional_context: {
			ec1: {
				chunk_uuid: "ec1",
				source_id: "s2",
				chunk_content: "Tea helps Alice focus",
				source_title: "Doc B",
			},
		},
	}

	const output = buildRecalledContext(response)

	assert.match(output, /=== ENTITY PATHS ===/)
	assert.match(output, /Alice -> prefers -> tea/)
	assert.match(output, /=== CONTEXT ===/)
	assert.match(output, /Chunk 1/)
	assert.match(output, /Source: Doc A/)
	assert.match(output, /Graph Relations:/)
	assert.match(output, /\(Alice\) —\[likes\]→ \(Tea\) \[morning routine\]/)
	assert.match(output, /Extra Context:/)
	assert.match(output, /Related Context \(Doc B\): Tea helps Alice focus/)
})

test("buildRecalledContext filters low-score relations by default", () => {
	const response: RecallResponse = {
		chunks: [
			{
				chunk_uuid: "c1",
				source_id: "s1",
				chunk_content: "Chunk one body",
			},
		],
		graph_context: {
			query_paths: [],
			chunk_relations: [
				{
					relevancy_score: 0.2,
					group_id: "g1",
					triplets: [
						{
							source: { name: "Alice", type: "person", entity_id: "e1" },
							relation: {
								canonical_predicate: "prefers",
								raw_predicate: "likes",
								context: "context",
								relationship_id: "r1",
								chunk_id: "c1",
							},
							target: { name: "Tea", type: "drink", entity_id: "e2" },
						},
					],
				},
			],
			chunk_id_to_group_ids: {
				c1: ["g1"],
			},
		},
	}

	const output = buildRecalledContext(response)

	assert.doesNotMatch(output, /Graph Relations:/)
	assert.doesNotMatch(output, /Alice/)
})

// PRO-1618: a unified fixture (all four keys) is rendered as `llm_prompt`
// verbatim, never rebuilt from chunks[] / graph[]; the structured summary the
// slash command and CLI print reads the contract's own fields.
test("buildRecalledContext returns llm_prompt verbatim for a unified body", () => {
	const unified: UnifiedQueryResponse = {
		chunks: [
			{
				chunk_id: "ck_1",
				context_id: "chat-1",
				score: 0.87,
				content: "user: dark mode please",
				enrichment: { text: "Prefers dark mode.", kind: "user_preference" },
			},
			{ chunk_id: "ck_2", context_id: "note-2", score: 0.4, content: "Plain note" },
		],
		graph: [
			{ triplets: [], path_summary: "Ada prefers dark mode." },
			{
				triplets: [
					{
						source: { entity_id: "e1", name: "Ada" },
						relation: { predicate: "uses", context: "", relationship_id: "r1", chunk_id: "ck_1" },
						target: { entity_id: "e2", name: "OpenClaw" },
					},
				],
				path_summary: "",
			},
		],
		relations: [
			{
				via: { from: "linear-1", to: "linear-1-c4" },
				chunk: { chunk_id: "ck_r", context_id: "linear-1-c4", score: 0.5, content: "Comment 4 body" },
			},
		],
		llm_prompt: "=== CONTEXT ===\n[1] context_id: chat-1\nuser: dark mode please\n\n=== GRAPH ===\n[P1] Ada prefers dark mode.",
	}

	assert.equal(buildRecalledContext(unified), unified.llm_prompt)
	assert.equal(recallIsEmpty(unified), false)
	assert.equal(recallIsEmpty({ chunks: [], graph: [], relations: [], llm_prompt: "  \n" }), true)

	assert.deepEqual(unifiedRecallLines(unified, { maxChunks: 10, preview: (t) => t }), [
		"1. [chat-1] user: dark mode please (87%)",
		"   Prefers dark mode.",
		"2. [note-2] Plain note (40%)",
		"Graph:",
		"- Ada prefers dark mode.",
		"- Ada -> uses -> OpenClaw",
		"Related:",
		"- [linear-1 -> linear-1-c4] Comment 4 body",
	])
})

// The split emptiness rule is the one the surfaces always had: no chunks.
test("recallIsEmpty keeps the split rule of no chunks", () => {
	assert.equal(recallIsEmpty({ chunks: [] }), true)
	assert.equal(recallIsEmpty({ chunks: [{ chunk_uuid: "c1", source_id: "s1", chunk_content: "x" }] }), false)
})
