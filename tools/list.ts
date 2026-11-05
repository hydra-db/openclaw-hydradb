import { Type } from "@sinclair/typebox"
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import type { HydraClient } from "../client.ts"
import type { HydraPluginConfig } from "../config.ts"
import { log } from "../log.ts"
import { TOOL_NAMES } from "../tool-names.ts"
import { itemNoun, LAYOUT_NEUTRAL_ITEM_PHRASE } from "../vocabulary.ts"
import { registerToolWithAlias } from "./register.ts"

export function registerListTool(
	api: OpenClawPluginApi,
	client: HydraClient,
	_cfg: HydraPluginConfig,
): void {
	registerToolWithAlias(
		api,
		{
			label: "Hydra List",
			description:
				`List everything stored in Hydra for this user — ${LAYOUT_NEUTRAL_ITEM_PHRASE}. ` +
				"Returns IDs and content summaries. Use this when the user asks what you remember " +
				"about them or wants to see their stored information.",
			parameters: Type.Object({}),
			async execute(_toolCallId: string, _params: Record<string, never>) {
				log.debug("list tool: fetching everything stored")

				const res = await client.listMemories()
				const items = res.user_memories ?? []
				// PRO-1618: on a unified database this list is the whole corpus,
				// so it carries documents as well as memories. Name what came
				// back rather than promising memories and returning documents.
				const layout = await client.layout()

				if (items.length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: `No ${itemNoun(layout, true)} stored yet.`,
							},
						],
					}
				}

				const lines = items.map((m, i) => {
					const preview =
						m.memory_content.length > 100
							? `${m.memory_content.slice(0, 100)}…`
							: m.memory_content
					return `${i + 1}. [ID: ${m.memory_id}]\n   ${preview}`
				})

				return {
					content: [
						{
							type: "text" as const,
							text: `Found ${items.length} ${itemNoun(layout, items.length !== 1)}:\n\n${lines.join("\n\n")}`,
						},
					],
				}
			},
		},
		TOOL_NAMES.LIST,
		TOOL_NAMES.LIST_MEMORIES,
	)
}
