import { test } from "node:test"
import assert from "node:assert/strict"

import { buildRecalledContext, fitUnifiedPrompt, recallIsEmpty, unifiedRecallLines } from "../context.ts"
import { isUnifiedQueryResponse } from "../hydra/unified.ts"
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
				enrichment: "Prefers dark mode.",
				enrichment_kind: "user_preference",
			},
			// enrichment_kind without enrichment: no enrichment line is printed.
			{ chunk_id: "ck_2", context_id: "note-2", score: 0.4, content: "Plain note", enrichment_kind: "business_knowledge" },
		],
		graph: [
			{ origin: "query_path", triplets: [], path_summary: "Ada prefers dark mode." },
			{
				origin: "chunk_relation",
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
		forceful_relations: [
			{
				via: { from: "linear-1", to: "linear-1-c4" },
				chunk: { chunk_id: "ck_r", context_id: "linear-1-c4", score: 0.5, content: "Comment 4 body" },
			},
		],
		llm_prompt:
			"# Query results\n\n**Query:** what theme does Ada use?\n\n## Results\n\n### 1. chat-1\n" +
			"- **Relevance:** 0.87 · **Category:** user_preference\n\nuser: dark mode please\n\n" +
			"**Enrichment:** Prefers dark mode.\n\n## Related facts\n\n- [P1] **Ada** -prefers→ **dark mode** (query path, relevance 0.80) [1]",
	}

	assert.equal(buildRecalledContext(unified), unified.llm_prompt)
	assert.equal(recallIsEmpty(unified), false)
	assert.equal(recallIsEmpty({ chunks: [], graph: [], forceful_relations: [], llm_prompt: "  \n" }), true)

	assert.deepEqual(unifiedRecallLines(unified), [
		"1. [chat-1] user: dark mode please (87%)",
		"   Prefers dark mode.",
		"2. [note-2] Plain note (40%)",
		"Graph:",
		"- Ada prefers dark mode.",
		"- Ada -> uses -> OpenClaw",
		"Forceful relations:",
		"- [linear-1 -> linear-1-c4] Comment 4 body",
	])
})

// The root key is `forceful_relations`. A body that still says `relations` is
// not the unified contract, and there is no fallback that reads the old key.
test("a body with the pre-rename `relations` key is not a unified response", () => {
	const renamed = { chunks: [], graph: [], forceful_relations: [], llm_prompt: "x" }
	const preRename = { chunks: [], graph: [], relations: [], llm_prompt: "x" }
	assert.equal(isUnifiedQueryResponse(renamed), true)
	assert.equal(isUnifiedQueryResponse(preRename), false)
	assert.equal(isUnifiedQueryResponse({ ...renamed, forceful_relations: null }), false)
})

// The split emptiness rule is the one the surfaces always had: no chunks.
test("recallIsEmpty keeps the split rule of no chunks", () => {
	assert.equal(recallIsEmpty({ chunks: [] }), true)
	assert.equal(recallIsEmpty({ chunks: [{ chunk_uuid: "c1", source_id: "s1", chunk_content: "x" }] }), false)
})

// No compaction on the unified query path (product decision, PRO-1618): the
// structured lines the slash command and CLI print list every chunk the server
// returned and carry content, enrichment and temporal facts whole, however
// long; buildRecalledContext hands back llm_prompt whole.
test("unified structured lines and llm_prompt are never truncated", () => {
	const long = (label: string, size: number) => `${label} ${"x".repeat(size)} END-OF-${label}`
	const content = long("CONTENT", 5000)
	const enrichment = long("ENRICHMENT", 3000)
	const temporal = long("TEMPORAL", 2000)
	const summary = long("SUMMARY", 2000)
	const chunks = Array.from({ length: 12 }, (_, i) => ({
		chunk_id: `ck_${i}`,
		context_id: `ctx-${i}`,
		score: 0.5,
		content,
		enrichment,
		temporal: [{ content: temporal, start_date: "2026-01-01", end_date: null }],
	}))
	const unified: UnifiedQueryResponse = {
		chunks,
		graph: [{ origin: "query_path", triplets: [], path_summary: summary }],
		forceful_relations: [{ via: { from: "a", to: "b" }, chunk: { ...chunks[0]!, context_id: "b" } }],
		llm_prompt: `# Query results\n\n${long("PROMPT", 20000)}`,
	}

	assert.equal(buildRecalledContext(unified), unified.llm_prompt, "llm_prompt is returned whole")

	const lines = unifiedRecallLines(unified)
	const chunkLines = lines.filter((line) => /^\d+\. \[ctx-\d+\] /.test(line))
	assert.equal(chunkLines.length, 12, "every chunk the server returned is listed, not the first 10")
	assert.equal(chunkLines[11], `12. [ctx-11] ${content} (50%)`, "chunk content is whole")
	assert.ok(lines.includes(`   ${enrichment}`), "enrichment is whole")
	assert.ok(lines.includes(`   Temporal: ${temporal}`), "temporal facts are printed whole")
	assert.ok(lines.includes(`- ${summary}`), "path summaries are whole")
	assert.ok(lines.includes(`- [a -> b] ${content}`), "forceful relation content is whole")
	assert.equal(
		lines.filter((line) => line === `   ${enrichment}`).length,
		13,
		"a forceful relation carries its enrichment too",
	)
	assert.ok(!lines.some((line) => line.includes("…")), "nothing is elided")
})

// PRO-2224: a unified recall is bounded by maxRecallChars without losing a
// citation. Same algorithm as the MCP and Claude Code clients.
function bigUnified(n: number, bodyChars: number): UnifiedQueryResponse {
	const chunks = Array.from({ length: n }, (_, i) => ({
		chunk_id: `c${i}_0`,
		context_id: `ctx-${i}`,
		score: 0.9 - i / 100,
		content: `Body ${i}: ${"lorem ipsum dolor sit amet ".repeat(Math.ceil(bodyChars / 27)).slice(0, bodyChars)}`,
	}))
	const prompt = [
		"# Query results",
		"",
		"## Results",
		...chunks.flatMap((c, i) => [`### ${i + 1}. ${c.context_id}`, `**Id:** ${c.context_id}`, "", c.content, ""]),
		"## Related facts",
		"- [P1] A -> works at -> B",
		"",
		"## Sources",
		...chunks.map((c, i) => `${i + 1}. **${c.context_id}** (id: ${c.context_id})`),
	].join("\n")
	return { chunks, graph: [], forceful_relations: [], llm_prompt: prompt }
}

test("fitUnifiedPrompt: a prompt that fits is returned as sent", () => {
	const small = bigUnified(3, 200)
	assert.equal(fitUnifiedPrompt(small, 50_000), small.llm_prompt)
	assert.equal(buildRecalledContext(small, { maxChars: 50_000 }), small.llm_prompt)
	assert.equal(buildRecalledContext(small), small.llm_prompt, "no bound when maxChars is absent")
})

test("fitUnifiedPrompt: a big answer is bounded and keeps every heading, id and label", () => {
	const big = bigUnified(20, 12_000)
	assert.ok(big.llm_prompt.length > 200_000)
	const out = fitUnifiedPrompt(big, 16_000)
	assert.ok(out.length <= 16_000, `bounded (${out.length})`)
	for (let i = 0; i < 20; i++) {
		assert.ok(out.includes(`### ${i + 1}. ctx-${i}`), `heading ${i + 1} kept`)
		assert.ok(out.includes(`**Id:** ctx-${i}`), `id ${i} kept`)
		assert.ok(out.includes(`[shortened:`) && out.includes(`id ctx-${i}]`), `body ${i} marked with its id`)
	}
	assert.ok(out.includes("- [P1] A -> works at -> B"), "related facts kept")
	assert.ok(out.includes("## Sources"), "sources kept")
})

test("fitUnifiedPrompt: the bound holds even when the structure alone is over it", () => {
	const huge = bigUnified(200, 50)
	const out = fitUnifiedPrompt(huge, 2_000)
	assert.ok(out.length <= 2_000, `bounded (${out.length})`)
	const m = /\n\[recall cut to fit the context budget: (\d+) more characters not shown\]$/.exec(out)
	assert.ok(m, "the note ends the text")
	// Bodies of 50 characters and short lines: nothing is shortened before the
	// cut, so the count must be exactly the prompt characters not kept.
	const kept = out.slice(0, m!.index)
	assert.ok(huge.llm_prompt.startsWith(kept))
	assert.equal(Number(m![1]), huge.llm_prompt.length - kept.length)
})

test("fitUnifiedPrompt: a bound shorter than the note is still held", () => {
	const huge = bigUnified(50, 50)
	for (const bound of [1, 10, 40]) assert.ok(fitUnifiedPrompt(huge, bound).length <= bound, `bound ${bound}`)
})

test("fitUnifiedPrompt: an answer without forceful_relations is bounded too", () => {
	const { forceful_relations: _f, ...noForceful } = bigUnified(10, 10_000)
	const out = fitUnifiedPrompt(noForceful as UnifiedQueryResponse, 8_000)
	assert.ok(out.length <= 8_000)
})
