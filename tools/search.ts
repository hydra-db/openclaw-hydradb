import { Type } from "@sinclair/typebox"
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import type { HydraClient } from "../client.ts"
import type { HydraPluginConfig } from "../config.ts"
import { buildRecalledContext } from "../context.ts"
import { log } from "../log.ts"
import { TOOL_NAMES } from "../tool-names.ts"
import { registerToolWithAlias } from "./register.ts"


export function registerSearchTool(
	api: OpenClawPluginApi,
	client: HydraClient,
	cfg: HydraPluginConfig,
): void {
	registerToolWithAlias(
		api,
		{
			label: "Hydra Search",
			description:
				"Search through Hydra DB memories. Returns relevant chunks with graph-enriched context.",
			parameters: Type.Object({
				query: Type.String({ description: "Search query" }),
				limit: Type.Optional(
					Type.Number({ description: "Max results (default: 10)" }),
				),
			}),
			async execute(
				_toolCallId: string,
				params: { query: string; limit?: number },
			) {
				const limit = params.limit ?? cfg.maxRecallResults
				log.debug(`search tool: "${params.query}" limit=${limit}`)

				const res = await client.recall(params.query, {
					maxResults: limit,
					mode: cfg.recallMode,
					graphContext: cfg.graphContext,
				})

				if (!res.chunks || res.chunks.length === 0) {
					return {
						content: [{ type: "text" as const, text: "No relevant memories found." }],
					}
				}

				const contextStr = buildRecalledContext(res)

				return {
					content: [
						{
							type: "text" as const,
							text: `Found ${res.chunks.length} chunks\n\n---\nFull context:\n${contextStr}`,
						},
					],
					details: {
						count: res.chunks.length,
						hasGraphContext: !!res.graph_context,
					},
				}
			},
		},
		TOOL_NAMES.QUERY,
		TOOL_NAMES.SEARCH,
	)
}
