export type HydraPluginConfig = {
	apiKey: string
	tenantId: string
	subTenantId: string
	baseUrl?: string
	autoRecall: boolean
	autoCapture: boolean
	maxRecallResults: number
	recallMode: "fast" | "thinking"
	graphContext: boolean
	ignoreTerm: string
	debug: boolean
	/**
	 * Storage layout of the configured database (PRO-1618). `auto` (default)
	 * reads it from `GET /databases` once; `split`/`unified` pin it.
	 */
	layout: "split" | "unified" | "auto"
}

const KNOWN_KEYS = new Set([
	"apiKey",
	"tenantId",
	"subTenantId",
	"autoRecall",
	"autoCapture",
	"maxRecallResults",
	"recallMode",
	"graphContext",
	"ignoreTerm",
	"debug",
	"layout",
])

const DEFAULT_SUB_TENANT = "hydra-openclaw-plugin"
const DEFAULT_IGNORE_TERM = "hydra-ignore"

function envOrNull(name: string): string | undefined {
	return typeof process !== "undefined" ? process.env[name] : undefined
}

// ── Environment variable aliasing (CONTRACT.md §1) ──
//
// Canonical prefix is `HYDRADB_`. OpenClaw additionally reads ONLY its own
// historical `HYDRA_OPENCLAW_` prefix (per-client scoping: a client never reads
// another client's legacy spelling). The canonical name wins if both are set; a
// deprecated alias is honoured but emits exactly one stderr warning per process
// naming its canonical replacement.

const warnedEnvAliases = new Set<string>()

function warnEnvAlias(deprecated: string, canonical: string): void {
	if (warnedEnvAliases.has(deprecated)) return
	warnedEnvAliases.add(deprecated)
	console.error(
		`[hydra-db] The environment variable ${deprecated} is deprecated; use ${canonical} instead.`,
	)
}

/** Read the canonical env var, falling back to OpenClaw's deprecated alias(es) with a one-time warning. */
function envWithAliases(canonical: string, deprecated: string[]): string | undefined {
	const canon = envOrNull(canonical)
	if (canon) return canon
	for (const dep of deprecated) {
		const value = envOrNull(dep)
		if (value) {
			warnEnvAlias(dep, canonical)
			return value
		}
	}
	return undefined
}

function resolveEnvVars(value: string): string {
	return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
		const val = envOrNull(name)
		if (!val) throw new Error(`Environment variable ${name} is not set`)
		return val
	})
}

export function parseConfig(raw: unknown): HydraPluginConfig {
	const cfg =
		raw && typeof raw === "object" && !Array.isArray(raw)
			? (raw as Record<string, unknown>)
			: {}

	const unknown = Object.keys(cfg).filter((k) => !KNOWN_KEYS.has(k))
	if (unknown.length > 0) {
		throw new Error(`hydra-db: unrecognized config keys: ${unknown.join(", ")}`)
	}

	const apiKey =
		typeof cfg.apiKey === "string" && cfg.apiKey.length > 0
			? resolveEnvVars(cfg.apiKey)
			: envWithAliases("HYDRADB_API_KEY", ["HYDRA_OPENCLAW_API_KEY"])

	if (!apiKey) {
		throw new Error(
			"hydra-db: apiKey is required — set it in plugin config or via the HYDRADB_API_KEY env var",
		)
	}

	const tenantId =
		typeof cfg.tenantId === "string" && cfg.tenantId.length > 0
			? resolveEnvVars(cfg.tenantId)
			: envWithAliases("HYDRADB_DATABASE", ["HYDRA_OPENCLAW_TENANT_ID"])

	if (!tenantId) {
		throw new Error(
			"hydra-db: tenantId is required — set it in plugin config or via the HYDRADB_DATABASE env var",
		)
	}

	const subTenantId =
		typeof cfg.subTenantId === "string" && cfg.subTenantId.length > 0
			? cfg.subTenantId
			: (envWithAliases("HYDRADB_COLLECTION", []) ?? DEFAULT_SUB_TENANT)

	// Base URL is canonical-only: OpenClaw never shipped a legacy base-url env,
	// and the SDK defaults to https://api.hydradb.com (the v1 endpoint) when unset.
	const baseUrl = envWithAliases("HYDRADB_BASE_URL", [])

	return {
		apiKey,
		tenantId,
		subTenantId,
		...(baseUrl ? { baseUrl } : {}),
		autoRecall: (cfg.autoRecall as boolean) ?? true,
		autoCapture: (cfg.autoCapture as boolean) ?? true,
		maxRecallResults: (cfg.maxRecallResults as number) ?? 10,
		recallMode:
			cfg.recallMode === "thinking"
				? ("thinking" as const)
				: ("fast" as const),
		graphContext: (cfg.graphContext as boolean) ?? true,
		ignoreTerm:
			typeof cfg.ignoreTerm === "string" && cfg.ignoreTerm.length > 0
				? cfg.ignoreTerm
				: DEFAULT_IGNORE_TERM,
		debug: (cfg.debug as boolean) ?? false,
		layout: parseLayout(cfg.layout),
	}
}

function parseLayout(value: unknown): "split" | "unified" | "auto" {
	if (value === undefined) return "auto"
	if (value === "split" || value === "unified" || value === "auto") return value
	throw new Error(`hydra-db: layout must be "split", "unified" or "auto"`)
}

export function tryParseConfig(raw: unknown): HydraPluginConfig | null {
	try {
		return parseConfig(raw)
	} catch {
		return null
	}
}

/**
 * Permissive schema parse — validates key names but does NOT require credentials.
 * This lets the plugin load so the onboarding wizard can run.
 */
function parseConfigSoft(raw: unknown): Record<string, unknown> {
	const cfg =
		raw && typeof raw === "object" && !Array.isArray(raw)
			? (raw as Record<string, unknown>)
			: {}

	const unknown = Object.keys(cfg).filter((k) => !KNOWN_KEYS.has(k))
	if (unknown.length > 0) {
		throw new Error(`hydra-db: unrecognized config keys: ${unknown.join(", ")}`)
	}

	return cfg
}

export const hydraConfigSchema = {
	parse: parseConfigSoft,
}
