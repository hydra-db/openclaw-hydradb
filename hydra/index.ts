/**
 * The hand-owned HydraDB wrapper. This module (with ./client.ts) is the ONLY
 * place that imports `@hydradb/sdk`; everything else in the plugin talks to
 * `HydraDB` here (via the host-behaviour shim in ../client.ts).
 *
 * It is a self-contained PORT of the MCP wrapper (hydradb-mcp PR #36) so the
 * same pattern stays in lockstep across client repos (per CONTRACT.md).
 */

export { HydraDB, ContextResource, DatabasesResource } from "./client.ts"
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
export { HydraWrapperError, translateError } from "./errors.ts"
export { unwrap } from "./envelope.ts"
