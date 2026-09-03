/**
 * A minimal JSON transport for the v2 calls the pinned SDK cannot make yet
 * (PRO-1618): `items` on `POST /context/ingest`, `type` on `POST /databases`,
 * and the `GET /databases` layout probe. The generated client appends only the
 * multipart fields it knows and strips unknown JSON keys, so until the SDK is
 * regenerated these go over the wire by hand, through the same envelope unwrap
 * and error translation as everything else. Ported from the MCP wrapper.
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

	/** Same retry tolerance the SDK gives every call: 429/5xx and network failures, short backoff. */
	async request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
		let lastErr: unknown
		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			try {
				return await this.once<T>(method, path, body)
			} catch (err) {
				lastErr = err
				const retryable =
					err instanceof HydraWrapperError && (err.status == null || RETRY_STATUSES.has(err.status))
				if (!retryable || attempt === this.maxRetries) throw err
				await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** attempt, 2000)))
			}
		}
		throw lastErr
	}

	private async once<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
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
				throw new HydraWrapperError(`Hydra DB ${path} → ${response.status}: ${detail}`, path, {
					status: response.status,
					body: parsed,
				})
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
			throw new HydraWrapperError(`Hydra DB ${path} → ERR: ${reason}`, path, { cause: err })
		} finally {
			clearTimeout(timer)
		}
	}
}
