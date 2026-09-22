import type { HydraClient } from "../client.ts"
import type { HydraPluginConfig } from "../config.ts"
import { buildRecalledContext, envelopeForInjection, recallIsEmpty } from "../context.ts"
import { log } from "../log.ts"
import { containsIgnoreTerm } from "../messages.ts"

export function createRecallHook(
	client: HydraClient,
	cfg: HydraPluginConfig,
) {
	return async (event: Record<string, unknown>) => {
		const prompt = event.prompt as string | undefined
		if (!prompt || prompt.length < 5) return

		if (containsIgnoreTerm(prompt, cfg.ignoreTerm)) {
			log.debug(`recall skipped — prompt contains ignore term "${cfg.ignoreTerm}"`)
			return
		}

		log.debug(`recall query (${prompt.length} chars)`)

		try {
			const response = await client.recall(prompt, {
				maxResults: cfg.maxRecallResults,
				mode: cfg.recallMode,
				graphContext: cfg.graphContext,
			})

			if (recallIsEmpty(response)) {
				log.debug("no memories matched")
				return
			}

			// On a unified database this is the server's `llm_prompt`, verbatim
			// (PRO-1618); on a split one it is the legacy rendering, unchanged.
			const body = buildRecalledContext(response)
			if (!body.trim()) return

			const envelope = envelopeForInjection(body)

			log.debug(`injecting ${response.chunks.length} chunks (${envelope.length} chars)`)
			return { prependContext: envelope }
		} catch (err) {
			log.error("recall failed", err)
			return
		}
	}
}
