import { Type } from "@sinclair/typebox"
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import type { HydraClient } from "../client.ts"
import type { HydraPluginConfig } from "../config.ts"
import { log } from "../log.ts"
import { extractAllTurns, filterIgnoredTurns, toIngestableTurns } from "../messages.ts"
import { toToolSourceId } from "../session.ts"
import { TOOL_NAMES } from "../tool-names.ts"
import type { ConversationTurn } from "../types/hydra.ts"
import { registerToolWithAlias } from "./register.ts"

const MAX_STORE_TURNS = 10

export function registerStoreTool(
	api: OpenClawPluginApi,
	client: HydraClient,
	cfg: HydraPluginConfig,
	getSessionId: () => string | undefined,
	getMessages: () => unknown[],
): void {
	registerToolWithAlias(
		api,
		{
			label: "Hydra Store",
			description:
				"Save the full conversation history to Hydra DB memory. Use this to persist facts, preferences, or decisions the user wants remembered. The complete chat history will be sent for context-rich storage.",
			parameters: Type.Object({
				text: Type.String({
					description: "A brief summary or note about what is being saved",
				}),
				title: Type.Optional(
					Type.String({
						description: "Optional title for the memory entry",
					}),
				),
			}),
			async execute(
				_toolCallId: string,
				params: { text: string; title?: string },
			) {
				const sid = getSessionId()
				const sourceId = sid ? toToolSourceId(sid) : undefined
				const messages = getMessages()

				log.debug(`[store] tool called — sid=${sid ?? "none"} msgs=${messages.length} text="${params.text.slice(0, 50)}"`)

				const rawTurns = extractAllTurns(messages)
				const filteredTurns = filterIgnoredTurns(rawTurns, cfg.ignoreTerm)
				const recentTurns = filteredTurns.slice(-MAX_STORE_TURNS)
				const turns: ConversationTurn[] = toIngestableTurns(recentTurns)

				log.debug(`[store] extracted ${rawTurns.length} total turns, ${rawTurns.length - filteredTurns.length} ignored, using last ${turns.length} (MAX_STORE_TURNS=${MAX_STORE_TURNS})`)

				if (turns.length > 0 && sourceId) {
					const now = new Date()
					const readableTime = now.toLocaleString("en-US", {
						weekday: "short",
						year: "numeric",
						month: "short",
						day: "numeric",
						hour: "2-digit",
						minute: "2-digit",
						timeZoneName: "short",
					})

					const annotatedTurns = turns.map((t, i) => ({
						user: i === 0 ? `[Temporal details: ${readableTime}]\n\n${t.user}` : t.user,
						assistant: t.assistant,
					}))

					log.debug(`[store] ingesting ${annotatedTurns.length} conversation turns -> ${sourceId}`)

					await client.ingestConversation(annotatedTurns, sourceId, {
						metadata: {
							captured_at: now.toISOString(),
							source: "openclaw_tool",
							note: params.text,
						},
					})

					return {
						content: [
							{
								type: "text" as const,
								text: `Saved ${annotatedTurns.length} conversation turns to Hydra (${sourceId}). Note: "${params.text.length > 80 ? `${params.text.slice(0, 80)}…` : params.text}"`,
							},
						],
					}
				}

				log.debug("[store] no conversation turns found, falling back to text ingestion")

				await client.ingestText(params.text, {
					sourceId,
					title: params.title ?? "Agent Memory",
					infer: true,
				})

				return {
					content: [
						{
							type: "text" as const,
							text: `Saved to Hydra: "${params.text.length > 80 ? `${params.text.slice(0, 80)}…` : params.text}"`,
						},
					],
				}
			},
		},
		TOOL_NAMES.INGEST,
		TOOL_NAMES.STORE,
	)
}
