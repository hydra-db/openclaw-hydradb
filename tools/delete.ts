import { Type } from "@sinclair/typebox"
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import type { HydraClient } from "../client.ts"
import type { HydraPluginConfig } from "../config.ts"
import { log } from "../log.ts"
import { TOOL_NAMES } from "../tool-names.ts"
import { itemNoun, LAYOUT_NEUTRAL_ITEM_PHRASE } from "../vocabulary.ts"
import { registerToolWithAlias } from "./register.ts"

export function registerDeleteTool(
	api: OpenClawPluginApi,
	client: HydraClient,
	_cfg: HydraPluginConfig,
): void {
	registerToolWithAlias(
		api,
		{
			label: "Hydra Delete",
			description:
				`Delete one stored item from Hydra by its ID — ${LAYOUT_NEUTRAL_ITEM_PHRASE}, ` +
				"so on a unified database this can remove a document as well as a memory. " +
				"Use this when the user explicitly asks you to forget something or remove a " +
				"specific piece of stored information. Always confirm the ID before deleting.",
			parameters: Type.Object({
				memory_id: Type.String({
					description: "The unique ID of the item to delete",
				}),
			}),
			async execute(
				_toolCallId: string,
				params: { memory_id: string },
			) {
				log.debug(`delete tool: memory_id=${params.memory_id}`)

				const res = await client.deleteMemory(params.memory_id)
				const noun = itemNoun(await client.layout())

				if (res.user_memory_deleted) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Successfully deleted ${noun}: ${params.memory_id}`,
							},
						],
					}
				}

				return {
					content: [
						{
							type: "text" as const,
							text: `No ${noun} ${params.memory_id} was found; it may already have been deleted.`,
						},
					],
				}
			},
		},
		TOOL_NAMES.DELETE,
		TOOL_NAMES.DELETE_MEMORY,
	)
}
