import {
	toAddMemoryResponse,
	toDeleteMemoryResponse,
	toFetchContentResponse,
	toListMemoriesResponse,
	toListSourcesResponse,
	toRecallResponse,
} from "./adapters.ts"
import { HydraDB, HydraWrapperError } from "./hydra/index.ts"
import type { ContextKind, Layout } from "./hydra/index.ts"
import { log } from "./log.ts"
import type {
	AddMemoryResponse,
	ConversationTurn,
	DeleteMemoryResponse,
	FetchContentResponse,
	ListMemoriesResponse,
	ListSourcesResponse,
	RecallResponse,
} from "./types/hydra.ts"

/**
 * OpenClaw's host-behaviour layer over the portable HydraDB wrapper (hydra/).
 *
 * PRO-1298: this class KEEPS its v1 public surface (`recall`, `ingestText`,
 * `ingestConversation`, `listMemories`, `listSources`, `deleteMemory`,
 * `fetchContent`, `getTenantId`, `getSubTenantId`) so every caller — the agent
 * tools, slash commands, CLI and both hooks — is repointed at the wrapper
 * WITHOUT touching a single call site. The transport underneath changed from the
 * hand-rolled v1 `fetch` client to `@hydradb/sdk` via the wrapper; the behaviour
 * (injected defaults, ingest instructions, response shapes, error regimes) did
 * not. See CONTRACT.md §2 rule 5.
 */

const INGEST_INSTRUCTIONS =
	"Focus on extracting user preferences, habits, opinions, likes, dislikes, " +
	"goals, and recurring themes. Capture any stated or implied personal context " +
	"that would help personalise future interactions. Capture important personal details like " +
	"name, age, email ids, phone numbers, etc. along with the original name and context " +
	"so that it can be used to personalise future interactions."

/** How the plugin decides which corpus kind to send (PRO-1618). */
export type LayoutSetting = Layout | "auto"

export class HydraClient {
	private tenantId: string
	private subTenantId: string
	private hydra: HydraDB
	private layoutSetting: LayoutSetting
	private kindPromise?: Promise<ContextKind>

	constructor(
		apiKey: string,
		tenantId: string,
		subTenantId: string,
		baseUrl?: string,
		// Test seam: inject a pre-built wrapper (e.g. over a mocked SDK transport).
		hydra?: HydraDB,
		// `auto` reads the database's layout once; `split`/`unified` pin it.
		layout: LayoutSetting = "auto",
	) {
		this.tenantId = tenantId
		this.subTenantId = subTenantId
		this.layoutSetting = layout
		this.hydra =
			hydra ??
			new HydraDB({
				token: apiKey,
				database: tenantId,
				collection: subTenantId,
				...(baseUrl != null ? { baseUrl } : {}),
			})
		log.info(`connected (tenant=${tenantId}, sub=${subTenantId})`)
	}

	/**
	 * The kind every call sends (PRO-1618). A unified database refuses
	 * `memory`, so on one the plugin sends `unified`; on a split database
	 * (every database created before) it keeps sending `memory`, exactly as
	 * before. Resolved once per process; a failed probe reads as split.
	 */
	private kind(): Promise<ContextKind> {
		if (!this.kindPromise) {
			this.kindPromise =
				this.layoutSetting === "auto"
					? Promise.resolve()
							// Deferred so a wrapper without a databases resource (a
							// test seam) resolves to the split default instead of
							// throwing synchronously out of the first call.
							.then(() => this.hydra.databases.layout(this.tenantId))
							.then((layout): ContextKind => (layout === "unified" ? "unified" : "memory"))
							.catch((): ContextKind => "memory")
					: Promise.resolve<ContextKind>(this.layoutSetting === "unified" ? "unified" : "memory")
		}
		return this.kindPromise
	}

	/**
	 * Run one call with the resolved kind. If the kind came from a probe that
	 * could not tell (it failed, or the database was not in the list it saw)
	 * and the server answers with the rule ("type 'memory' is not valid on a
	 * unified database"), that answer IS the layout: pin it and retry once as
	 * `unified`. A pinned `layout` setting is never second-guessed.
	 */
	private async withKind<T>(run: (kind: ContextKind) => Promise<T>): Promise<T> {
		const kind = await this.kind()
		try {
			return await run(kind)
		} catch (err) {
			const refused =
				err instanceof HydraWrapperError && err.status === 400 && /unified database/i.test(err.message)
			if (refused && kind !== "unified" && this.layoutSetting === "auto") {
				log.warn("[hydra] the database is unified; switching every call to kind unified")
				this.kindPromise = Promise.resolve<ContextKind>("unified")
				return run("unified")
			}
			throw err
		}
	}

	// --- Ingest ---

	async ingestConversation(
		turns: ConversationTurn[],
		sourceId: string,
		opts?: {
			userName?: string
			metadata?: Record<string, unknown>
		},
	): Promise<AddMemoryResponse> {
		const data = await this.withKind((kind) => this.hydra.context.ingest({
			kind,
			pairs: turns,
			infer: true,
			sourceId,
			userName: opts?.userName ?? "User",
			customInstructions: INGEST_INSTRUCTIONS,
			upsert: true,
			...(opts?.metadata && {
				documentMetadata: JSON.stringify(opts.metadata),
			}),
		}))
		return toAddMemoryResponse(data)
	}

	async ingestText(
		text: string,
		opts?: {
			sourceId?: string
			title?: string
			infer?: boolean
			isMarkdown?: boolean
			customInstructions?: string
		},
	): Promise<AddMemoryResponse> {
		const shouldInfer = opts?.infer ?? true
		const data = await this.withKind((kind) => this.hydra.context.ingest({
			kind,
			text,
			infer: shouldInfer,
			isMarkdown: opts?.isMarkdown ?? false,
			...(shouldInfer && {
				customInstructions: opts?.customInstructions ?? INGEST_INSTRUCTIONS,
			}),
			...(opts?.sourceId && { sourceId: opts.sourceId }),
			...(opts?.title && { title: opts.title }),
			upsert: true,
		}))
		return toAddMemoryResponse(data)
	}

	// --- Recall ---

	async recall(
		query: string,
		opts?: {
			maxResults?: number
			mode?: "fast" | "thinking"
			graphContext?: boolean
			recencyBias?: number
		},
	): Promise<RecallResponse> {
		const data = await this.withKind((kind) => this.hydra.context.query({
			query,
			kind,
			maxResults: opts?.maxResults ?? 10,
			mode: opts?.mode ?? "thinking",
			alpha: 0.8,
			recencyBias: opts?.recencyBias ?? 0,
			graphContext: opts?.graphContext ?? true,
		}))
		return toRecallResponse(data)
	}

	// --- List ---

	async listMemories(): Promise<ListMemoriesResponse> {
		const data = await this.withKind((kind) => this.hydra.context.list({ kind }))
		return toListMemoriesResponse(data)
	}

	async listSources(sourceIds?: string[]): Promise<ListSourcesResponse> {
		const data = await this.hydra.context.list({
			kind: "knowledge",
			...(sourceIds && { ids: sourceIds }),
		})
		return toListSourcesResponse(data)
	}

	// --- Delete ---

	async deleteMemory(memoryId: string): Promise<DeleteMemoryResponse> {
		const data = await this.withKind((kind) => this.hydra.context.delete({
			ids: [memoryId],
			kind,
		}))
		return toDeleteMemoryResponse(data)
	}

	// --- Fetch Content ---

	async fetchContent(
		sourceId: string,
		mode: "content" | "url" | "both" = "content",
	): Promise<FetchContentResponse> {
		const data = await this.hydra.context.inspect({
			id: sourceId,
			mode,
		})
		return toFetchContentResponse(data)
	}

	// --- Accessors ---

	getTenantId(): string {
		return this.tenantId
	}

	getSubTenantId(): string {
		return this.subTenantId
	}
}
