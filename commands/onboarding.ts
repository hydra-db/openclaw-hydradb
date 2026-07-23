import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as readline from "node:readline"
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import type { HydraClient } from "../client.ts"
import type { HydraPluginConfig } from "../config.ts"
import { log } from "../log.ts"
import { warnDeprecated } from "../tool-names.ts"

// ── Defaults (used when config is not yet available) ──

const DEFAULTS = {
	subTenantId: "hydra-openclaw-plugin",
	ignoreTerm: "hydra-ignore",
	autoRecall: true,
	autoCapture: true,
	maxRecallResults: 10,
	recallMode: "fast" as const,
	graphContext: true,
	debug: false,
}

// ── ANSI helpers ──

const c = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	cyan: "\x1b[36m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	magenta: "\x1b[35m",
	white: "\x1b[37m",
	bgCyan: "\x1b[46m",
	bgGreen: "\x1b[42m",
	black: "\x1b[30m",
}

function mask(value: string, visible = 4): string {
	if (value.length <= visible) return "****"
	return `${"*".repeat(value.length - visible)}${value.slice(-visible)}`
}

// ── Prompt primitives ──

function createRl(): readline.Interface {
	return readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	})
}

function ask(rl: readline.Interface, question: string): Promise<string> {
	return new Promise((resolve) => rl.question(question, resolve))
}

async function promptText(
	rl: readline.Interface,
	label: string,
	opts?: { default?: string; required?: boolean; secret?: boolean },
): Promise<string> {
	const def = opts?.default
	const hint = def ? `${c.dim} (${def})${c.reset}` : opts?.required ? `${c.red} *${c.reset}` : ""
	const prefix = `  ${c.cyan}?${c.reset} ${c.bold}${label}${c.reset}${hint}${c.dim} ›${c.reset} `

	while (true) {
		const raw = await ask(rl, prefix)
		const value = raw.trim()
		if (value) return value
		if (def) return def
		if (opts?.required) {
			console.log(`    ${c.red}This field is required.${c.reset}`)
			continue
		}
		return ""
	}
}

async function promptChoice(
	rl: readline.Interface,
	label: string,
	choices: string[],
	defaultChoice: string,
): Promise<string> {
	const tags = choices
		.map((ch) => (ch === defaultChoice ? `${c.green}${c.bold}${ch}${c.reset}` : `${c.dim}${ch}${c.reset}`))
		.join(`${c.dim} / ${c.reset}`)

	const prefix = `  ${c.cyan}?${c.reset} ${c.bold}${label}${c.reset} ${tags}${c.dim} ›${c.reset} `

	while (true) {
		const raw = await ask(rl, prefix)
		const value = raw.trim().toLowerCase()
		if (!value) return defaultChoice
		const match = choices.find((ch) => ch.toLowerCase() === value)
		if (match) return match
		console.log(`    ${c.yellow}Choose one of: ${choices.join(", ")}${c.reset}`)
	}
}

async function promptBool(
	rl: readline.Interface,
	label: string,
	defaultVal: boolean,
): Promise<boolean> {
	const hint = defaultVal
		? `${c.dim} (${c.green}Y${c.reset}${c.dim}/n)${c.reset}`
		: `${c.dim} (y/${c.green}N${c.reset}${c.dim})${c.reset}`
	const prefix = `  ${c.cyan}?${c.reset} ${c.bold}${label}${c.reset}${hint}${c.dim} ›${c.reset} `

	const raw = await ask(rl, prefix)
	const value = raw.trim().toLowerCase()
	if (!value) return defaultVal
	return value === "y" || value === "yes" || value === "true"
}

async function promptNumber(
	rl: readline.Interface,
	label: string,
	defaultVal: number,
	min: number,
	max: number,
): Promise<number> {
	const prefix = `  ${c.cyan}?${c.reset} ${c.bold}${label}${c.reset}${c.dim} (${defaultVal}) [${min}–${max}] ›${c.reset} `

	while (true) {
		const raw = await ask(rl, prefix)
		const value = raw.trim()
		if (!value) return defaultVal
		const n = Number.parseInt(value, 10)
		if (!Number.isNaN(n) && n >= min && n <= max) return n
		console.log(`    ${c.yellow}Enter a number between ${min} and ${max}.${c.reset}`)
	}
}

// ── Banner ──

function printBanner(): void {
	console.log()
	console.log(`  ${c.bgCyan}${c.black}${c.bold}                              ${c.reset}`)
	console.log(`  ${c.bgCyan}${c.black}${c.bold}    ◆  Hydra DB — Onboard    ${c.reset}`)
	console.log(`  ${c.bgCyan}${c.black}${c.bold}                              ${c.reset}`)
	console.log()
}

function printSection(title: string): void {
	console.log()
	console.log(`  ${c.magenta}${c.bold}── ${title} ${"─".repeat(Math.max(0, 40 - title.length))}${c.reset}`)
	console.log()
}

function printSummaryRow(label: string, value: string, sensitive = false): void {
	const display = sensitive ? mask(value) : value
	console.log(`  ${c.dim}│${c.reset}  ${c.bold}${label.padEnd(18)}${c.reset} ${c.cyan}${display}${c.reset}`)
}

function printSuccess(msg: string): void {
	console.log()
	console.log(`  ${c.bgGreen}${c.black}${c.bold} ✓ ${c.reset} ${c.green}${msg}${c.reset}`)
	console.log()
}

// ── Config output ──

type WizardResult = {
	apiKey: string
	tenantId: string
	subTenantId: string
	ignoreTerm: string
	autoRecall?: boolean
	autoCapture?: boolean
	maxRecallResults?: number
	recallMode?: "fast" | "thinking"
	graphContext?: boolean
	debug?: boolean
}

function buildConfigObj(result: WizardResult): Record<string, unknown> {
	const obj: Record<string, unknown> = {}

	obj.apiKey = result.apiKey
	obj.tenantId = result.tenantId

	if (result.subTenantId !== DEFAULTS.subTenantId) {
		obj.subTenantId = result.subTenantId
	}
	if (result.ignoreTerm !== DEFAULTS.ignoreTerm) {
		obj.ignoreTerm = result.ignoreTerm
	}
	if (result.autoRecall !== undefined && result.autoRecall !== DEFAULTS.autoRecall) {
		obj.autoRecall = result.autoRecall
	}
	if (result.autoCapture !== undefined && result.autoCapture !== DEFAULTS.autoCapture) {
		obj.autoCapture = result.autoCapture
	}
	if (result.maxRecallResults !== undefined && result.maxRecallResults !== DEFAULTS.maxRecallResults) {
		obj.maxRecallResults = result.maxRecallResults
	}
	if (result.recallMode !== undefined && result.recallMode !== DEFAULTS.recallMode) {
		obj.recallMode = result.recallMode
	}
	if (result.graphContext !== undefined && result.graphContext !== DEFAULTS.graphContext) {
		obj.graphContext = result.graphContext
	}
	if (result.debug !== undefined && result.debug !== DEFAULTS.debug) {
		obj.debug = result.debug
	}

	return obj
}

// ── Persist to openclaw.json ──
// Mirrors openclaw's own path resolution (src/config/paths.ts):
//   1. $OPENCLAW_CONFIG_PATH  (explicit override)
//   2. $OPENCLAW_STATE_DIR/openclaw.json
//   3. $OPENCLAW_HOME/.openclaw/openclaw.json
//   4. os.homedir()/.openclaw/openclaw.json  (default)

function resolveOpenClawConfigPath(): string {
	if (process.env.OPENCLAW_CONFIG_PATH) {
		return process.env.OPENCLAW_CONFIG_PATH
	}
	if (process.env.OPENCLAW_STATE_DIR) {
		return path.join(process.env.OPENCLAW_STATE_DIR, "openclaw.json")
	}
	if (process.env.OPENCLAW_HOME) {
		return path.join(process.env.OPENCLAW_HOME, ".openclaw", "openclaw.json")
	}
	return path.join(os.homedir(), ".openclaw", "openclaw.json")
}

const OPENCLAW_CONFIG_PATH = resolveOpenClawConfigPath()

function persistConfig(configObj: Record<string, unknown>): boolean {
	try {
		const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, "utf-8")
		const root = JSON.parse(raw)

		if (!root.plugins) root.plugins = {}
		if (!root.plugins.entries) root.plugins.entries = {}
		if (!root.plugins.entries["openclaw"]) {
			root.plugins.entries["openclaw"] = { enabled: true }
		}

		root.plugins.entries["openclaw"].config = configObj

		fs.writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(root, null, 2) + "\n")
		return true
	} catch {
		return false
	}
}

// ── Wizards ──

async function runBasicWizard(cfg?: HydraPluginConfig): Promise<void> {
	const rl = createRl()

	try {
		printBanner()
		console.log(`  ${c.dim}Configure the essential settings for Hydra DB.${c.reset}`)
		console.log(`  ${c.dim}Press Enter to accept defaults shown in parentheses.${c.reset}`)

		printSection("Credentials")

		const apiKey = await promptText(rl, "API Key", {
			required: true,
			secret: true,
		})

		const tenantId = await promptText(rl, "Tenant ID", {
			required: true,
		})

		printSection("Customisation")

		const subTenantId = await promptText(rl, "Sub-Tenant ID", {
			default: cfg?.subTenantId ?? DEFAULTS.subTenantId,
		})

		const ignoreTerm = await promptText(rl, "Ignore Term", {
			default: cfg?.ignoreTerm ?? DEFAULTS.ignoreTerm,
		})

		const result: WizardResult = { apiKey, tenantId, subTenantId, ignoreTerm }
		const configObj = buildConfigObj(result)

		// ── Summary ──

		printSection("Summary")

		console.log(`  ${c.dim}┌${"─".repeat(50)}${c.reset}`)
		printSummaryRow("API Key", apiKey, true)
		printSummaryRow("Tenant ID", tenantId)
		printSummaryRow("Sub-Tenant ID", subTenantId)
		printSummaryRow("Ignore Term", ignoreTerm)
		console.log(`  ${c.dim}└${"─".repeat(50)}${c.reset}`)

		// ── Persist config ──

		const saved = await promptBool(rl, `Write config to ${OPENCLAW_CONFIG_PATH}?`, true)

		if (saved && persistConfig(configObj)) {
			printSuccess("Config saved! Restart the gateway (`openclaw gateway restart`) to apply.")
		} else if (saved) {
			console.log(`  ${c.red}Failed to write config. Add manually:${c.reset}`)
			console.log()
			for (const line of JSON.stringify(configObj, null, 2).split("\n")) {
				console.log(`    ${c.cyan}${line}${c.reset}`)
			}
		} else {
			console.log()
			console.log(`  ${c.yellow}${c.bold}Add to openclaw.json plugins.entries.openclaw.config:${c.reset}`)
			console.log()
			for (const line of JSON.stringify(configObj, null, 2).split("\n")) {
				console.log(`    ${c.cyan}${line}${c.reset}`)
			}
		}

		console.log()
		console.log(`  ${c.dim}Run \`hydra onboard --advanced\` to fine-tune all options.${c.reset}`)
	} finally {
		rl.close()
	}
}

async function runAdvancedWizard(cfg?: HydraPluginConfig): Promise<void> {
	const rl = createRl()

	try {
		printBanner()
		console.log(`  ${c.dim}Full configuration wizard — customise every option.${c.reset}`)
		console.log(`  ${c.dim}Press Enter to accept defaults shown in parentheses.${c.reset}`)

		printSection("Credentials")

		const apiKey = await promptText(rl, "API Key", {
			required: true,
			secret: true,
		})

		const tenantId = await promptText(rl, "Tenant ID", {
			required: true,
		})

		const subTenantId = await promptText(rl, "Sub-Tenant ID", {
			default: cfg?.subTenantId ?? DEFAULTS.subTenantId,
		})

		printSection("Behaviour")

		const autoRecall = await promptBool(rl, "Enable Auto-Recall?", cfg?.autoRecall ?? DEFAULTS.autoRecall)
		const autoCapture = await promptBool(rl, "Enable Auto-Capture?", cfg?.autoCapture ?? DEFAULTS.autoCapture)
		const ignoreTerm = await promptText(rl, "Ignore Term", {
			default: cfg?.ignoreTerm ?? DEFAULTS.ignoreTerm,
		})

		printSection("Recall Settings")

		const maxRecallResults = await promptNumber(
			rl, "Max Recall Results", cfg?.maxRecallResults ?? DEFAULTS.maxRecallResults, 1, 50,
		)
		const recallMode = await promptChoice(
			rl, "Recall Mode", ["fast", "thinking"], cfg?.recallMode ?? DEFAULTS.recallMode,
		) as "fast" | "thinking"
		const graphContext = await promptBool(rl, "Enable Graph Context?", cfg?.graphContext ?? DEFAULTS.graphContext)

		printSection("Debug")

		const debug = await promptBool(rl, "Enable Debug Logging?", cfg?.debug ?? DEFAULTS.debug)

		const result: WizardResult = {
			apiKey,
			tenantId,
			subTenantId,
			ignoreTerm,
			autoRecall,
			autoCapture,
			maxRecallResults,
			recallMode,
			graphContext,
			debug,
		}

		// ── Summary ──

		printSection("Summary")

		console.log(`  ${c.dim}┌${"─".repeat(50)}${c.reset}`)
		printSummaryRow("API Key", apiKey, true)
		printSummaryRow("Tenant ID", tenantId)
		printSummaryRow("Sub-Tenant ID", subTenantId)
		printSummaryRow("Auto-Recall", String(autoRecall))
		printSummaryRow("Auto-Capture", String(autoCapture))
		printSummaryRow("Ignore Term", ignoreTerm)
		printSummaryRow("Max Results", String(maxRecallResults))
		printSummaryRow("Recall Mode", recallMode)
		printSummaryRow("Graph Context", String(graphContext))
		printSummaryRow("Debug", String(debug))
		console.log(`  ${c.dim}└${"─".repeat(50)}${c.reset}`)

		// ── Persist config ──

		const configObj = buildConfigObj(result)
		const saved = await promptBool(rl, `Write config to ${OPENCLAW_CONFIG_PATH}?`, true)

		if (saved && persistConfig(configObj)) {
			printSuccess("Config saved! Restart the gateway (`openclaw gateway restart`) to apply.")
		} else if (saved) {
			console.log(`  ${c.red}Failed to write config. Add manually:${c.reset}`)
			console.log()
			for (const line of JSON.stringify(configObj, null, 2).split("\n")) {
				console.log(`    ${c.cyan}${line}${c.reset}`)
			}
		} else {
			console.log()
			console.log(`  ${c.yellow}${c.bold}Add to openclaw.json plugins.entries.openclaw.config:${c.reset}`)
			console.log()
			for (const line of JSON.stringify(configObj, null, 2).split("\n")) {
				console.log(`    ${c.cyan}${line}${c.reset}`)
			}
		}
	} finally {
		rl.close()
	}
}

// ── Registration (CLI + Slash) ──

export function registerOnboardingCli(
	cfg?: HydraPluginConfig,
	// When set, this registrar is attached under the deprecated `hydra` root, so
	// invoking `hydra onboard` emits the same one-time deprecation warning as the
	// other legacy CLI verbs (CONTRACT §3), pointing at `<replacement> onboard`.
	opts?: { deprecatedReplacement?: string },
): (root: any) => void {
	return (root: any) => {
		root
			.command("onboard")
			.description("Interactive Hydra DB onboarding wizard")
			.option("--advanced", "Configure all options (credentials, behaviour, recall, debug)")
			.action(async (cmdOpts: { advanced?: boolean }) => {
				if (opts?.deprecatedReplacement) {
					warnDeprecated(
						"CLI command",
						"hydra onboard",
						`${opts.deprecatedReplacement} onboard`,
					)
				}
				if (cmdOpts.advanced) {
					await runAdvancedWizard(cfg)
				} else {
					await runBasicWizard(cfg)
				}
			})
	}
}

export function registerOnboardingSlashCommands(
	api: OpenClawPluginApi,
	client: HydraClient,
	cfg: HydraPluginConfig,
): void {
	api.registerCommand({
		name: "hydra-onboard",
		description: "Show Hydra plugin config status (run `hydra onboard` in CLI for interactive wizard)",
		acceptsArgs: false,
		requireAuth: false,
		handler: async () => {
			try {
				const lines: string[] = [
					"=== Hydra DB — Current Config ===",
					"",
					`  API Key:       ${cfg.apiKey ? `${mask(cfg.apiKey)} ✓` : "NOT SET ✗"}`,
					`  Tenant ID:     ${cfg.tenantId ? `${mask(cfg.tenantId, 8)} ✓` : "NOT SET ✗"}`,
					`  Sub-Tenant:    ${client.getSubTenantId()}`,
					`  Ignore Term:   ${cfg.ignoreTerm}`,
					`  Auto-Recall:   ${cfg.autoRecall}`,
					`  Auto-Capture:  ${cfg.autoCapture}`,
					`  Recall Mode:   ${cfg.recallMode}`,
					`  Graph Context: ${cfg.graphContext}`,
					`  Max Results:   ${cfg.maxRecallResults}`,
					`  Debug:         ${cfg.debug}`,
					"",
					"Tip: Run `hydra onboard` in the CLI for an interactive configuration wizard,",
					"     or `hydra onboard --advanced` for all options.",
				]
				return { text: lines.join("\n") }
			} catch (err) {
				log.error("/hydra-onboard", err)
				return { text: "Failed to show status. Check logs." }
			}
		},
	})
}
