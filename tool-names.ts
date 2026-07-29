// Single source of truth for OpenClaw's user-facing names across all THREE
// surfaces (agent tool / slash / CLI).
//
// PRO-1298: adopt the canonical HydraDB vocabulary (CONTRACT.md §3) everywhere,
// while keeping every legacy name working as a DEPRECATED ALIAS that emits one
// warning. These names are load-bearing — agent tool names are referenced by
// the model, slash names live in muscle memory, the CLI verbs are documented —
// so removing one outright is breaking. Aliases stay registered (deprecated)
// until a later major.

// ── Agent tool names ──

export const TOOL_NAMES = {
	// Canonical (CONTRACT §3).
	QUERY: "hydradb_query",
	INGEST: "hydradb_ingest",
	LIST: "hydradb_list",
	INSPECT: "hydradb_inspect",
	DELETE: "hydradb_delete",

	// Deprecated aliases — kept working for backward compatibility.
	SEARCH: "hydra_search",
	STORE: "hydra_store",
	LIST_MEMORIES: "hydra_list_memories",
	GET_CONTENT: "hydra_get_content",
	DELETE_MEMORY: "hydra_delete_memory",
} as const

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES]

export const CANONICAL_TOOL_NAMES = [
	TOOL_NAMES.QUERY,
	TOOL_NAMES.INGEST,
	TOOL_NAMES.LIST,
	TOOL_NAMES.INSPECT,
	TOOL_NAMES.DELETE,
] as const

export const DEPRECATED_TOOL_NAMES = [
	TOOL_NAMES.SEARCH,
	TOOL_NAMES.STORE,
	TOOL_NAMES.LIST_MEMORIES,
	TOOL_NAMES.GET_CONTENT,
	TOOL_NAMES.DELETE_MEMORY,
] as const

/** Each deprecated tool alias mapped to the canonical tool that replaces it. */
export const ALIAS_REPLACEMENTS: Record<string, string> = {
	[TOOL_NAMES.SEARCH]: TOOL_NAMES.QUERY,
	[TOOL_NAMES.STORE]: TOOL_NAMES.INGEST,
	[TOOL_NAMES.LIST_MEMORIES]: TOOL_NAMES.LIST,
	[TOOL_NAMES.GET_CONTENT]: TOOL_NAMES.INSPECT,
	[TOOL_NAMES.DELETE_MEMORY]: TOOL_NAMES.DELETE,
}

// ── Slash command names (leading slash matches conformance vectors) ──

export const SLASH_NAMES = {
	QUERY: "/hydradb-query",
	INGEST: "/hydradb-ingest",
	LIST: "/hydradb-list",
	INSPECT: "/hydradb-inspect",
	DELETE: "/hydradb-delete",
} as const

export const CANONICAL_SLASH_NAMES = [
	SLASH_NAMES.QUERY,
	SLASH_NAMES.INGEST,
	SLASH_NAMES.LIST,
	SLASH_NAMES.INSPECT,
	SLASH_NAMES.DELETE,
] as const

/** Each deprecated slash alias mapped to the canonical slash command it replaces. */
export const SLASH_ALIAS_REPLACEMENTS: Record<string, string> = {
	"/hydra-recall": SLASH_NAMES.QUERY,
	"/hydra-remember": SLASH_NAMES.INGEST,
	"/hydra-list": SLASH_NAMES.LIST,
	"/hydra-get": SLASH_NAMES.INSPECT,
	"/hydra-delete": SLASH_NAMES.DELETE,
}

// ── Deprecation warning ──
//
// A deprecated name emits exactly ONE stderr warning per process naming its
// canonical replacement (CONTRACT §3). Routed through console.error — not the
// plugin `log` — so it surfaces regardless of the `debug` flag, matching the MCP
// wrapper's behaviour. Hooks never call these (auto-capture/auto-recall use the
// canonical client path), so this cannot make hook failures loud.

const warned = new Set<string>()

export function warnDeprecated(
	kind: "tool" | "slash command" | "CLI command",
	name: string,
	replacement: string,
): void {
	if (warned.has(name)) return
	warned.add(name)
	console.error(
		`[hydra-db] The ${kind} "${name}" is deprecated and will be removed in a future major version; use "${replacement}" instead.`,
	)
}
