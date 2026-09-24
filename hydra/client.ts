/**
 * Thin, hand-owned wrapper around the generated `@hydradb/sdk`.
 *
 * This is the single place the OpenClaw plugin touches the SDK. It is a PORT of
 * the committed MCP wrapper (hydradb-mcp PR #36) — same structure, same
 * envelope-unwrap, same error translation — so the two clients stay in lockstep
 * with CONTRACT.md. It:
 *   - owns the SDK at an EXACT pin (see package.json `"@hydradb/sdk": "2.1.2"`),
 *   - exposes the canonical vocabulary from CONTRACT.md §2 (camelCase in TS),
 *   - injects scope (`database` / `collection`) that the SDK reads from no env,
 *   - unwraps the `HandlerEnvelope` by shape (see ./envelope.ts),
 *   - translates SDK errors into a stable host error (see ./errors.ts).
 *
 * Injected DEFAULTS (alpha, recency bias, mode, upsert, ingest instructions)
 * are deliberately NOT baked in here — per CONTRACT §2 rule 5 those are host
 * behaviour and are supplied by the caller (OpenClaw's `HydraClient`), so this
 * wrapper stays portable.
 *
 * OpenClaw-specific divergence from the MCP wrapper: `IngestParams` carries a
 * `documentMetadata` field, threaded into the memory item as `document_metadata`.
 * OpenClaw sends per-turn capture metadata and the SDK supports it; the MCP
 * wrapper simply never needed it.
 *
 * PRO-1618: on a UNIFIED database `query` and `ingest` speak the contract's own
 * wire shapes (see ./unified.ts) over the raw transport and return them typed
 * by the contract, as they came; list, relations and delete keep their
 * SDK-shaped results and simply send no `type`. A split database never reaches
 * any of that: its SDK request and response stay byte for byte as they were.
 */

import { Buffer } from "node:buffer"
import { HydraDBClient, HydraDBEnvironment, serialization } from "@hydradb/sdk"
import type { HydraDB as SDK } from "@hydradb/sdk"

import { unwrap } from "./envelope.ts"
import { HydraWrapperError, translateError } from "./errors.ts"
import type { Layout } from "./unified.ts"
import {
	isUnifiedQueryResponse,
	type UnifiedConversationTurn,
	type UnifiedIngestItem,
	type UnifiedIngestRequest,
	type UnifiedIngestResponse,
	type UnifiedQueryResponse,
} from "./unified.ts"

export type { Layout } from "./unified.ts"

/** What `query` resolves to: the SDK shape on a split database, the contract's four-key body on a unified one. */
export type QueryResult = SDK.SearchV2RetrievalResult | UnifiedQueryResponse
/** What `ingest` resolves to: the SDK shape on a split database, the contract's 202 on a unified one. */
export type IngestResult = SDK.IngestionV2IngestResponse | UnifiedIngestResponse

/**
 * `unified` (PRO-1618) names the ONE corpus of a database created with
 * `type: "unified"`. On such a database it is the only accepted value (and the
 * server default); on a split database it is refused, exactly as
 * `memory`/`knowledge` are refused on a unified one. `databases.layout()` tells
 * the two apart.
 */
export type ContextKind = "memory" | "knowledge" | "unified"

/**
 * The SDK's enums predate `unified`; the value is a plain string on the wire,
 * so it is passed through with a cast rather than dropped.
 */
function kindToType<T extends string>(kind: ContextKind | undefined): T | undefined {
	// A unified database takes no `type` at all (PRO-1618).
	return kind === "unified" ? undefined : (kind as T | undefined)
}

export interface HydraConfig {
	/** Bearer token (the HydraDB API key). */
	token: string
	/** Database scope (canonical name for the tenant). */
	database: string
	/** Collection scope (canonical name for the sub-tenant). */
	collection?: string
	/** Optional base URL override; defaults to the SDK's environment. */
	baseUrl?: string
	/** Test seam: the fetch the SDK uses; production uses global fetch. */
	fetch?: typeof fetch
}

export interface QueryParams {
	query: string
	kind?: ContextKind
	operator?: "or" | "and" | "phrase"
	maxResults?: number
	mode?: "fast" | "thinking" | "auto"
	graphContext?: boolean
	alpha?: number
	recencyBias?: number
	/**
	 * Unified database only (PRO-1618): follow the relations declared with
	 * `forceful_relations` at ingest, which fills the response's
	 * `forceful_relations[]` and the `## Forceful relations` section of
	 * `llm_prompt`. Server default true. Never sent on a split database, whose
	 * SDK request stays byte for byte as it was.
	 */
	followForcefulRelations?: boolean
	/** Per-call collection override. */
	collection?: string
}

export interface ConversationTurn {
	user: string
	assistant: string
}

export interface IngestParams {
	kind: ContextKind
	/** Free text to ingest (memory note or knowledge document body). */
	text?: string
	/** Conversation turns to ingest as a memory. */
	pairs?: ConversationTurn[]
	title?: string
	sourceId?: string
	userName?: string
	infer?: boolean
	isMarkdown?: boolean
	/** Passed through only when `infer` is truthy (host-owned default text). */
	customInstructions?: string
	upsert?: boolean
	/**
	 * Pre-serialised `document_metadata` JSON string, threaded into the memory
	 * item verbatim. OpenClaw attaches per-capture metadata here; preserved from
	 * the v1 client (which set `document_metadata` inside each memory payload).
	 */
	documentMetadata?: string
	/**
	 * Tenant-visible attributes on the item — the queryable half of an item's
	 * metadata, as opposed to the opaque `documentMetadata` blob. Maps to
	 * `tenant_metadata` on a split memory item and to `IngestItem.attributes`
	 * on a unified one, so a caller sets it once and both layouts store it in
	 * the same place. This mirrors hydradb-claude-code's `memoryToItem`, where
	 * `tenant_metadata → attributes` and `document_metadata → custom_attributes`
	 * are the two halves; the unified path here had only the second, so an item
	 * could not carry attributes at all.
	 */
	tenantMetadata?: Record<string, unknown> | string
	/** Filename to attach when ingesting knowledge text as a document. */
	filename?: string
	collection?: string
}

export interface ListParams {
	kind?: ContextKind
	ids?: string[]
	page?: number
	pageSize?: number
	collection?: string
}

export interface InspectParams {
	id: string
	mode?: string
	expirySeconds?: number
	collection?: string
}

export interface IngestionStatusParams {
	ids: string | string[]
	collection?: string
}

export interface RelationsParams {
	id?: string
	kind?: ContextKind
	limit?: number
	cursor?: number
	collection?: string
}

export interface DeleteParams {
	ids: string[]
	kind: ContextKind
	collection?: string
}

export interface CreateDatabaseParams {
	database: string
	/** Storage layout (PRO-1618). Omitted means `split`, the layout every existing database has. */
	type?: Layout
	databaseMetadataSchema?: SDK.TenantsCustomPropertyDefinition[]
	embeddingsDimension?: number
}

type ScopeFields = { database: string; collection?: string }

/** The options the generated client itself passes to every response parser. */
type SdkParseOptions = NonNullable<
	Parameters<typeof serialization.SearchV2RetrievalResult.parseOrThrow>[1]
>
const SDK_PARSE_OPTS: SdkParseOptions = {
	unrecognizedObjectKeys: "passthrough",
	allowUnrecognizedUnionMembers: true,
	allowUnrecognizedEnumValues: true,
	skipValidation: true,
	breadcrumbsPrefix: ["response"],
}

/** The same leniency, for turning an SDK object back into its wire spelling. */
const SDK_WIRE_OPTS: SdkParseOptions = {
	unrecognizedObjectKeys: "passthrough",
	allowUnrecognizedUnionMembers: true,
	allowUnrecognizedEnumValues: true,
	skipValidation: true,
	breadcrumbsPrefix: ["request"],
}

/** The layout probe runs before the first call: a short budget, no retries. */
const LAYOUT_PROBE_TIMEOUT_S = 5
/** How long a probed layout is trusted; see DatabasesResource.layouts. */
export const LAYOUT_TTL_MS = 5 * 60_000

/** The server's per-item caps on a unified ingest (hydradb-application#1657). */
export const UNIFIED_MAX_TEXT_BYTES = 1 << 20
export const UNIFIED_MAX_TITLE_BYTES = 1024
export const UNIFIED_MAX_INSTRUCTIONS_CHARS = 4000

/**
 * A unified /query answer in its wire spelling (`llm_prompt`,
 * `forceful_relations`, `chunk_id`...). The SDK (2.1.6) reads the body
 * through a union: when it matches its four-key model every key comes back
 * camelCased, and when it does not (a chunk with `temporal`, say) the body
 * comes back as sent. The same query can therefore answer in either spelling,
 * so it is pinned to the wire one here, which is the contract's and what the
 * renderers read. A legacy v2 body (an older server) is left as the SDK
 * parsed it, exactly as the split path returns it.
 */
export function unifiedAnswerToWire(answer: unknown): unknown {
	if (answer == null || typeof answer !== "object" || Array.isArray(answer)) return answer
	const a = answer as Record<string, unknown>
	if (isUnifiedQueryResponse(a)) return a
	const firstChunk = Array.isArray(a.chunks) ? (a.chunks[0] as Record<string, unknown> | undefined) : undefined
	const camelUnified =
		Array.isArray(a.graph) || Array.isArray(a.forcefulRelations) || (firstChunk != null && "contextId" in firstChunk)
	if (!camelUnified) return a
	return serialization.SearchQueryResult.jsonOrThrow(a as unknown as SDK.SearchQueryResult, SDK_WIRE_OPTS)
}

/** `value` cut to at most `maxBytes` of UTF-8, never inside a character. */
export function clipUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf-8") <= maxBytes) return value
	let out = ""
	let used = 0
	for (const ch of value) {
		const size = Buffer.byteLength(ch, "utf-8")
		if (used + size > maxBytes) break
		out += ch
		used += size
	}
	return out
}

/**
 * A conversation as unified turns (exactly {role, content}), keeping the
 * LATEST pairs whose text fits the server's per-item cap. Auto-capture saves a
 * whole session under one id on every turn, so a long session would otherwise
 * be refused on every later turn and stop being saved at all.
 */
export function latestTurnsWithinCap(
	pairs: { user: string; assistant: string }[],
	maxBytes: number = UNIFIED_MAX_TEXT_BYTES,
): UnifiedConversationTurn[] {
	const kept: UnifiedConversationTurn[][] = []
	let used = 0
	for (let i = pairs.length - 1; i >= 0; i--) {
		const pair = pairs[i]
		const size = Buffer.byteLength(pair.user, "utf-8") + Buffer.byteLength(pair.assistant, "utf-8")
		if (used + size > maxBytes) {
			if (kept.length === 0) {
				// Even the newest pair is over the cap: keep its latest text.
				const room = Math.max(0, maxBytes - Buffer.byteLength(pair.user, "utf-8"))
				const assistant = clipUtf8(pair.assistant, room)
				kept.push([
					{ role: "user", content: clipUtf8(pair.user, maxBytes) },
					...(assistant ? [{ role: "assistant" as const, content: assistant }] : []),
				])
			}
			break
		}
		used += size
		kept.push([
			{ role: "user", content: pair.user },
			{ role: "assistant", content: pair.assistant },
		])
	}
	return kept.reverse().flat()
}

/**
 * Metadata reaches the wrapper either as an object or as the pre-serialised
 * JSON string the v1 client used. A unified item takes the object, so a string
 * is parsed; a string that is not JSON is kept under `value` rather than thrown
 * away. Mirrors hydradb-claude-code's `parseMaybeJson`.
 */
function parseMaybeJson(value: Record<string, unknown> | string): unknown {
	if (typeof value !== "string") return value
	try {
		return JSON.parse(value)
	} catch {
		return { value }
	}
}

abstract class Resource {
	protected constructor(
		protected readonly sdk: HydraDBClient,
		private readonly database: string,
		private readonly collection?: string,
	) {}

	protected scope(override?: string): ScopeFields {
		const collection = override ?? this.collection
		return collection != null
			? { database: this.database, collection }
			: { database: this.database }
	}

	protected async call<T>(path: string, fn: () => Promise<unknown>): Promise<T> {
		try {
			return unwrap<T>(await fn())
		} catch (err) {
			throw translateError(path, err)
		}
	}
}

export class ContextResource extends Resource {
	constructor(sdk: HydraDBClient, database: string, collection?: string) {
		super(sdk, database, collection)
	}

	/** The single retrieval entry point (SDK `client.query`). */
	query(params: QueryParams): Promise<QueryResult> {
		if (params.kind === "unified") {
			// A unified database (PRO-1618): the v2 request fields and NO `type`
			// (absent is its default; memory and knowledge are 400 there), sent
			// through the SDK (2.1.6+ knows follow_forceful_relations). The answer
			// is normalised to the four-key wire body; see unifiedAnswerToWire.
			return this.call<unknown>("/query", () =>
				this.sdk.query({
					...this.scope(params.collection),
					query: params.query,
					operator: params.operator,
					maxResults: params.maxResults,
					mode: params.mode,
					graphContext: params.graphContext,
					followForcefulRelations: params.followForcefulRelations,
					alpha: params.alpha,
					recencyBias: params.recencyBias,
				}),
			).then((answer) => unifiedAnswerToWire(answer) as QueryResult)
		}
		return this.call("/query", () =>
			this.sdk.query({
				...this.scope(params.collection),
				query: params.query,
				type: kindToType(params.kind),
				operator: params.operator,
				maxResults: params.maxResults,
				mode: params.mode,
				graphContext: params.graphContext,
				alpha: params.alpha,
				recencyBias: params.recencyBias,
			}),
		)
	}

	/** Ingest a memory or knowledge item (SDK `context.ingest`, multipart). */
	ingest(params: IngestParams): Promise<IngestResult> {
		if (params.kind === "unified") return this.ingestUnified(params)
		const request: SDK.IngestContextRequest = {
			...this.scope(params.collection),
			type: kindToType(params.kind),
		}
		if (params.upsert != null) {
			request.upsert = String(params.upsert)
		}

		if (params.kind === "memory") {
			const infer = params.infer ?? true
			const item: Record<string, unknown> = {}
			if (params.pairs != null) item.user_assistant_pairs = params.pairs
			if (params.text != null) item.text = params.text
			item.infer = infer
			item.is_markdown = params.isMarkdown ?? false
			// Preserve the v1 omission behaviour: custom_instructions is only
			// attached when inference is enabled.
			if (infer && params.customInstructions != null) {
				item.custom_instructions = params.customInstructions
			}
			if (params.sourceId != null) item.source_id = params.sourceId
			if (params.title != null) item.title = params.title
			if (params.userName != null) item.user_name = params.userName
			// OpenClaw divergence: preserve v1 per-item `document_metadata`.
			if (params.documentMetadata != null) {
				item.document_metadata = params.documentMetadata
			}
			// The split half of the same pair the unified path maps to
			// `attributes`, so an item carries its attributes either way.
			if (params.tenantMetadata != null) {
				item.tenant_metadata = params.tenantMetadata
			}
			request.memories = JSON.stringify([item])
		} else {
			// Knowledge is multipart with the document as a file part — never the
			// `app_sources` JSON field (guards the DX-G-002 class of bug).
			if (params.text != null) {
				request.documents = [
					{
						data: Buffer.from(params.text, "utf-8"),
						filename: params.filename ?? `${params.title ?? "document"}.md`,
						contentType: "text/markdown",
					},
				]
			}
			if (params.title != null) {
				request.documentMetadata = JSON.stringify({ title: params.title })
			}
		}

		return this.call("/context/ingest", () => this.sdk.context.ingest(request))
	}

	/**
	 * A unified ingest (PRO-1618) through the SDK: the `context` list (never
	 * `items`) with one item that is either `text` or a `conversation` of
	 * exactly {role, content} turns, the speaker as the item's `user_name`
	 * (hydradb-application#1653), and the request-level `enrich` / `upsert` /
	 * `instructions` defaults. No corpus selector. The SDK sends `context` as
	 * its multipart form field. The server's per-item caps are held here: a
	 * conversation keeps its LATEST turns within the text cap, the title and
	 * instructions are clipped, and a single text over the cap is refused
	 * before sending. The 202 comes back in its wire spelling.
	 */
	private ingestUnified(params: IngestParams): Promise<UnifiedIngestResponse> {
		const item: UnifiedIngestItem = {}
		if (params.sourceId != null) item.context_id = params.sourceId
		if (params.title != null) item.title = clipUtf8(params.title, UNIFIED_MAX_TITLE_BYTES)
		if (params.text != null) {
			const bytes = Buffer.byteLength(params.text, "utf-8")
			if (bytes > UNIFIED_MAX_TEXT_BYTES) {
				return Promise.reject(
					new HydraWrapperError(
						`Hydra /context/ingest → ERR: the text is ${bytes} bytes; a unified database takes at most ${UNIFIED_MAX_TEXT_BYTES} per item`,
						"/context/ingest",
					),
				)
			}
			item.text = params.text
		}
		if (params.pairs != null) item.conversation = latestTurnsWithinCap(params.pairs)
		if (params.userName != null && params.userName.trim() !== "") item.user_name = params.userName
		if (params.tenantMetadata != null) {
			item.attributes = parseMaybeJson(params.tenantMetadata) as Record<string, unknown>
		}
		if (params.documentMetadata != null) {
			// The split path carries this as a pre-serialised JSON string; the
			// unified item takes the object itself.
			try {
				item.custom_attributes = JSON.parse(params.documentMetadata)
			} catch {
				item.custom_attributes = { document_metadata: params.documentMetadata }
			}
		}
		const enrich = params.infer ?? true
		// Same omission rule as the split item: instructions only steer
		// enrichment, so they travel only when enrichment is on.
		const instructions =
			enrich && params.customInstructions != null
				? params.customInstructions.slice(0, UNIFIED_MAX_INSTRUCTIONS_CHARS)
				: undefined
		return this.call<unknown>("/context/ingest", () =>
			this.sdk.context.ingest({
				...this.scope(params.collection),
				context: JSON.stringify([item]),
				enrich: String(enrich),
				...(params.upsert != null ? { upsert: String(params.upsert) } : {}),
				...(instructions != null ? { instructions } : {}),
			}),
		).then(
			(answer) =>
				serialization.IngestionV2IngestResponse.jsonOrThrow(
					answer as SDK.IngestionV2IngestResponse,
					SDK_WIRE_OPTS,
				) as unknown as UnifiedIngestResponse,
		)
	}

	/** List memories or knowledge sources (SDK `context.list`). */
	list(params: ListParams = {}): Promise<SDK.ListV2ListResponse> {
		// No `type` on a unified database (PRO-1618): absent is its default.
		return this.call("/context/list", () =>
			this.sdk.context.list({
				...this.scope(params.collection),
				type: kindToType(params.kind),
				ids: params.ids,
				page: params.page,
				pageSize: params.pageSize,
			}),
		)
	}

	/** Fetch a source's content (SDK `context.inspect`; was "fetch content"). */
	inspect(params: InspectParams): Promise<SDK.FetchV2SourceFetchResponse> {
		return this.call("/context/inspect", () =>
			this.sdk.context.inspect({
				...this.scope(params.collection),
				id: params.id,
				mode: params.mode,
				expirySeconds: params.expirySeconds,
			}),
		)
	}

	/** Per-source indexing progress (SDK `context.status`). */
	ingestionStatus(
		params: IngestionStatusParams,
	): Promise<SDK.IngestionV2BatchProcessingStatus> {
		return this.call("/context/status", () =>
			this.sdk.context.status({
				...this.scope(params.collection),
				ids: params.ids,
			}),
		)
	}

	/** Knowledge-graph relations (SDK `context.relations`). */
	relations(
		params: RelationsParams = {},
	): Promise<SDK.GraphGraphRelationsResponse> {
		// No `type` on a unified database (PRO-1618): absent is its default.
		return this.call("/context/relations", () =>
			this.sdk.context.relations({
				...this.scope(params.collection),
				id: params.id,
				type: kindToType(params.kind),
				limit: params.limit,
				cursor: params.cursor,
			}),
		)
	}

	/** Delete memories or knowledge sources (SDK `context.delete`). */
	delete(params: DeleteParams): Promise<SDK.SourcesMemoryDeleteResponse> {
		// No `type` on a unified database (PRO-1618): absent is its default.
		return this.call("/context", () =>
			this.sdk.context.delete({
				...this.scope(params.collection),
				ids: params.ids,
				type: kindToType(params.kind),
			}),
		)
	}
}

export class DatabasesResource extends Resource {
	constructor(
		sdk: HydraDBClient,
		database: string,
		collection?: string,
		private readonly transport?: { token: string; baseUrl?: string; fetch?: typeof fetch },
	) {
		super(sdk, database, collection)
	}

	/**
	 * `POST /databases` with `type: "unified"`, built by hand. The ONE call
	 * the SDK cannot make: 2.1.6's storage-layout enum declares only "split",
	 * and its request serializer refuses "unified" before sending ("Expected
	 * enum"). Same headers and error shape as the SDK path. Drop this once
	 * the SDK's enum carries "unified".
	 */
	private async createUnified(params: CreateDatabaseParams): Promise<SDK.TenantsTenantCreateAcceptedResponse> {
		const path = "/databases"
		const base = (this.transport?.baseUrl ?? HydraDBEnvironment.Default).replace(/\/+$/, "")
		const doFetch = this.transport?.fetch ?? fetch
		let res: Response
		try {
			res = await doFetch(`${base}${path}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.transport?.token ?? ""}`,
					"API-Version": "2",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					database: params.database,
					type: "unified",
					...(params.databaseMetadataSchema != null
						? { database_metadata_schema: params.databaseMetadataSchema }
						: {}),
					...(params.embeddingsDimension != null ? { embeddings_dimension: params.embeddingsDimension } : {}),
				}),
			})
		} catch (err) {
			throw translateError(path, err)
		}
		const text = await res.text()
		let body: unknown = text
		try {
			body = text ? JSON.parse(text) : {}
		} catch {
			// not JSON: keep the text
		}
		if (!res.ok) {
			const detail = typeof body === "string" ? body : JSON.stringify(body)
			throw new HydraWrapperError(`Hydra ${path} → ${res.status}: ${detail}`, path, { status: res.status, body })
		}
		return unwrap<SDK.TenantsTenantCreateAcceptedResponse>(body)
	}

	create(
		params: CreateDatabaseParams,
	): Promise<SDK.TenantsTenantCreateAcceptedResponse> {
		if (params.type === "unified") return this.createUnified(params)
		return this.call("/databases", () =>
			this.sdk.databases.create({
				database: params.database,
				databaseMetadataSchema: params.databaseMetadataSchema,
				embeddingsDimension: params.embeddingsDimension,
				// "unified" was routed to createUnified above; the SDK's enum is "split" only.
				type: params.type === "split" ? "split" : undefined,
			}),
		)
	}

	delete(database: string): Promise<SDK.TenantsTenantDeleteResponse> {
		return this.call("/databases", () => this.sdk.databases.delete({ database }))
	}

	list(): Promise<SDK.TenantsTenantIdsResponse> {
		return this.call("/databases", () => this.sdk.databases.list())
	}

	private layoutCache?: Promise<Map<string, Layout>>
	private layoutCachedAt = 0

	/**
	 * Every database this key can see, with its storage layout (PRO-1618), from
	 * `GET /databases` `details[]`. The probe runs before the first call, so it
	 * gets a short budget and no retries. The answer is kept for
	 * LAYOUT_TTL_MS: the plugin runs for the life of the gateway, and a
	 * database deleted and re-created under the other layout must not keep its
	 * old one. A failed probe is not kept.
	 */
	layouts(): Promise<Map<string, Layout>> {
		if (this.layoutCache && Date.now() - this.layoutCachedAt > LAYOUT_TTL_MS) this.layoutCache = undefined
		if (!this.layoutCache) {
			this.layoutCachedAt = Date.now()
			this.layoutCache = this.call<SDK.TenantsTenantIdsResponse>("/databases", () =>
				this.sdk.databases.list({ timeoutInSeconds: LAYOUT_PROBE_TIMEOUT_S, maxRetries: 0 }),
			)
				.then((listed) => {
					const map = new Map<string, Layout>()
					for (const row of listed.details ?? []) {
						// The SDK's detail type declares only "split"; "unified" passes through untyped.
						if (row.database) map.set(row.database, (row.type as string | undefined) === "unified" ? "unified" : "split")
					}
					return map
				})
				.catch((err) => {
					this.layoutCache = undefined
					throw err
				})
		}
		return this.layoutCache
	}

	/**
	 * The layout of one database. Unknown, or a failed probe, reads as `split`,
	 * which every database created before PRO-1618 is: the worst case is the old
	 * default, never a wrong unified call.
	 */
	async layout(database: string): Promise<Layout> {
		try {
			return (await this.layouts()).get(database) ?? "split"
		} catch {
			return "split"
		}
	}

	collections(database: string): Promise<SDK.TenantsSubTenantIdsResponse> {
		return this.call("/databases/collections", () =>
			this.sdk.databases.collections({ database }),
		)
	}

	stats(database: string): Promise<SDK.TenantsTenantStatsResponse> {
		return this.call("/databases/stats", () =>
			this.sdk.databases.stats({ database }),
		)
	}

	/** Infra provisioning readiness — renamed away from `status` (SDK `databases.status`). */
	readiness(database: string): Promise<SDK.TenantsInfraStatusResponseV2> {
		return this.call("/databases/status", () =>
			this.sdk.databases.status({ database }),
		)
	}
}

/**
 * The canonical HydraDB client surface. Construct once per process from config;
 * pass an existing `HydraDBClient` as the second argument to inject a mocked
 * SDK transport (used by the conformance runner and unit tests).
 */
export class HydraDB {
	readonly context: ContextResource
	readonly databases: DatabasesResource

	constructor(config: HydraConfig, sdk?: HydraDBClient) {
		const client =
			sdk ??
			new HydraDBClient({
				token: config.token,
				...(config.baseUrl != null ? { baseUrl: config.baseUrl } : {}),
				...(config.fetch != null ? { fetch: config.fetch } : {}),
			})
		this.context = new ContextResource(client, config.database, config.collection)
		this.databases = new DatabasesResource(client, config.database, config.collection, {
			token: config.token,
			baseUrl: config.baseUrl,
			fetch: config.fetch,
		})
	}
}
