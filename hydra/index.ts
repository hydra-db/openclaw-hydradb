/**
 * The hand-owned HydraDB wrapper. This module (with ./client.ts) is the ONLY
 * place that imports `@hydradb/sdk`; everything else in the plugin talks to
 * `HydraDB` here (via the host-behaviour shim in ../client.ts).
 *
 * It is a self-contained PORT of the MCP wrapper (hydradb-mcp PR #36) so the
 * same pattern stays in lockstep across client repos (per CONTRACT.md).
 */

export {
	HydraDB,
	ContextResource,
	DatabasesResource,
	LAYOUT_TTL_MS,
	UNIFIED_MAX_TEXT_BYTES,
	UNIFIED_MAX_TITLE_BYTES,
	UNIFIED_MAX_INSTRUCTIONS_CHARS,
	unifiedAnswerToWire,
} from "./client.ts"
export type {
	HydraConfig,
	ContextKind,
	ConversationTurn,
	QueryParams,
	IngestParams,
	ListParams,
	InspectParams,
	IngestionStatusParams,
	RelationsParams,
	DeleteParams,
	CreateDatabaseParams,
	Layout,
} from "./client.ts"
export {
	HydraWrapperError,
	isUnifiedLayoutRefusal,
	translateError,
	CORPUS_TYPE_UNSUPPORTED_CODE,
} from "./errors.ts"
export { unwrap } from "./envelope.ts"
// PRO-1618: the unified database wire contract and its shape guards.
export type { IngestResult, QueryResult } from "./client.ts"
export type {
	UnifiedChunk,
	UnifiedConversationTurn,
	UnifiedEnrichmentKind,
	UnifiedForcefulRelation,
	UnifiedGraphPath,
	UnifiedGraphPathOrigin,
	UnifiedIngestItem,
	UnifiedIngestRequest,
	UnifiedIngestResponse,
	UnifiedIngestResultItem,
	UnifiedQueryResponse,
	UnifiedTriplet,
} from "./unified.ts"
export { isUnifiedIngestResponse, isUnifiedQueryResponse } from "./unified.ts"
