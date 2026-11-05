import { test } from "node:test"
import assert from "node:assert/strict"

import { removeInjectedBlocks, toIngestableTurns } from "../messages.ts"

test("removeInjectedBlocks strips the recall the plugin injected and trims", () => {
	assert.equal(
		removeInjectedBlocks("<hydra-context>recalled</hydra-context>\n\nreal answer"),
		"real answer",
	)
	assert.equal(removeInjectedBlocks("<hydra-context>recalled</hydra-context>"), "")
})

// PRO-1618: this is why the filter is shared rather than copied. An assistant
// reply that was ENTIRELY an injected recall trims to "", and a unified database
// rejects the empty turn — and rejects the WHOLE request when it does, so one
// such turn loses the entire capture. `withKind` cannot save it either: the kind
// is already `unified`. The hook path filtered; the store tool did not.
test("toIngestableTurns drops a turn that is empty once the injected recall is stripped", () => {
	const turns = toIngestableTurns([
		{ user: "what did I say about dark mode", assistant: "<hydra-context>recalled</hydra-context>" },
		{ user: "and about fonts", assistant: "You prefer a serif face." },
	])
	assert.deepEqual(turns, [{ user: "and about fonts", assistant: "You prefer a serif face." }])
})

test("toIngestableTurns drops a turn whose halves are too short to be context", () => {
	assert.deepEqual(toIngestableTurns([{ user: "ok", assistant: "sure thing" }]), [])
	assert.deepEqual(toIngestableTurns([{ user: "hello there", assistant: "yes" }]), [])
})

test("toIngestableTurns keeps a clean turn with the injected blocks removed", () => {
	assert.deepEqual(
		toIngestableTurns([
			{
				user: "<hydra-context>recalled</hydra-context>\n\nwhat is my name",
				assistant: "You told me it is Ada.",
			},
		]),
		[{ user: "what is my name", assistant: "You told me it is Ada." }],
	)
})
