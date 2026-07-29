/**
 * Adapters from the SDK's (camelCase) response payloads back into the legacy
 * snake_case shapes this plugin already renders.
 *
 * These live in the host layer — NOT the portable wrapper (hydra/) — because
 * they exist only to keep `context.ts` (the byte-identical recall renderer),
 * the tools, the slash commands and the CLI unchanged across the v1 → SDK
 * migration. The wrapper returns SDK-native `.data`; `client.ts` adapts it here.
 *
 * Mirrors the MCP adapter layer (hydradb-mcp PR #36); extended with delete/fetch
 * adapters because OpenClaw's surfaces consume those shapes directly.
 */

import type { HydraDB as SDK } from "@hydradb/sdk"

import type {
	AddMemoryResponse,
	DeleteMemoryResponse,
	FetchContentResponse,
	ListMemoriesResponse,
	ListSourcesResponse,
	RecallResponse,
	ScoredPath,
	VectorChunk,
} from "./types/hydra.ts"

function toScoredPath(path: SDK.SearchScoredPathResponse): ScoredPath {
	return {
		// Triplet innards are already raw snake_case (untyped in the SDK schema).
		triplets: (path.triplets ?? []) as unknown as ScoredPath["triplets"],
		relevancy_score: path.relevancyScore ?? 0,
		combined_context: path.combinedContext ?? null,
		group_id: path.groupId ?? null,
	}
}

function toVectorChunk(chunk: SDK.SearchV2Chunk): VectorChunk {
	return {
		chunk_uuid: chunk.chunkUuid ?? "",
		source_id: chunk.id ?? "",
		chunk_content: chunk.chunkContent ?? "",
		source_title: chunk.sourceTitle,
		source_type: chunk.sourceType,
		source_upload_time: chunk.sourceUploadTime,
		source_last_updated_time: chunk.sourceLastUpdatedTime,
		relevancy_score: chunk.relevancyScore ?? null,
		document_metadata: chunk.additionalMetadata ?? null,
		tenant_metadata: chunk.metadata ?? null,
		extra_context_ids: chunk.extraContextIds ?? null,
		layout: chunk.layout ?? null,
	}
}

/** SDK retrieval result → the legacy `RecallResponse` fed to `buildRecalledContext`. */
export function toRecallResponse(data: SDK.SearchV2RetrievalResult): RecallResponse {
	const graph = data.graphContext
	const additional: Record<string, VectorChunk> = {}
	for (const [id, chunk] of Object.entries(data.additionalContext ?? {})) {
		additional[id] = toVectorChunk(chunk)
	}

	return {
		chunks: (data.chunks ?? []).map(toVectorChunk),
		graph_context: graph
			? {
					query_paths: (graph.queryPaths ?? []).map(toScoredPath),
					chunk_relations: (graph.chunkRelations ?? []).map(toScoredPath),
					chunk_id_to_group_ids: graph.chunkIdToGroupIds ?? {},
				}
			: undefined,
		additional_context: additional,
	}
}

/** SDK ingest result → the legacy `AddMemoryResponse` (success/failed counts). */
export function toAddMemoryResponse(
	data: SDK.IngestionV2SourceUploadResponse,
): AddMemoryResponse {
	return {
		success: data.success ?? false,
		message: data.message ?? "",
		results: [],
		success_count: data.successCount ?? 0,
		failed_count: data.failedCount ?? 0,
	}
}

function str(record: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key]
		if (typeof value === "string") return value
	}
	return undefined
}

function asRecords(value: unknown): Record<string, unknown>[] | undefined {
	return Array.isArray(value) ? (value as Record<string, unknown>[]) : undefined
}

/** SDK list result → the legacy `ListMemoriesResponse`. Field names vary across v2 records, so read defensively. */
export function toListMemoriesResponse(
	data: SDK.ListV2SourceListResponse,
): ListMemoriesResponse {
	// Memories surface at top-level `user_memories` — not under an `.inner`
	// wrapper, and not under `sources` (that is the knowledge shape).
	const d = data as unknown as Record<string, unknown>
	const records =
		asRecords(d.user_memories) ??
		asRecords((d.inner as Record<string, unknown> | undefined)?.user_memories) ??
		[]
	return {
		success: true,
		user_memories: records.map((record) => ({
			memory_id: str(record, "memory_id", "id", "source_id") ?? "",
			memory_content:
				str(record, "memory_content", "content", "text", "memory", "title") ?? "",
		})),
	}
}

/** SDK list result → the legacy `ListSourcesResponse` (knowledge rows + total). */
export function toListSourcesResponse(
	data: SDK.ListV2SourceListResponse,
): ListSourcesResponse {
	// Knowledge sources surface at top-level `sources`, not under `.inner`.
	const d = data as unknown as Record<string, unknown>
	const records =
		asRecords(d.sources) ??
		asRecords((d.inner as Record<string, unknown> | undefined)?.sources) ??
		[]
	const sources = records.map((record) => ({
		id: str(record, "id", "source_id") ?? "",
		tenant_id: str(record, "tenant_id", "database") ?? "",
		sub_tenant_id: str(record, "sub_tenant_id", "collection") ?? "",
		title: str(record, "title"),
		type: str(record, "type", "source_type"),
		description: str(record, "description"),
		timestamp: str(record, "timestamp"),
		url: str(record, "url"),
	}))
	const total =
		d.total ?? (d.inner as Record<string, unknown> | undefined)?.total
	return {
		success: true,
		sources,
		total: typeof total === "number" ? total : sources.length,
	}
}

/** SDK delete result → the legacy `DeleteMemoryResponse` (a boolean flag). */
export function toDeleteMemoryResponse(
	data: SDK.SourcesMemoryDeleteResponse,
): DeleteMemoryResponse {
	const deleted = (data.userMemoryDeleted ?? 0) > 0 || (data.deletedCount ?? 0) > 0
	return {
		success: data.success ?? deleted,
		user_memory_deleted: deleted,
	}
}

/** SDK inspect result → the legacy `FetchContentResponse`. */
export function toFetchContentResponse(
	data: SDK.FetchV2SourceFetchResponse,
): FetchContentResponse {
	return {
		success: data.success ?? false,
		source_id: data.id ?? "",
		content: data.content ?? null,
		content_base64: data.contentBase64 ?? null,
		presigned_url: data.presignedUrl ?? null,
		content_type: data.contentType ?? null,
		size_bytes: data.sizeBytes ?? null,
		message: data.message,
		// The SDK uses "" for no-error; normalise to null so `res.error` truthiness
		// checks in the surfaces behave as they did against the v1 client.
		error: data.error ? data.error : null,
	}
}
