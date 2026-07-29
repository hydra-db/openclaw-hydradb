import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import { warnDeprecated } from "../tool-names.ts"

/** A tool definition, minus its `name` (supplied per registration). */
export type ToolDef = {
	label: string
	description: string
	parameters: unknown
	execute: (toolCallId: string, params: any) => unknown
}

/**
 * Register a tool under its canonical name AND its deprecated alias, sharing one
 * `execute`. Invoking the alias emits exactly one deprecation warning per process
 * (CONTRACT §3); the canonical name is silent. Agent-tool errors still propagate
 * unchanged — the wrapper only prepends a one-line stderr notice on alias use.
 */
export function registerToolWithAlias(
	api: OpenClawPluginApi,
	def: ToolDef,
	canonical: string,
	alias: string,
): void {
	api.registerTool({ ...def, name: canonical }, { name: canonical })
	api.registerTool(
		{
			...def,
			name: alias,
			execute: (toolCallId: string, params: any) => {
				warnDeprecated("tool", alias, canonical)
				return def.execute(toolCallId, params)
			},
		},
		{ name: alias },
	)
}
