/**
 * A minimal JSON transport for the v2 calls the pinned SDK cannot make yet
 * (PRO-1618): `items` on `POST /context/ingest`, `type` on `POST /databases`,
 * and the `GET /databases` layout probe. The generated client appends only the
 * multipart fields it knows and strips unknown JSON keys, so until the SDK is
 * regenerated these go over the wire by hand, through the same envelope unwrap
 * and error translation as everything else. Ported from the MCP wrapper.
 *
 * One thing does NOT come across from that port: the error prefix. The MCP
 * wrapper says `Hydra DB …`; OpenClaw's contract is `Hydra ${path} → …`, the
 * byte-identical v1 text (see ./errors.ts). `translateError` returns a
 * HydraWrapperError untouched, so anything built here reaches an agent tool —
 * and therefore the model — exactly as written. Build errors with the OpenClaw
 * template, never the MCP one.
 */

import { unwrap } from "./envelope.ts"
import { HydraWrapperError } from "./errors.ts"

const DEFAULT_BASE_URL = "https://api.hydradb.com"

/** Storage layout of a database (PRO-1618): fixed at creation, never changed. */
export type Layout = "split" | "unified"

export interface RawConfig {
	token: string
	baseUrl?: string
	timeoutMs?: number
	/** Retries on 429/5xx and network failures, matching the SDK's budget. */
	maxRetries?: number
	/** Test seam: a fetch that answers without a network. */
	fetch?: typeof fetch
}

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504])

/**
 * Writes whose outcome cannot be inferred from a failure that carried NO HTTP
 * status — a 30s `AbortError` timeout, a dropped socket. The request may well
 * have been applied server-side, and re-sending it creates a second copy rather
 * than replacing the first: `ingestMemory` without a caller `sourceId` sends no
 * `context_id`, so an upsert has nothing to key on.
 *
 * Two costs, one fix. Re-sending a POST that timed out at 30s spends up to 90s
 * inside a hook budget the host will not wait for (hydradb-claude-code caps
 * retries at zero outright for exactly this reason), and it duplicates context.
 * So: a status-carrying failure on these paths still retries when the status
 * says the server declined before doing work; a status-LESS failure never does.
 * Reads (`/query`, `/context/list`, `GET /databases`) keep the full budget —
 * replaying one costs nothing but time.
 */
const REPLAY_UNSAFE_WRITES = new Set(["/context/ingest", "/databases"])

function isReplayUnsafe(method: string, operationPath: string): boolean {
	return method === "POST" && REPLAY_UNSAFE_WRITES.has(operationPath)
}

/**
 * The stable OPERATION path behind a request URL — `/context/relations` for
 * `/context/relations?database=…&id=…`.
 *
 * A GET carries its scope in the query string, so the URL a caller hands the
 * transport varies per request: database, collection, item id, cursor. That URL
 * is fine to SEND and wrong to keep, for two reasons:
 *
 *   - it lands in `HydraWrapperError.path` and in the message, both of which
 *     reach an agent tool and therefore the model, exposing the caller's scope
 *     and ids in what should be a diagnostic
 *   - `path` is the field the error contract is keyed on, and a value that
 *     varies per request cannot be matched on, so anything branching on it
 *     silently stops working for exactly the unified GET calls
 *
 * Deriving it here rather than asking each call site to pass it means a caller
 * that builds a URL cannot leak one by forgetting.
 */
function operationPathOf(path: string): string {
	const queryStart = path.indexOf("?")
	return queryStart === -1 ? path : path.slice(0, queryStart)
}

export class RawHttp {
	private readonly baseUrl: string
	private readonly timeoutMs: number
	private readonly fetchImpl: typeof fetch
	private readonly maxRetries: number

	constructor(private readonly config: RawConfig) {
		this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
		this.timeoutMs = config.timeoutMs ?? 30_000
		this.fetchImpl = config.fetch ?? fetch
		this.maxRetries = config.maxRetries ?? 2
	}

	/**
	 * The SDK's retry tolerance — 429/5xx and network failures, short backoff —
	 * with one carve-out: a failure that carried no status is NOT retried for a
	 * write that cannot be safely replayed. See REPLAY_UNSAFE_WRITES.
	 */
	async request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
		// `path` is the URL to send; `operationPath` is the stable half of it —
		// the only one that may reach an error, or be matched on.
		const operationPath = operationPathOf(path)
		let lastErr: unknown
		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			try {
				return await this.once<T>(method, path, body, operationPath)
			} catch (err) {
				lastErr = err
				const retryable =
					err instanceof HydraWrapperError &&
					(err.status == null
						? !isReplayUnsafe(method, operationPath)
						: RETRY_STATUSES.has(err.status))
				if (!retryable || attempt === this.maxRetries) throw err
				await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** attempt, 2000)))
			}
		}
		throw lastErr
	}

	private async once<T>(
		method: "GET" | "POST" | "DELETE",
		path: string,
		body: unknown,
		operationPath: string,
	): Promise<T> {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), this.timeoutMs)
		try {
			const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${this.config.token}`,
					"Content-Type": "application/json",
					// CONTRACT §2 rule 6: every v2 call names its version.
					"API-Version": "2",
				},
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
				signal: controller.signal,
			})
			const text = await response.text()
			let parsed: unknown
			try {
				parsed = text === "" ? null : JSON.parse(text)
			} catch {
				parsed = text
			}
			if (!response.ok) {
				const detail =
					parsed && typeof parsed === "object"
						? JSON.stringify(parsed)
						: String(parsed ?? "")
				throw new HydraWrapperError(
					`Hydra ${operationPath} → ${response.status}: ${detail}`,
					operationPath,
					{ status: response.status, body: parsed },
				)
			}
			return unwrap<T>(parsed)
		} catch (err) {
			if (err instanceof HydraWrapperError) throw err
			const reason =
				err instanceof Error && err.name === "AbortError"
					? `timed out after ${this.timeoutMs}ms`
					: err instanceof Error
						? err.message
						: String(err)
			throw new HydraWrapperError(`Hydra ${operationPath} → ERR: ${reason}`, operationPath, {
				cause: err,
			})
		} finally {
			clearTimeout(timer)
		}
	}
}
