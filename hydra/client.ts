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
 */

import { Buffer } from "node:buffer"
import { HydraDBClient } from "@hydradb/sdk"
import type { HydraDB as SDK } from "@hydradb/sdk"

import { unwrap } from "./envelope.ts"
import { translateError } from "./errors.ts"
import { type Layout, RawHttp } from "./raw.ts"

export type { Layout } from "./raw.ts"

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
	return kind as T | undefined
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
	/** Test seam for the hand-rolled v2 calls (see ./raw.ts); production uses global fetch. */
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

abstract class Resource {
	/** Hand-rolled v2 transport for calls the pinned SDK cannot make; see ./raw.ts. */
	protected raw?: RawHttp

	/** @internal */
	attachRaw(raw: RawHttp): void {
		this.raw = raw
	}

	protected requireRaw(what: string): RawHttp {
		if (!this.raw) {
			throw new Error(`${what} needs the v2 transport, which this HydraDB instance was built without`)
		}
		return this.raw
	}

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
	query(params: QueryParams): Promise<SDK.SearchV2RetrievalResult> {
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
	ingest(params: IngestParams): Promise<SDK.IngestionV2SourceUploadResponse> {
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
			request.memories = JSON.stringify([item])
		} else {
			// Knowledge is multipart with the document as a file part — never the
			// `app_sources` JSON field (guards the DX-G-002 class of bug).
			if (params.text != null) {
				request.documents = {
					data: Buffer.from(params.text, "utf-8"),
					filename: params.filename ?? `${params.title ?? "document"}.md`,
					contentType: "text/markdown",
				}
			}
			if (params.title != null) {
				request.documentMetadata = JSON.stringify({ title: params.title })
			}
		}

		return this.call("/context/ingest", () => this.sdk.context.ingest(request))
	}

	/**
	 * The unified ingest shape (PRO-1618): one `items[]` array, each item text or
	 * a conversation, no corpus selector, sent as the JSON body of
	 * `POST /context/ingest`. On a split database the items land in its memory
	 * corpus, so a caller that has not created a unified database sees no change.
	 */
	private ingestUnified(params: IngestParams): Promise<SDK.IngestionV2SourceUploadResponse> {
		const item: Record<string, unknown> = {}
		if (params.text != null) item.text = params.text
		if (params.pairs != null) {
			item.conversation = params.pairs.flatMap((turn) => [
				{ role: "user", content: turn.user, ...(params.userName ? { name: params.userName } : {}) },
				{ role: "assistant", content: turn.assistant },
			])
		}
		if (params.sourceId != null) item.context_id = params.sourceId
		if (params.title != null) item.title = params.title
		item.enrich = params.infer ?? true
		if (item.enrich && params.customInstructions != null) {
			item.custom_instructions = params.customInstructions
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
		const body = {
			...this.scope(params.collection),
			items: [item],
			...(params.upsert != null ? { upsert: params.upsert } : {}),
		}
		return this.call("/context/ingest", async () => {
			// The raw path hands back the wire's snake_case; the SDK path hands
			// back camelCase, and every adapter reads the latter. Normalise here
			// so a unified ingest reports its counts instead of zeros.
			const wire = await this.requireRaw("unified ingest").request<Record<string, unknown>>(
				"POST",
				"/context/ingest",
				body,
			)
			return {
				success: wire.success,
				message: wire.message,
				successCount: wire.success_count ?? wire.successCount,
				failedCount: wire.failed_count ?? wire.failedCount,
				results: wire.results,
			} as SDK.IngestionV2SourceUploadResponse
		})
	}

	/** List memories or knowledge sources (SDK `context.list`). */
	list(params: ListParams = {}): Promise<SDK.ListV2SourceListResponse> {
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
	constructor(sdk: HydraDBClient, database: string, collection?: string) {
		super(sdk, database, collection)
	}

	create(
		params: CreateDatabaseParams,
	): Promise<SDK.TenantsTenantCreateAcceptedResponse> {
		if (params.type != null) {
			// The pinned SDK's create request has no `type`; its serializer would
			// drop it and provision a split database in silence.
			return this.call("/databases", () =>
				this.requireRaw("database create with a layout").request<SDK.TenantsTenantCreateAcceptedResponse>(
					"POST",
					"/databases",
					{
						database: params.database,
						type: params.type,
						...(params.databaseMetadataSchema != null
							? { database_metadata_schema: params.databaseMetadataSchema }
							: {}),
						...(params.embeddingsDimension != null
							? { embeddings_dimension: params.embeddingsDimension }
							: {}),
					},
				),
			)
		}
		return this.call("/databases", () =>
			this.sdk.databases.create({
				database: params.database,
				databaseMetadataSchema: params.databaseMetadataSchema,
				embeddingsDimension: params.embeddingsDimension,
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

	/**
	 * Every database this key can see, with its storage layout (PRO-1618), from
	 * `GET /databases` `details[]`. Memoised for the process: a layout is fixed
	 * at creation, so it cannot go stale.
	 */
	layouts(): Promise<Map<string, Layout>> {
		if (!this.layoutCache) {
			this.layoutCache = this.requireRaw("layout probe")
				.request<{ details?: { database?: string; type?: string }[] }>("GET", "/databases")
				.then((listed) => {
					const map = new Map<string, Layout>()
					for (const row of listed.details ?? []) {
						if (row.database) map.set(row.database, row.type === "unified" ? "unified" : "split")
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
			})
		this.context = new ContextResource(client, config.database, config.collection)
		this.databases = new DatabasesResource(
			client,
			config.database,
			config.collection,
		)
		const raw = new RawHttp({ token: config.token, baseUrl: config.baseUrl, fetch: config.fetch })
		this.context.attachRaw(raw)
		this.databases.attachRaw(raw)
	}
}
