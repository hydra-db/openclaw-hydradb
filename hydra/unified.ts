/**
 * The wire shapes a UNIFIED database speaks (PRO-1618), exactly as the shared
 * HydraDB client contract spells them. Field names are the contract's, so a
 * reader can hold this file next to the contract and see the same words.
 *
 * A database is either `split` (the legacy knowledge + memory corpora, `type`
 * on every call) or `unified`. Everything here applies ONLY to a unified
 * database; a split one keeps the SDK request and response byte for byte, and
 * nothing in this module is consulted for it.
 *
 * Two things live here:
 *   - the request and response types for `POST /query` and `POST /context/ingest`
 *     on a unified database
 *   - the shape guards a client uses to tell the unified body from the legacy
 *     one. The contract requires detection BY SHAPE (`graph` is an array and
 *     `llm_prompt` is a string) rather than by a request flag, because stored
 *     logs and split databases keep producing the old shape.
 */

/** One chunk of a unified query result. Carries nothing about its source. */
export interface UnifiedChunk {
	/** Was chunk_uuid. */
	chunk_id: string
	/** The source id (was `id`). */
	context_id: string
	/** Was relevancy_score; always present. */
	score: number
	/** The chunk's own text; enrichment is NOT concatenated any more. */
	content: string
	/** Absent when there is neither text nor kind; `text` may be "" when only `kind` is present. */
	enrichment?: { text: string; kind?: string }
	/** Present only when the query engaged temporal reasoning; dates may be null. */
	temporal?: { content: string; start_date: string | null; end_date: string | null }[]
}

export interface UnifiedTriplet {
	source: { entity_id: string; name: string }
	relation: {
		predicate: string
		context: string
		temporal_details?: string
		relationship_id: string
		chunk_id: string
	}
	target: { entity_id: string; name: string }
}

/** One graph path: query paths first, then chunk expansions; deduplicated. */
export interface UnifiedGraphPath {
	triplets: UnifiedTriplet[]
	path_summary: string
}

/**
 * A chunk pulled in because the caller declared `forceful_relations` at ingest.
 * `via.to` is the returned chunk's own context_id; `via.from` is the context
 * whose declared relation pulled it in (may be "").
 */
export interface UnifiedRelation {
	via: { from: string; to: string }
	chunk: UnifiedChunk
}

/**
 * `data` of `POST /query` on a unified database: EXACTLY these four keys. No
 * chunk_content, graph_context, sources, additional_context, temporal_facts,
 * forceful_relations bucket or sub_tenant_id.
 */
export interface UnifiedQueryResponse {
	chunks: UnifiedChunk[]
	/** [] when graph_context=false. */
	graph: UnifiedGraphPath[]
	/** [] when none, or when follow_forceful_relations=false. */
	relations: UnifiedRelation[]
	/**
	 * A server-built string ready to inject into a model call, with citation
	 * labels [1], [R1], [P1]. Clients surface it to the agent verbatim instead
	 * of building their own string. "" when there is nothing to render.
	 */
	llm_prompt: string
}

/** One turn of a unified conversation item; roles are user | assistant | system. */
export interface UnifiedConversationTurn {
	role: "user" | "assistant" | "system"
	content: string
	name?: string
}

/**
 * One item of a unified ingest. Exactly ONE of `text` or `conversation`.
 * Sent under the canonical list key `context` (never `items`/`contexts`).
 */
export interface UnifiedIngestItem {
	/** Optional; server-generated when omitted. Was source_id. */
	context_id?: string
	title?: string
	text?: string
	conversation?: UnifiedConversationTurn[]
	/** Per item; default = request enrich, else true. */
	enrich?: boolean
	/** Per item; default = request upsert, else true. */
	upsert?: boolean
	/** Per item; default = request instructions. Canonical name (never custom_instructions). */
	instructions?: string
	/** Caller's event date, YYYY-MM-DD only. Was observation_date. */
	happened_at?: string
	/** Declared, filterable. Was metadata. */
	attributes?: Record<string, unknown>
	/** Free-form. Was additional_metadata. */
	custom_attributes?: Record<string, unknown>
	/** A label the caller sets; nothing infers it. */
	context_category?: "auto" | "user_preference" | "business_knowledge" | "decision_trace"
	/** Caller-declared relations to other context_ids. Canonical name (never relations). */
	forceful_relations?: { ids: string[]; properties?: Record<string, unknown> }
	acl?: string[]
}

/** The JSON body of `POST /context/ingest` on a unified database. */
export interface UnifiedIngestRequest {
	database: string
	collection?: string
	/** Canonical list name. Aliases are accepted by the server; this client sends only `context`. */
	context: UnifiedIngestItem[]
	/** Request-level default for items (default true). */
	enrich?: boolean
	/** Request-level default for items (default true). */
	upsert?: boolean
	/** Request-level default for items. */
	instructions?: string
}

/**
 * One row of the 202's `results[]`. The row still says `source_id` and
 * `infer` (not context_id / enrich): treat `source_id` as the context_id.
 */
export interface UnifiedIngestResultItem {
	source_id: string
	title: string | null
	status: "queued" | "failed" | string
	infer: boolean
	error: string | null
	error_code: string | null
}

/** `data` of the 202 from `POST /context/ingest` on a unified database. */
export interface UnifiedIngestResponse {
	success: boolean
	message: string
	results: UnifiedIngestResultItem[]
	success_count: number
	failed_count: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value)
}

/**
 * Whether a query `data` is the unified four-key body. Contract client rule 4:
 * detect by the presence of `llm_prompt` (a string) and `graph` (an array),
 * never by a request flag, because the legacy shape (`graph_context`,
 * `chunk_content`) keeps arriving from split databases and stored logs.
 */
export function isUnifiedQueryResponse(value: unknown): value is UnifiedQueryResponse {
	return isRecord(value) && Array.isArray(value.graph) && typeof value.llm_prompt === "string"
}

/**
 * Whether an ingest `data` is the unified 202 as it came off the wire. The
 * wire is snake_case (`success_count`); the SDK's own deserialiser, which the
 * split path returns through, is camelCase (`successCount`), so the spelling
 * is the discriminator.
 */
export function isUnifiedIngestResponse(value: unknown): value is UnifiedIngestResponse {
	return isRecord(value) && typeof value.success_count === "number"
}
