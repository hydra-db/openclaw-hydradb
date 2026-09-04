/**
 * Error translation for the HydraDB wrapper.
 *
 * The wrapper is the firewall between the generated `@hydradb/sdk` and the host
 * (this OpenClaw plugin). SDK calls throw `HydraDBError` subclasses; we catch
 * those and re-throw a `HydraWrapperError` whose `message` reproduces the exact
 * template the hand-rolled v1 client used:
 *
 *     Hydra ${path} → ${status}: ${body}
 *
 * NOTE — this template is byte-for-byte OpenClaw's OWN v1 message (`Hydra …`,
 * see the old `client.ts`), NOT the MCP wrapper's `Hydra DB …`. Preserving
 * OpenClaw's exact spelling keeps the model-visible error text unchanged for the
 * one regime that sees it: agent tools propagate the error, so its `.message`
 * reaches the model. (Slash/CLI catch-and-genericise; hooks swallow silently —
 * neither surfaces this text.) The `path`/`status`/`body` values naturally
 * reflect the v2 endpoint now being called; changing the template text itself is
 * a separate, later, deliberate step.
 *
 * Structure mirrors the MCP wrapper (hydradb-mcp PR #36) per CONTRACT.md §2 rule 4.
 */

import { HydraDBError } from "@hydradb/sdk"

export class HydraWrapperError extends Error {
	/** Logical endpoint path the failing call targeted (e.g. `/query`). */
	readonly path: string
	/** HTTP status code, when the failure carried one. */
	readonly status?: number
	/** Parsed error body from the SDK, preserved for programmatic handling. */
	readonly body?: unknown
	/** The original SDK error, preserved as the cause. */
	readonly cause?: unknown

	constructor(
		message: string,
		path: string,
		opts?: { status?: number; body?: unknown; cause?: unknown },
	) {
		super(message)
		this.name = "HydraWrapperError"
		this.path = path
		this.status = opts?.status
		this.body = opts?.body
		this.cause = opts?.cause
		Object.setPrototypeOf(this, HydraWrapperError.prototype)
	}
}

/**
 * PRO-1618: the server's machine-readable code for "you sent a split-era `type`
 * to a unified database". Preferred over the message text, which is worded
 * differently depending on which validator refuses.
 */
export const UNIFIED_LAYOUT_ERROR_CODE = "UNIFIED_DATABASE"

/**
 * The message fallback, for a server that does not send the code yet. It has to
 * cover BOTH phrasings:
 *
 *   corpus type validator: `type "memory" is not valid on a unified database: …`
 *   ingest body validator: `this database is unified: send the content as …`
 *
 * and must NOT match the mirror-image refusals, which name a unified database
 * while telling you the database is SPLIT (`type "unified" is only valid on a
 * unified database…`). Retrying one of those as unified turns a clear 400 into
 * a second, more confusing one.
 */
const UNIFIED_LAYOUT_REFUSAL_RE = /is not valid on a unified database|this database is unified/i

function errorCodeOf(body: unknown): string | undefined {
	if (!body || typeof body !== "object") return undefined
	const record = body as Record<string, unknown>
	const nested = record.error as Record<string, unknown> | undefined
	const code = nested?.code ?? record.code ?? record.error_code
	return typeof code === "string" && code !== "" ? code : undefined
}

/** Whether an error is the server refusing a split-era `type` on a unified database. */
export function isUnifiedLayoutRefusal(err: HydraWrapperError): boolean {
	if (err.status !== 400) return false
	if (errorCodeOf(err.body) === UNIFIED_LAYOUT_ERROR_CODE) return true
	return UNIFIED_LAYOUT_REFUSAL_RE.test(err.message)
}

function bodyToString(body: unknown): string {
	if (body == null) return ""
	if (typeof body === "string") return body
	try {
		return JSON.stringify(body)
	} catch {
		return String(body)
	}
}

/**
 * Translate any error thrown by an SDK call into a `HydraWrapperError` carrying
 * the byte-identical `Hydra ${path} → ${status}: ${body}` message.
 */
export function translateError(path: string, err: unknown): HydraWrapperError {
	// Already ours (the raw v2 transport builds these with status and body):
	// re-wrapping would drop exactly the fields a caller branches on.
	if (err instanceof HydraWrapperError) return err
	if (err instanceof HydraDBError) {
		const status = err.statusCode
		const statusText = status != null ? String(status) : "ERR"
		return new HydraWrapperError(
			`Hydra ${path} → ${statusText}: ${bodyToString(err.body)}`,
			path,
			{ status, body: err.body, cause: err },
		)
	}

	// Non-SDK failure (network error, aborted request, unexpected throw).
	const message = err instanceof Error ? err.message : String(err)
	return new HydraWrapperError(`Hydra ${path} → ERR: ${message}`, path, {
		cause: err,
	})
}
