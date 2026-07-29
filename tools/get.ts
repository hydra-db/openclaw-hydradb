import { Type } from "@sinclair/typebox"
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import type { HydraClient } from "../client.ts"
import type { HydraPluginConfig } from "../config.ts"
import { log } from "../log.ts"
import { TOOL_NAMES } from "../tool-names.ts"
import { registerToolWithAlias } from "./register.ts"

export function registerGetTool(
	api: OpenClawPluginApi,
	client: HydraClient,
	_cfg: HydraPluginConfig,
): void {
	registerToolWithAlias(
		api,
		{
			label: "Hydra Get Content",
			description:
				"Fetch the full content of a specific source from Hydra by its source ID. Use this to retrieve the complete text of a memory source when you need more details than what's shown in search results.",
			parameters: Type.Object({
				source_id: Type.String({
					description: "The unique source ID to fetch content for",
				}),
			}),
			async execute(
				_toolCallId: string,
				params: { source_id: string },
			) {
				log.debug(`get tool: source_id=${params.source_id}`)

				const res = await client.fetchContent(params.source_id)

				if (!res.success || res.error) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Failed to fetch source ${params.source_id}: ${res.error ?? "unknown error"}`,
							},
						],
					}
				}

				const content = res.content ?? res.content_base64 ?? "(no text content available)"
				const preview = content.length > 3000 ? `${content.slice(0, 3000)}…\n\n[Content truncated, showing first 3000 characters]` : content

				return {
					content: [
						{
							type: "text" as const,
							text: `Source: ${params.source_id}\n\n${preview}`,
						},
					],
				}
			},
		},
		TOOL_NAMES.INSPECT,
		TOOL_NAMES.GET_CONTENT,
	)
}
