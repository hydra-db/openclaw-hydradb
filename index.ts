import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import { HydraClient } from "./client.ts"
import type { HydraPluginConfig } from "./config.ts"
import { registerOnboardingCli as createOnboardingCliRegistrar, registerOnboardingSlashCommands } from "./commands/onboarding.ts"
import { registerSlashCommands } from "./commands/slash.ts"
import { hydraConfigSchema, tryParseConfig } from "./config.ts"
import { createIngestionHook } from "./hooks/capture.ts"
import { createRecallHook } from "./hooks/recall.ts"
import { log } from "./log.ts"
import { warnDeprecated } from "./tool-names.ts"
import { registerDeleteTool } from "./tools/delete.ts"
import { registerGetTool } from "./tools/get.ts"
import { registerListTool } from "./tools/list.ts"
import { registerSearchTool } from "./tools/search.ts"
import { registerStoreTool } from "./tools/store.ts"

const NOT_CONFIGURED_MSG =
	"[hydra-db] Not configured. Run `openclaw hydra onboard` to set up credentials."

export default {
	id: "openclaw",
	name: "Hydra DB",
	description:
		"State-of-the-art agentic memory for OpenClaw powered by Hydra DB — auto-capture, recall, and graph-enriched context",
	kind: "memory" as const,
	configSchema: hydraConfigSchema,

	register(api: OpenClawPluginApi) {
		const cfg = tryParseConfig(api.pluginConfig)
		const cliClient = cfg
			? new HydraClient(cfg.apiKey, cfg.tenantId, cfg.subTenantId, cfg.baseUrl)
			: null

		// Always register ALL CLI commands so they appear in help text.
		// Non-onboard commands guard on credentials at runtime.
		//
		// PRO-1298: `hydradb` is the canonical root; `hydra` stays as a deprecated
		// alias root (its verbs warn once on use) so existing muscle-memory and
		// docs keep working.
		api.registerCli(
			({ program }: { program: any }) => {
				const canonicalRoot = program
					.command("hydradb")
					.description("Hydra DB memory commands")
				createOnboardingCliRegistrar(cfg ?? undefined)(canonicalRoot)
				registerCanonicalCliCommands(canonicalRoot, cliClient, cfg)

				const legacyRoot = program
					.command("hydra")
					.description("(deprecated — use `hydradb`) Hydra DB memory commands")
				createOnboardingCliRegistrar(cfg ?? undefined)(legacyRoot)
				registerLegacyCliCommands(legacyRoot, cliClient, cfg)
			},
			{ commands: ["hydradb", "hydra"] },
		)

		if (!cfg) {
			api.registerService({
				id: "openclaw",
				start: () => console.log(NOT_CONFIGURED_MSG),
				stop: () => {},
			})
			return
		}

		// Full plugin registration — credentials present
		log.init(api.logger, cfg.debug)

		const client = new HydraClient(cfg.apiKey, cfg.tenantId, cfg.subTenantId, cfg.baseUrl)

		let activeSessionId: string | undefined
		let conversationMessages: unknown[] = []
		const getSessionId = () => activeSessionId
		const getMessages = () => conversationMessages

		registerSearchTool(api, client, cfg)
		registerStoreTool(api, client, cfg, getSessionId, getMessages)
		registerListTool(api, client, cfg)
		registerDeleteTool(api, client, cfg)
		registerGetTool(api, client, cfg)

		if (cfg.autoRecall) {
			const onRecall = createRecallHook(client, cfg)
			api.on(
				"before_agent_start",
				(event: Record<string, unknown>, ctx: Record<string, unknown>) => {
					if (ctx.sessionId) activeSessionId = ctx.sessionId as string
					if (Array.isArray(event.messages)) conversationMessages = event.messages
					log.debug(`[session] before_agent_start — sid=${activeSessionId ?? "none"} msgs=${conversationMessages.length}`)
					return onRecall(event)
				},
			)
		}

		if (cfg.autoCapture) {
			const captureHandler = createIngestionHook(client, cfg)
			api.on(
				"agent_end",
				(event: Record<string, unknown>, ctx: Record<string, unknown>) => {
					if (ctx.sessionId) activeSessionId = ctx.sessionId as string
					if (Array.isArray(event.messages)) conversationMessages = event.messages
					log.debug(`[session] agent_end — sid=${activeSessionId ?? "none"} msgs=${conversationMessages.length} ctxKeys=${Object.keys(ctx).join(",")}`)
					return captureHandler(event, activeSessionId)
				},
			)
		}

		registerSlashCommands(api, client, cfg, getSessionId)
		registerOnboardingSlashCommands(api, client, cfg)

		api.registerService({
			id: "openclaw",
			start: () => log.info("plugin started"),
			stop: () => log.info("plugin stopped"),
		})
	},
}

/**
 * CLI action handlers, shared by the canonical `hydradb` verbs and their
 * deprecated `hydra` aliases. Each guards on valid credentials at runtime.
 */
type CliCtx = { client: HydraClient; cfg: HydraPluginConfig }

function makeRequireCreds(
	client: HydraClient | null,
	cfg: HydraPluginConfig | null,
): () => CliCtx | null {
	return () => {
		if (client && cfg) return { client, cfg }
		console.error(NOT_CONFIGURED_MSG)
		return null
	}
}

async function queryAction(ctx: CliCtx, query: string, opts: { limit: string }): Promise<void> {
	const limit = Number.parseInt(opts.limit, 10) || 10
	const res = await ctx.client.recall(query, {
		maxResults: limit,
		mode: ctx.cfg.recallMode,
		graphContext: ctx.cfg.graphContext,
	})

	if (!res.chunks || res.chunks.length === 0) {
		console.log("No memories found.")
		return
	}

	for (const chunk of res.chunks) {
		const score = chunk.relevancy_score != null
			? ` (${(chunk.relevancy_score * 100).toFixed(0)}%)`
			: ""
		const title = chunk.source_title ? `[${chunk.source_title}] ` : ""
		console.log(`- ${title}${chunk.chunk_content.slice(0, 200)}${score}`)
	}
}

async function ingestAction(ctx: CliCtx, text: string, opts: { title?: string }): Promise<void> {
	await ctx.client.ingestText(text, { title: opts.title ?? "Manual Memory", infer: true })
	console.log(`Saved: "${text.length > 60 ? `${text.slice(0, 60)}…` : text}"`)
}

async function listAction(ctx: CliCtx): Promise<void> {
	const res = await ctx.client.listMemories()
	const memories = res.user_memories ?? []
	if (memories.length === 0) {
		console.log("No memories stored.")
		return
	}
	for (const m of memories) {
		console.log(`[${m.memory_id}] ${m.memory_content.slice(0, 150)}`)
	}
	console.log(`\nTotal: ${memories.length}`)
}

async function deleteAction(ctx: CliCtx, memoryId: string): Promise<void> {
	const res = await ctx.client.deleteMemory(memoryId)
	console.log(res.user_memory_deleted ? `Deleted: ${memoryId}` : `Not found: ${memoryId}`)
}

async function inspectAction(ctx: CliCtx, sourceId: string): Promise<void> {
	const res = await ctx.client.fetchContent(sourceId)
	if (!res.success || res.error) {
		console.error(`Error: ${res.error ?? "unknown"}`)
		return
	}
	console.log(res.content ?? res.content_base64 ?? "(no text content)")
}

function statusAction(ctx: CliCtx): void {
	console.log(`Tenant:       ${ctx.client.getTenantId()}`)
	console.log(`Sub-Tenant:   ${ctx.client.getSubTenantId()}`)
	console.log(`Auto-Recall:  ${ctx.cfg.autoRecall}`)
	console.log(`Auto-Capture: ${ctx.cfg.autoCapture}`)
	console.log(`Recall Mode:  ${ctx.cfg.recallMode}`)
	console.log(`Graph:        ${ctx.cfg.graphContext}`)
	console.log(`Max Results:  ${ctx.cfg.maxRecallResults}`)
	console.log(`Ignore Term:  ${ctx.cfg.ignoreTerm}`)
}

/** Canonical `hydradb <verb>` subcommands. */
function registerCanonicalCliCommands(
	root: any,
	client: HydraClient | null,
	cfg: HydraPluginConfig | null,
): void {
	const requireCreds = makeRequireCreds(client, cfg)

	root
		.command("query")
		.argument("<query>", "Search query")
		.option("--limit <n>", "Max results", "10")
		.action(async (query: string, opts: { limit: string }) => {
			const ctx = requireCreds()
			if (ctx) await queryAction(ctx, query, opts)
		})

	root
		.command("ingest")
		.argument("<text>", "Text to store as a memory")
		.option("--title <title>", "Optional title")
		.action(async (text: string, opts: { title?: string }) => {
			const ctx = requireCreds()
			if (ctx) await ingestAction(ctx, text, opts)
		})

	root
		.command("list")
		.description("List all user memories")
		.action(async () => {
			const ctx = requireCreds()
			if (ctx) await listAction(ctx)
		})

	root
		.command("inspect")
		.argument("<source_id>", "Source ID to fetch")
		.action(async (sourceId: string) => {
			const ctx = requireCreds()
			if (ctx) await inspectAction(ctx, sourceId)
		})

	root
		.command("delete")
		.argument("<memory_id>", "Memory ID to delete")
		.action(async (memoryId: string) => {
			const ctx = requireCreds()
			if (ctx) await deleteAction(ctx, memoryId)
		})

	root
		.command("status")
		.description("Show plugin configuration")
		.action(() => {
			const ctx = requireCreds()
			if (ctx) statusAction(ctx)
		})
}

/**
 * Deprecated `hydra <verb>` subcommands — kept working as aliases of the
 * canonical `hydradb` verbs. Each data verb emits one deprecation warning per
 * process naming its canonical replacement (CONTRACT §3).
 */
function registerLegacyCliCommands(
	root: any,
	client: HydraClient | null,
	cfg: HydraPluginConfig | null,
): void {
	const requireCreds = makeRequireCreds(client, cfg)

	root
		.command("search")
		.argument("<query>", "Search query")
		.option("--limit <n>", "Max results", "10")
		.action(async (query: string, opts: { limit: string }) => {
			warnDeprecated("CLI command", "hydra search", "hydradb query")
			const ctx = requireCreds()
			if (ctx) await queryAction(ctx, query, opts)
		})

	root
		.command("list")
		.description("List all user memories")
		.action(async () => {
			warnDeprecated("CLI command", "hydra list", "hydradb list")
			const ctx = requireCreds()
			if (ctx) await listAction(ctx)
		})

	root
		.command("delete")
		.argument("<memory_id>", "Memory ID to delete")
		.action(async (memoryId: string) => {
			warnDeprecated("CLI command", "hydra delete", "hydradb delete")
			const ctx = requireCreds()
			if (ctx) await deleteAction(ctx, memoryId)
		})

	root
		.command("get")
		.argument("<source_id>", "Source ID to fetch")
		.action(async (sourceId: string) => {
			warnDeprecated("CLI command", "hydra get", "hydradb inspect")
			const ctx = requireCreds()
			if (ctx) await inspectAction(ctx, sourceId)
		})

	root
		.command("status")
		.description("Show plugin configuration")
		.action(() => {
			warnDeprecated("CLI command", "hydra status", "hydradb status")
			const ctx = requireCreds()
			if (ctx) statusAction(ctx)
		})
}
