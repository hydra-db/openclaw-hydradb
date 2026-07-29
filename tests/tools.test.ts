import { test } from "node:test"
import assert from "node:assert/strict"

import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import type { HydraClient } from "../client.ts"
import type { HydraPluginConfig } from "../config.ts"
import { registerSearchTool } from "../tools/search.ts"
import { registerToolWithAlias } from "../tools/register.ts"

type RegisteredTool = { name: string; execute: (id: string, params: any) => unknown }

function mockApi(): { api: OpenClawPluginApi; tools: RegisteredTool[] } {
	const tools: RegisteredTool[] = []
	const api = {
		registerTool(def: any) {
			tools.push({ name: def.name, execute: def.execute })
		},
	} as unknown as OpenClawPluginApi
	return { api, tools }
}

test("registerToolWithAlias registers both the canonical and alias names", () => {
	const { api, tools } = mockApi()
	registerToolWithAlias(
		api,
		{ label: "L", description: "D", parameters: {}, execute: () => "ok" },
		"canon_a",
		"alias_a",
	)
	assert.deepEqual(
		tools.map((t) => t.name).sort(),
		["alias_a", "canon_a"],
	)
})

test("invoking the alias warns once and still delegates to the shared handler", () => {
	const { api, tools } = mockApi()
	let handlerCalls = 0
	registerToolWithAlias(
		api,
		{
			label: "L",
			description: "D",
			parameters: {},
			execute: () => {
				handlerCalls++
				return "result"
			},
		},
		"canon_b",
		"alias_b_unique",
	)

	const alias = tools.find((t) => t.name === "alias_b_unique")!
	const canonical = tools.find((t) => t.name === "canon_b")!

	const original = console.error
	const messages: string[] = []
	console.error = (...args: unknown[]) => messages.push(args.map(String).join(" "))
	try {
		assert.equal(alias.execute("id1", {}), "result")
		assert.equal(alias.execute("id2", {}), "result")
		assert.equal(canonical.execute("id3", {}), "result")
	} finally {
		console.error = original
	}

	assert.equal(handlerCalls, 3, "alias and canonical share the same handler")
	const warnings = messages.filter((m) => m.includes("alias_b_unique"))
	assert.equal(warnings.length, 1, "alias warns exactly once per process")
	assert.match(warnings[0]!, /"canon_b"/)
})

test("registerSearchTool exposes the canonical hydradb_query and legacy hydra_search names", () => {
	const { api, tools } = mockApi()
	const client = {} as HydraClient
	const cfg = { maxRecallResults: 10, recallMode: "fast", graphContext: true } as HydraPluginConfig
	registerSearchTool(api, client, cfg)
	const names = tools.map((t) => t.name).sort()
	assert.deepEqual(names, ["hydra_search", "hydradb_query"])
})
