import { test } from "node:test"
import assert from "node:assert/strict"

import {
	ALIAS_REPLACEMENTS,
	CANONICAL_SLASH_NAMES,
	CANONICAL_TOOL_NAMES,
	DEPRECATED_TOOL_NAMES,
	SLASH_ALIAS_REPLACEMENTS,
	TOOL_NAMES,
	warnDeprecated,
} from "../tool-names.ts"

test("all tool names are unique", () => {
	const names = Object.values(TOOL_NAMES)
	assert.equal(new Set(names).size, names.length)
})

test("every deprecated tool alias resolves to a canonical tool", () => {
	const canonical = new Set<string>(CANONICAL_TOOL_NAMES)
	for (const alias of DEPRECATED_TOOL_NAMES) {
		const replacement = ALIAS_REPLACEMENTS[alias]
		assert.ok(replacement != null, `alias ${alias} has no replacement`)
		assert.ok(canonical.has(replacement), `${alias} → ${replacement} is not canonical`)
	}
})

test("every deprecated slash alias resolves to a canonical slash command", () => {
	const canonical = new Set<string>(CANONICAL_SLASH_NAMES)
	for (const [alias, replacement] of Object.entries(SLASH_ALIAS_REPLACEMENTS)) {
		assert.match(alias, /^\//, `slash alias ${alias} should carry a leading slash`)
		assert.ok(canonical.has(replacement), `${alias} → ${replacement} is not canonical`)
	}
})

test("warnDeprecated emits exactly one stderr warning per process for a given name", () => {
	const original = console.error
	const messages: string[] = []
	console.error = (...args: unknown[]) => {
		messages.push(args.map(String).join(" "))
	}
	try {
		// Synthetic, unique name so the per-process dedup Set is guaranteed fresh.
		warnDeprecated("tool", "unit_test_alias_zzz", "canonical_zzz")
		warnDeprecated("tool", "unit_test_alias_zzz", "canonical_zzz")
	} finally {
		console.error = original
	}
	const warnings = messages.filter((m) => m.includes("unit_test_alias_zzz"))
	assert.equal(warnings.length, 1, "should warn once per process")
	assert.match(warnings[0]!, /deprecated/)
	assert.match(warnings[0]!, /canonical_zzz/)
})
