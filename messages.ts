import type { ConversationTurn } from "./types/hydra.ts"

export function containsIgnoreTerm(text: string, ignoreTerm: string): boolean {
	return text.toLowerCase().includes(ignoreTerm.toLowerCase())
}

export function filterIgnoredTurns(
	turns: ConversationTurn[],
	ignoreTerm: string,
): ConversationTurn[] {
	return turns.filter(
		(t) =>
			!containsIgnoreTerm(t.user, ignoreTerm) &&
			!containsIgnoreTerm(t.assistant, ignoreTerm),
	)
}

/**
 * Strip the `<hydra-context>` blocks auto-recall injects, so a captured turn
 * carries what the user and the model actually said and never the recall the
 * plugin fed back in.
 */
export function removeInjectedBlocks(text: string): string {
	return text.replace(/<hydra-context>[\s\S]*?<\/hydra-context>\s*/g, "").trim()
}

/**
 * The shortest turn worth storing. A turn below this is what is left after the
 * injected blocks are stripped — an assistant reply that was ENTIRELY a recall
 * block trims to `""` — and an empty half is not context, it is noise.
 */
const MIN_TURN_CHARS = 5

/**
 * Clean a run of turns and drop the ones that no longer carry anything.
 *
 * PRO-1618: the filter is not cosmetic. A unified database rejects an item with
 * an empty conversation turn, and rejects the WHOLE request when it does, so a
 * single stripped-to-nothing turn loses the entire capture — and the retry that
 * saves every other layout mistake cannot help, because the kind is already
 * `unified`. The hook path and the store tool build turns identically, so they
 * share this function rather than each keeping their own copy: the store tool
 * was missing the filter, which is exactly how the two drifted.
 */
export function toIngestableTurns(turns: ConversationTurn[]): ConversationTurn[] {
	return turns
		.map((t) => ({
			user: removeInjectedBlocks(t.user),
			assistant: removeInjectedBlocks(t.assistant),
		}))
		.filter((t) => t.user.length >= MIN_TURN_CHARS && t.assistant.length >= MIN_TURN_CHARS)
}

export function textFromMessage(msg: Record<string, unknown>): string {
	const content = msg.content
	if (typeof content === "string") return content
	if (Array.isArray(content)) {
		return content
			.filter(
				(b) =>
					b &&
					typeof b === "object" &&
					(b as Record<string, unknown>).type === "text",
			)
			.map((b) => (b as Record<string, unknown>).text as string)
			.filter(Boolean)
			.join("\n")
	}
	return ""
}

export function extractAllTurns(messages: unknown[]): ConversationTurn[] {
	const turns: ConversationTurn[] = []
	let currentUserText: string | null = null
	let currentAssistantText: string | null = null

	for (const msg of messages) {
		if (!msg || typeof msg !== "object") continue
		const m = msg as Record<string, unknown>
		const text = textFromMessage(m)

		if (m.role === "user") {
			if (!text) continue
			if (currentUserText && currentAssistantText) {
				turns.push({ user: currentUserText, assistant: currentAssistantText })
			}
			currentUserText = text
			currentAssistantText = "no-message"
		} else if (m.role === "assistant") {
			if (!text) continue
			currentAssistantText = text
		}
	}

	if (currentUserText && currentAssistantText) {
		turns.push({ user: currentUserText, assistant: currentAssistantText })
	}

	return turns
}

export function getLatestTurn(messages: unknown[]): ConversationTurn | null {
	let userIdx = -1
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]
		if (m && typeof m === "object" && (m as Record<string, unknown>).role === "user") {
			userIdx = i
			break
		}
	}
	if (userIdx < 0) return null

	const userText = textFromMessage(messages[userIdx] as Record<string, unknown>)
	if (!userText) return null

	for (let i = userIdx + 1; i < messages.length; i++) {
		const m = messages[i]
		if (m && typeof m === "object" && (m as Record<string, unknown>).role === "assistant") {
			const aText = textFromMessage(m as Record<string, unknown>)
			if (aText) return { user: userText, assistant: aText }
		}
	}
	return null
}
