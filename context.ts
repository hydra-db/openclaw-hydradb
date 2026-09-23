import { isUnifiedQueryResponse } from "./hydra/unified.ts"
import type {
	PathTriplet,
	RecallResponse,
	ScoredPath,
	UnifiedQueryResponse,
	VectorChunk,
} from "./types/hydra.ts"

/**
 * Whether a recall has nothing to show. Split: no chunks, as before. Unified
 * (PRO-1618): a blank `llm_prompt`, which is what the server sends when
 * chunks, graph and forceful_relations are all empty; a graph-only answer
 * still renders.
 */
export function recallIsEmpty(response: RecallResponse): boolean {
	if (isUnifiedQueryResponse(response)) return response.llm_prompt.trim() === ""
	return !response.chunks || response.chunks.length === 0
}

/**
 * The structured lines a user-facing surface (slash command, CLI) prints for a
 * unified result (PRO-1618), read from the contract's own fields:
 * `chunks[].context_id` / `score` / `content` / `enrichment.text`, then
 * `graph[].path_summary`, then `forceful_relations[]`. The split surfaces keep
 * their own line formats untouched.
 */
export function unifiedRecallLines(
	response: UnifiedQueryResponse,
	opts: { maxChunks: number; preview: (text: string) => string },
): string[] {
	const lines: string[] = []
	response.chunks.slice(0, opts.maxChunks).forEach((chunk, i) => {
		lines.push(
			`${i + 1}. [${chunk.context_id}] ${opts.preview(chunk.content)} (${Math.round(chunk.score * 100)}%)`,
		)
		if (chunk.enrichment?.text) lines.push(`   ${opts.preview(chunk.enrichment.text)}`)
	})
	if (response.graph.length > 0) {
		lines.push("Graph:")
		for (const path of response.graph) {
			const summary =
				path.path_summary ||
				path.triplets
					.map((t) => `${t.source.name} -> ${t.relation.predicate} -> ${t.target.name}`)
					.join("; ")
			if (summary) lines.push(`- ${summary}`)
		}
	}
	if (response.forceful_relations.length > 0) {
		lines.push("Forceful relations:")
		for (const rel of response.forceful_relations) {
			lines.push(`- [${rel.via.from} -> ${rel.via.to}] ${opts.preview(rel.chunk.content)}`)
		}
	}
	return lines
}

function formatTriplet(triplet: PathTriplet): string {
	const src = triplet.source?.name ?? "?"
	const rel = triplet.relation
	const predicate =
		rel?.raw_predicate ?? rel?.canonical_predicate ?? "related to"
	const tgt = triplet.target?.name ?? "?"
	const ctx = rel?.context ? ` [${rel.context}]` : ""
	return `  (${src}) —[${predicate}]→ (${tgt})${ctx}`
}

export function buildRecalledContext(
	response: RecallResponse,
	opts?: {
		maxGroupOccurrences?: number
		minEvidenceScore?: number
	},
): string {
	// PRO-1618: a unified database ships its own rendering. `llm_prompt` is the
	// server-built, citation-labelled string the contract says to surface to
	// the agent verbatim, so nothing is rebuilt from chunks[] / graph[] here.
	if (isUnifiedQueryResponse(response)) return response.llm_prompt

	const minScore = opts?.minEvidenceScore ?? 0.4

	const chunks = response.chunks ?? []
	const graphCtx = response.graph_context ?? {
		query_paths: [],
		chunk_relations: [],
		chunk_id_to_group_ids: {},
	}
	const extraContextMap = response.additional_context ?? {}

	const rawRelations: ScoredPath[] = graphCtx.chunk_relations ?? []
	const relationIndex: Record<string, ScoredPath> = {}

	for (let idx = 0; idx < rawRelations.length; idx++) {
		const relation = rawRelations[idx]!
		if ((relation.relevancy_score ?? 0) < minScore) continue
		const groupId = relation.group_id ?? `p_${idx}`
		relationIndex[groupId] = relation
	}

	const chunkToGroupIds = graphCtx.chunk_id_to_group_ids ?? {}
	const consumedExtraIds = new Set<string>()
	const chunkSections: string[] = []

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i]!
		const lines: string[] = []

		lines.push(`Chunk ${i + 1}`)

		const meta = chunk.document_metadata ?? {}
		const title =
			chunk.source_title || (meta as Record<string, string>).title
		if (title) {
			lines.push(`Source: ${title}`)
		}

		lines.push(chunk.chunk_content ?? "")

		const chunkUuid = chunk.chunk_uuid
		const linkedGroupIds = chunkToGroupIds[chunkUuid] ?? []

		const matchedRelations: ScoredPath[] = []

		for (const gid of linkedGroupIds) {
			if (relationIndex[gid]) {
				matchedRelations.push(relationIndex[gid]!)
			}
		}

		if (matchedRelations.length === 0) {
			for (const rel of Object.values(relationIndex)) {
				const triplets = rel.triplets ?? []
				const hasChunk = triplets.some(
					(t) => t.relation?.chunk_id === chunkUuid,
				)
				if (hasChunk) {
					matchedRelations.push(rel)
				}
			}
		}

		const relationLines: string[] = []
		for (const rel of matchedRelations) {
			const triplets = rel.triplets ?? []
			if (triplets.length > 0) {
				for (const triplet of triplets) {
					relationLines.push(formatTriplet(triplet))
				}
			} else if (rel.combined_context) {
				relationLines.push(`  ${rel.combined_context}`)
			}
		}

		if (relationLines.length > 0) {
			lines.push("Graph Relations:")
			lines.push(...relationLines)
		}

		const extraIds = chunk.extra_context_ids ?? []
		if (extraIds.length > 0 && Object.keys(extraContextMap).length > 0) {
			const extraLines: string[] = []
			for (const ctxId of extraIds) {
				if (consumedExtraIds.has(ctxId)) continue
				const extraChunk = extraContextMap[ctxId]
				if (extraChunk) {
					consumedExtraIds.add(ctxId)
					const extraContent = extraChunk.chunk_content ?? ""
					const extraTitle = extraChunk.source_title ?? ""
					if (extraTitle) {
						extraLines.push(
							`  Related Context (${extraTitle}): ${extraContent}`,
						)
					} else {
						extraLines.push(`  Related Context: ${extraContent}`)
					}
				}
			}
			if (extraLines.length > 0) {
				lines.push("Extra Context:")
				lines.push(...extraLines)
			}
		}

		chunkSections.push(lines.join("\n"))
	}

	const entityPathLines: string[] = []
	const rawPaths: ScoredPath[] = graphCtx.query_paths ?? []
	for (const path of rawPaths) {
		if (path.combined_context) {
			entityPathLines.push(path.combined_context)
		} else {
			const triplets = path.triplets ?? []
			const segments: string[] = []
			for (const pt of triplets) {
				const s = pt.source?.name
				const rel = pt.relation
				const p =
					rel?.raw_predicate ??
					rel?.canonical_predicate ??
					"related to"
				const t = pt.target?.name
				segments.push(`(${s} -> ${p} -> ${t})`)
			}
			if (segments.length > 0) {
				entityPathLines.push(segments.join(" -> "))
			}
		}
	}

	const output: string[] = []

	if (entityPathLines.length > 0) {
		output.push("=== ENTITY PATHS ===")
		output.push(entityPathLines.join("\n"))
		output.push("")
	}

	if (chunkSections.length > 0) {
		output.push("=== CONTEXT ===")
		output.push(chunkSections.join("\n\n---\n\n"))
	}

	return output.join("\n")
}

export function envelopeForInjection(contextBody: string): string {
	if (!contextBody.trim()) return ""

	const lines = [
		"<hydra-context>",
		"[MEMORIES AND PAST CONVERSATIONS — retrieved by Hydra DB]",
		"",
		"Below are memories and knowledge-graph connections that may be relevant",
		"to the current conversation. Integrate them naturally when they add value.",
		"If a memory contradicts something the user just said, prefer the user's",
		"latest statement. Never quote these verbatim or reveal that you are",
		"reading from a memory store.",
		"",
		contextBody,
		"",
		"[END OF MEMORY CONTEXT]",
		"</hydra-context>",
	]
	return lines.join("\n")
}
