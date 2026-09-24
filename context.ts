import { isUnifiedQueryResponse } from "./hydra/unified.ts"
import type {
	PathTriplet,
	RecallResponse,
	ScoredPath,
	UnifiedChunk,
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
 * `chunks[].context_id` / `score` / `content` / `enrichment` / `temporal`, then
 * `graph[].path_summary`, then `forceful_relations[]`. Nothing is compacted:
 * every chunk the server returned is listed, and content, enrichment and
 * temporal facts are printed whole. The split surfaces keep their own line
 * formats untouched.
 */
export function unifiedRecallLines(response: UnifiedQueryResponse): string[] {
	const lines: string[] = []
	const detailLines = (chunk: UnifiedChunk): void => {
		if (chunk.enrichment) lines.push(`   ${chunk.enrichment}`)
		for (const fact of chunk.temporal ?? []) {
			if (fact.content) lines.push(`   Temporal: ${fact.content}`)
		}
	}
	response.chunks.forEach((chunk, i) => {
		lines.push(`${i + 1}. [${chunk.context_id}] ${chunk.content} (${Math.round(chunk.score * 100)}%)`)
		detailLines(chunk)
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
	const forceful = response.forceful_relations ?? []
	if (forceful.length > 0) {
		lines.push("Forceful relations:")
		for (const rel of forceful) {
			lines.push(`- [${rel.via.from} -> ${rel.via.to}] ${rel.chunk.content}`)
			detailLines(rel.chunk)
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
		/** Unified only: bound on the prompt, see fitUnifiedPrompt. 0 or absent = none. */
		maxChars?: number
	},
): string {
	// PRO-1618: a unified database ships its own rendering. `llm_prompt` is the
	// server-built, citation-labelled string the contract says to surface to
	// the agent, so nothing is rebuilt from chunks[] / graph[] here. It goes
	// out as sent when it fits `maxChars`; otherwise fitUnifiedPrompt shortens
	// long result bodies only (PRO-2224).
	if (isUnifiedQueryResponse(response)) {
		return opts?.maxChars ? fitUnifiedPrompt(response, opts.maxChars) : response.llm_prompt
	}

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

function cutAtWord(text: string, max: number): string | undefined {
	if (text.length <= max) return undefined
	const head = text.slice(0, max)
	const space = head.lastIndexOf(" ")
	return (space > max * 0.6 ? head.slice(0, space) : head).trimEnd()
}

/**
 * A unified recall's `llm_prompt` fitted into `maxChars` without losing a
 * citation (PRO-2224; the same algorithm as the MCP and Claude Code clients).
 * One answer can run to hundreds of thousands of characters, and it is
 * injected on every turn.
 *
 * The server writes each result's content and enrichment into the prompt
 * verbatim, and that text can itself be Markdown, so the prompt's lines are
 * not parsed for structure. The answer's own chunks say which text is result
 * body: every copy of it is found in the prompt and shortened in place,
 * sharing the room left by everything else, each cut marked with the item's
 * id. Headings, ids, labels and the related-facts section are not touched.
 * If the prompt is still over, long non-structural lines are shortened. Only
 * when the structure alone exceeds the bound is the tail cut at a line with a
 * note, so the bound always holds; that last resort can drop later results'
 * headings and labels. A prompt that fits is returned as sent.
 */
export function fitUnifiedPrompt(response: UnifiedQueryResponse, maxChars: number): string {
	const prompt = typeof response.llm_prompt === "string" ? response.llm_prompt : ""
	if (prompt.length <= maxChars) return prompt
	const chunks = [
		...(Array.isArray(response.chunks) ? response.chunks : []),
		...(response.forceful_relations ?? []).map((r) => r?.chunk).filter(Boolean),
	]
	const bodies: { id: string; text: string }[] = []
	for (const chunk of chunks) {
		for (const raw of [chunk.content, chunk.enrichment]) {
			const text = typeof raw === "string" ? raw.trim() : ""
			if (text) bodies.push({ id: chunk.context_id || "", text })
		}
	}
	// Every occurrence of every body, longest first; a span overlapping one
	// already claimed is left to it (a result that is also a forceful relation
	// appears twice).
	const located: { id: string; text: string; at: number }[] = []
	for (const body of [...bodies].sort((x, y) => y.text.length - x.text.length)) {
		for (let at = prompt.indexOf(body.text); at >= 0; at = prompt.indexOf(body.text, at + body.text.length)) {
			if (!located.some((l) => at < l.at + l.text.length && l.at < at + body.text.length)) {
				located.push({ ...body, at })
			}
		}
	}

	const noteAllowance = 90
	const fixed = prompt.length - located.reduce((n, l) => n + l.text.length, 0)
	let cap = Number.POSITIVE_INFINITY
	if (located.length) {
		let room = Math.max(0, maxChars - fixed - noteAllowance * located.length)
		const sorted = located.map((l) => l.text.length).sort((x, y) => x - y)
		let fill = room / sorted.length
		for (let i = 0; i < sorted.length && sorted[i]! <= fill; i += 1) {
			room -= sorted[i]!
			fill = sorted.length - i - 1 > 0 ? room / (sorted.length - i - 1) : fill
		}
		cap = Math.max(120, Math.floor(fill))
	}

	let text = ""
	let from = 0
	for (const l of [...located].sort((x, y) => x.at - y.at)) {
		const cut = cutAtWord(l.text, cap)
		text += prompt.slice(from, l.at)
		from = l.at + l.text.length
		text +=
			cut === undefined
				? l.text
				: `${cut} … [shortened: ${cut.length} of ${l.text.length} characters${l.id ? `, id ${l.id}` : ""}]`
	}
	text += prompt.slice(from)

	// Still over: shorten every long line that is not the prompt's own
	// structure, longest first, so headings, ids and [n]/[Rn]/[Pn] labels
	// survive. Only if that is not enough does the prefix cut apply.
	if (text.length > maxChars) {
		const structural = /^(#{1,6} |- \*\*|- \[|\d+\. |---\s*$|\*\*Id:)/
		const lines = text.split("\n")
		const candidates = lines
			.map((line, index) => ({ index, length: line.length }))
			.filter((c) => c.length > 160 && !structural.test(lines[c.index]!))
			.sort((x, y) => y.length - x.length)
		for (const c of candidates) {
			if (lines.join("\n").length <= maxChars) break
			lines[c.index] = `${cutAtWord(lines[c.index]!, 120) ?? lines[c.index]} …`
		}
		text = lines.join("\n")
	}

	// Last resort, only when the answer's own structure (headings, ids,
	// sources, facts) is over the bound: the bound holds and the tail is cut,
	// so later results can lose their headings and labels here. The note says
	// how much was cut. A bound shorter than the note is a plain prefix.
	if (text.length > maxChars) {
		const note = `\n[recall cut to fit the context budget: ${text.length - maxChars} more characters not shown]`
		if (maxChars <= note.length) return text.slice(0, maxChars)
		const head = text.slice(0, maxChars - note.length)
		const lastLine = head.lastIndexOf("\n")
		text = (lastLine > head.length * 0.8 ? head.slice(0, lastLine) : head) + note
	}
	return text
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
