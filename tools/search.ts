import { Type } from "@sinclair/typebox"
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import type { HydraClient } from "../client.ts"
import type { HydraPluginConfig } from "../config.ts"
import { buildRecalledContext, recallIsEmpty } from "../context.ts"
import { isUnifiedQueryResponse } from "../hydra/index.ts"
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

				if (recallIsEmpty(res)) {
					return {
						content: [{ type: "text" as const, text: "No relevant memories found." }],
					}
				}

				// On a unified database this is the server's `llm_prompt`, verbatim
				// (PRO-1618); on a split one it is the legacy rendering, unchanged.
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
						hasGraphContext: isUnifiedQueryResponse(res) ? res.graph.length > 0 : !!res.graph_context,
					},
				}
			},
		},
		TOOL_NAMES.QUERY,
		TOOL_NAMES.SEARCH,
	)
}
