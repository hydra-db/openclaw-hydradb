import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import type { HydraClient } from "../client.ts"
import type { HydraPluginConfig } from "../config.ts"
import { log } from "../log.ts"
import { toToolSourceId } from "../session.ts"
import { SLASH_NAMES, warnDeprecated } from "../tool-names.ts"
import { itemNoun } from "../vocabulary.ts"

function preview(text: string, max = 80): string {
	return text.length > max ? `${text.slice(0, max)}…` : text
}

type CommandSpec = {
	description: string
	acceptsArgs: boolean
	requireAuth: boolean
	handler: (ctx: { args?: string }) => Promise<{ text: string }>
}

/**
 * Register a slash command under its canonical `hydradb-*` name AND its
 * deprecated `hydra-*` alias, sharing one handler. Invoking the alias emits one
 * deprecation warning per process (CONTRACT §3). `registerCommand` takes the
 * name WITHOUT the leading slash; the canonical/alias maps in tool-names.ts carry
 * the slash to match the shared conformance vectors, so we strip it here.
 */
function registerCommandWithAlias(
	api: OpenClawPluginApi,
	spec: CommandSpec,
	canonicalSlash: string,
	aliasSlash: string,
): void {
	const canonical = canonicalSlash.replace(/^\//, "")
	const alias = aliasSlash.replace(/^\//, "")

	api.registerCommand({
		name: canonical,
		description: spec.description,
		acceptsArgs: spec.acceptsArgs,
		requireAuth: spec.requireAuth,
		handler: spec.handler,
	})

	api.registerCommand({
		name: alias,
		description: `(deprecated — use /${canonical}) ${spec.description}`,
		acceptsArgs: spec.acceptsArgs,
		requireAuth: spec.requireAuth,
		handler: (ctx: { args?: string }) => {
			warnDeprecated("slash command", aliasSlash, canonicalSlash)
			return spec.handler(ctx)
		},
	})
}

export function registerSlashCommands(
	api: OpenClawPluginApi,
	client: HydraClient,
	cfg: HydraPluginConfig,
	getSessionId: () => string | undefined,
): void {
	// ingest — /hydradb-ingest (was /hydra-remember)
	registerCommandWithAlias(
		api,
		{
			description: "Save a piece of information to Hydra memory",
			acceptsArgs: true,
			requireAuth: true,
			handler: async (ctx: { args?: string }) => {
				const text = ctx.args?.trim()
				if (!text) return { text: "Usage: /hydradb-ingest <text to store>" }

				try {
					const sid = getSessionId()
					const sourceId = sid ? toToolSourceId(sid) : undefined
					await client.ingestText(text, { sourceId, title: "Manual Memory", infer: true })
					return { text: `Saved: "${preview(text, 60)}"` }
				} catch (err) {
					log.error("/hydradb-ingest", err)
					return { text: "Failed to save. Check logs." }
				}
			},
		},
		SLASH_NAMES.INGEST,
		"/hydra-remember",
	)

	// query — /hydradb-query (was /hydra-recall)
	registerCommandWithAlias(
		api,
		{
			description: "Search your Hydra memories",
			acceptsArgs: true,
			requireAuth: true,
			handler: async (ctx: { args?: string }) => {
				const query = ctx.args?.trim()
				if (!query) return { text: "Usage: /hydradb-query <query>" }

				try {
					const res = await client.recall(query, {
						maxResults: cfg.maxRecallResults,
						mode: cfg.recallMode,
						graphContext: cfg.graphContext,
					})

					if (!res.chunks || res.chunks.length === 0) {
						return { text: `No memories found for "${query}"` }
					}

					const lines = res.chunks.slice(0, 10).map((c, i) => {
						const score = c.relevancy_score != null ? ` (${Math.round(c.relevancy_score * 100)}%)` : ""
						const title = c.source_title ? ` [${c.source_title}]` : ""
						return `${i + 1}.${title} ${preview(c.chunk_content, 120)}${score}`
					})

					return { text: `Found ${res.chunks.length} chunks:\n\n${lines.join("\n")}` }
				} catch (err) {
					log.error("/hydradb-query", err)
					return { text: "Recall failed. Check logs." }
				}
			},
		},
		SLASH_NAMES.QUERY,
		"/hydra-recall",
	)

	// list — /hydradb-list (was /hydra-list)
	registerCommandWithAlias(
		api,
		{
			description: "List everything stored for this user",
			acceptsArgs: false,
			requireAuth: true,
			handler: async () => {
				try {
					const res = await client.listMemories()
					const items = res.user_memories ?? []
					// On a unified database this list is the whole corpus, so it
					// carries documents next to memories (PRO-1618).
					const layout = await client.layout()
					if (items.length === 0) return { text: `No ${itemNoun(layout, true)} stored yet.` }

					const lines = items.map(
						(m, i) => `${i + 1}. [${m.memory_id}] ${preview(m.memory_content, 100)}`,
					)
					return {
						text: `${items.length} ${itemNoun(layout, items.length !== 1)}:\n\n${lines.join("\n")}`,
					}
				} catch (err) {
					log.error("/hydradb-list", err)
					return { text: "Failed to list stored items. Check logs." }
				}
			},
		},
		SLASH_NAMES.LIST,
		"/hydra-list",
	)

	// delete — /hydradb-delete (was /hydra-delete)
	registerCommandWithAlias(
		api,
		{
			description: "Delete one stored item by its ID",
			acceptsArgs: true,
			requireAuth: true,
			handler: async (ctx: { args?: string }) => {
				const memoryId = ctx.args?.trim()
				if (!memoryId) return { text: "Usage: /hydradb-delete <id>" }

				try {
					const res = await client.deleteMemory(memoryId)
					const noun = itemNoun(await client.layout())
					if (res.user_memory_deleted) {
						return { text: `Deleted ${noun}: ${memoryId}` }
					}
					return { text: `No ${noun} ${memoryId} was found; it may already have been deleted.` }
				} catch (err) {
					log.error("/hydradb-delete", err)
					return { text: "Delete failed. Check logs." }
				}
			},
		},
		SLASH_NAMES.DELETE,
		"/hydra-delete",
	)

	// inspect — /hydradb-inspect (was /hydra-get)
	registerCommandWithAlias(
		api,
		{
			description: "Fetch the content of a specific source by its ID",
			acceptsArgs: true,
			requireAuth: true,
			handler: async (ctx: { args?: string }) => {
				const sourceId = ctx.args?.trim()
				if (!sourceId) return { text: "Usage: /hydradb-inspect <source_id>" }

				try {
					const res = await client.fetchContent(sourceId)
					if (!res.success || res.error) {
						return { text: `Could not fetch source ${sourceId}: ${res.error ?? "unknown error"}` }
					}
					const content = res.content ?? res.content_base64 ?? "(no text content)"
					return { text: `Source: ${sourceId}\n\n${preview(content, 2000)}` }
				} catch (err) {
					log.error("/hydradb-inspect", err)
					return { text: "Fetch failed. Check logs." }
				}
			},
		},
		SLASH_NAMES.INSPECT,
		"/hydra-get",
	)
}
