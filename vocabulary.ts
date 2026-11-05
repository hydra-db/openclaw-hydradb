/**
 * What one stored thing is CALLED, per storage layout (PRO-1618).
 *
 * On a split database the list and delete surfaces really do address memories:
 * `type: "memory"` selects the memory corpus and nothing else. On a unified one
 * there is a single corpus, so the same call returns documents alongside
 * memories and `deleteMemory(id)` can remove a document. Saying "memory" there
 * promises one thing and hands back another, so the noun follows the layout.
 *
 * Ported from dashboard-2.0's `lib/storageLayout.ts` (`itemNoun`/`corpusLabel`)
 * so the two surfaces name the same thing the same way.
 */

import type { Layout } from "./hydra/index.ts"

/** What one stored item is called in this database's vocabulary. */
export function itemNoun(layout: Layout, plural = false): string {
	if (layout === "unified") return plural ? "items" : "item"
	return plural ? "memories" : "memory"
}

/** The label for the single list a unified database has, or for the memory half
 *  of a split one. */
export function corpusLabel(layout: Layout): string {
	return layout === "unified" ? "Context" : "Memory"
}

/**
 * The sentence a tool description needs when it is registered BEFORE the layout
 * is known. Registration is synchronous and the layout probe is not, so the
 * description cannot branch — it has to be true of both layouts instead of
 * promising the split one.
 */
export const LAYOUT_NEUTRAL_ITEM_PHRASE =
	"stored items (memories on a split database; on a unified database one corpus " +
	"holding memories and documents together)"
