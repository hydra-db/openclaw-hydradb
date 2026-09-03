// adapters.ts
function toScoredPath(path2) {
  return {
    // Triplet innards are already raw snake_case (untyped in the SDK schema).
    triplets: path2.triplets ?? [],
    relevancy_score: path2.relevancyScore ?? 0,
    combined_context: path2.combinedContext ?? null,
    group_id: path2.groupId ?? null
  };
}
function toVectorChunk(chunk) {
  return {
    chunk_uuid: chunk.chunkUuid ?? "",
    source_id: chunk.id ?? "",
    chunk_content: chunk.chunkContent ?? "",
    source_title: chunk.sourceTitle,
    source_type: chunk.sourceType,
    source_upload_time: chunk.sourceUploadTime,
    source_last_updated_time: chunk.sourceLastUpdatedTime,
    relevancy_score: chunk.relevancyScore ?? null,
    document_metadata: chunk.additionalMetadata ?? null,
    tenant_metadata: chunk.metadata ?? null,
    extra_context_ids: chunk.extraContextIds ?? null,
    layout: chunk.layout ?? null
  };
}
function toRecallResponse(data) {
  const graph = data.graphContext;
  const additional = {};
  for (const [id, chunk] of Object.entries(data.additionalContext ?? {})) {
    additional[id] = toVectorChunk(chunk);
  }
  return {
    chunks: (data.chunks ?? []).map(toVectorChunk),
    graph_context: graph ? {
      query_paths: (graph.queryPaths ?? []).map(toScoredPath),
      chunk_relations: (graph.chunkRelations ?? []).map(toScoredPath),
      chunk_id_to_group_ids: graph.chunkIdToGroupIds ?? {}
    } : void 0,
    additional_context: additional
  };
}
function toAddMemoryResponse(data) {
  const d = data;
  const num = (...keys) => {
    for (const key of keys) {
      if (typeof d[key] === "number") return d[key];
    }
    return 0;
  };
  return {
    success: data.success ?? false,
    message: data.message ?? "",
    results: [],
    success_count: num("successCount", "success_count"),
    failed_count: num("failedCount", "failed_count")
  };
}
function str(record, ...keys) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return void 0;
}
function asRecords(value) {
  return Array.isArray(value) ? value : void 0;
}
function toListMemoriesResponse(data) {
  const d = data;
  const inner = d.inner;
  const records = asRecords(d.user_memories) ?? asRecords(inner?.user_memories) ?? asRecords(d.sources) ?? asRecords(inner?.sources) ?? [];
  return {
    success: true,
    user_memories: records.map((record) => ({
      memory_id: str(record, "memory_id", "id", "source_id") ?? "",
      memory_content: str(record, "memory_content", "content", "text", "memory", "title", "description") ?? ""
    }))
  };
}
function toListSourcesResponse(data) {
  const d = data;
  const records = asRecords(d.sources) ?? asRecords(d.inner?.sources) ?? [];
  const sources = records.map((record) => ({
    id: str(record, "id", "source_id") ?? "",
    tenant_id: str(record, "tenant_id", "database") ?? "",
    sub_tenant_id: str(record, "sub_tenant_id", "collection") ?? "",
    title: str(record, "title"),
    type: str(record, "type", "source_type"),
    description: str(record, "description"),
    timestamp: str(record, "timestamp"),
    url: str(record, "url")
  }));
  const total = d.total ?? d.inner?.total;
  return {
    success: true,
    sources,
    total: typeof total === "number" ? total : sources.length
  };
}
function toDeleteMemoryResponse(data) {
  const deleted = (data.userMemoryDeleted ?? 0) > 0 || (data.deletedCount ?? 0) > 0;
  return {
    success: data.success ?? deleted,
    user_memory_deleted: deleted
  };
}
function toFetchContentResponse(data) {
  return {
    success: data.success ?? false,
    source_id: data.id ?? "",
    content: data.content ?? null,
    content_base64: data.contentBase64 ?? null,
    presigned_url: data.presignedUrl ?? null,
    content_type: data.contentType ?? null,
    size_bytes: data.sizeBytes ?? null,
    message: data.message,
    // The SDK uses "" for no-error; normalise to null so `res.error` truthiness
    // checks in the surfaces behave as they did against the v1 client.
    error: data.error ? data.error : null
  };
}

// hydra/client.ts
import { Buffer } from "node:buffer";
import { HydraDBClient, serialization } from "@hydradb/sdk";

// hydra/envelope.ts
function isEnvelope(value) {
  if (value == null || typeof value !== "object") return false;
  if (!("data" in value)) return false;
  return "success" in value || "meta" in value || "error" in value;
}
function unwrap(value) {
  if (isEnvelope(value)) {
    return value.data;
  }
  return value;
}

// hydra/errors.ts
import { HydraDBError } from "@hydradb/sdk";
var HydraWrapperError = class _HydraWrapperError extends Error {
  /** Logical endpoint path the failing call targeted (e.g. `/query`). */
  path;
  /** HTTP status code, when the failure carried one. */
  status;
  /** Parsed error body from the SDK, preserved for programmatic handling. */
  body;
  /** The original SDK error, preserved as the cause. */
  cause;
  constructor(message, path2, opts) {
    super(message);
    this.name = "HydraWrapperError";
    this.path = path2;
    this.status = opts?.status;
    this.body = opts?.body;
    this.cause = opts?.cause;
    Object.setPrototypeOf(this, _HydraWrapperError.prototype);
  }
};
function bodyToString(body) {
  if (body == null) return "";
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}
function translateError(path2, err) {
  if (err instanceof HydraWrapperError) return err;
  if (err instanceof HydraDBError) {
    const status = err.statusCode;
    const statusText = status != null ? String(status) : "ERR";
    return new HydraWrapperError(
      `Hydra ${path2} \u2192 ${statusText}: ${bodyToString(err.body)}`,
      path2,
      { status, body: err.body, cause: err }
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return new HydraWrapperError(`Hydra ${path2} \u2192 ERR: ${message}`, path2, {
    cause: err
  });
}

// hydra/raw.ts
var DEFAULT_BASE_URL = "https://api.hydradb.com";
var RETRY_STATUSES = /* @__PURE__ */ new Set([408, 429, 500, 502, 503, 504]);
var RawHttp = class {
  constructor(config) {
    this.config = config;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? 3e4;
    this.fetchImpl = config.fetch ?? fetch;
    this.maxRetries = config.maxRetries ?? 2;
  }
  config;
  baseUrl;
  timeoutMs;
  fetchImpl;
  maxRetries;
  /** Same retry tolerance the SDK gives every call: 429/5xx and network failures, short backoff. */
  async request(method, path2, body) {
    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.once(method, path2, body);
      } catch (err) {
        lastErr = err;
        const retryable = err instanceof HydraWrapperError && (err.status == null || RETRY_STATUSES.has(err.status));
        if (!retryable || attempt === this.maxRetries) throw err;
        await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** attempt, 2e3)));
      }
    }
    throw lastErr;
  }
  async once(method, path2, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path2}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          "Content-Type": "application/json",
          // CONTRACT §2 rule 6: every v2 call names its version.
          "API-Version": "2"
        },
        ...body !== void 0 ? { body: JSON.stringify(body) } : {},
        signal: controller.signal
      });
      const text = await response.text();
      let parsed;
      try {
        parsed = text === "" ? null : JSON.parse(text);
      } catch {
        parsed = text;
      }
      if (!response.ok) {
        const detail = parsed && typeof parsed === "object" ? JSON.stringify(parsed) : String(parsed ?? "");
        throw new HydraWrapperError(`Hydra DB ${path2} \u2192 ${response.status}: ${detail}`, path2, {
          status: response.status,
          body: parsed
        });
      }
      return unwrap(parsed);
    } catch (err) {
      if (err instanceof HydraWrapperError) throw err;
      const reason = err instanceof Error && err.name === "AbortError" ? `timed out after ${this.timeoutMs}ms` : err instanceof Error ? err.message : String(err);
      throw new HydraWrapperError(`Hydra DB ${path2} \u2192 ERR: ${reason}`, path2, { cause: err });
    } finally {
      clearTimeout(timer);
    }
  }
};

// hydra/client.ts
function kindToType(kind) {
  return kind;
}
var SDK_PARSE_OPTS = {
  unrecognizedObjectKeys: "passthrough",
  allowUnrecognizedUnionMembers: true,
  allowUnrecognizedEnumValues: true,
  skipValidation: true,
  breadcrumbsPrefix: ["response"]
};
function compact(record) {
  const out = {};
  for (const [k, v] of Object.entries(record)) if (v !== void 0) out[k] = v;
  return out;
}
function queryString(record) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(record)) if (v !== void 0) params.set(k, String(v));
  const encoded = params.toString();
  return encoded === "" ? "" : `?${encoded}`;
}
var Resource = class {
  constructor(sdk, database, collection) {
    this.sdk = sdk;
    this.database = database;
    this.collection = collection;
  }
  sdk;
  database;
  collection;
  /** Hand-rolled v2 transport for calls the pinned SDK cannot make; see ./raw.ts. */
  raw;
  /** @internal */
  attachRaw(raw) {
    this.raw = raw;
  }
  requireRaw(what) {
    if (!this.raw) {
      throw new Error(`${what} needs the v2 transport, which this HydraDB instance was built without`);
    }
    return this.raw;
  }
  /**
   * A raw v2 call whose wire result is run through the SDK's OWN response
   * serializer, so the caller gets the same camelCase object the SDK path
   * returns. Used for `kind: "unified"` (PRO-1618): the pinned SDK's REQUEST
   * serializers reject that enum value before anything is sent.
   */
  async rawTyped(what, method, path2, body, parse) {
    const wire = await this.requireRaw(what).request(method, path2, body);
    return parse(wire, SDK_PARSE_OPTS);
  }
  scope(override) {
    const collection = override ?? this.collection;
    return collection != null ? { database: this.database, collection } : { database: this.database };
  }
  async call(path2, fn) {
    try {
      return unwrap(await fn());
    } catch (err) {
      throw translateError(path2, err);
    }
  }
};
var ContextResource = class extends Resource {
  constructor(sdk, database, collection) {
    super(sdk, database, collection);
  }
  /** The single retrieval entry point (SDK `client.query`). */
  query(params) {
    if (params.kind === "unified") {
      return this.call(
        "/query",
        () => this.rawTyped(
          "unified query",
          "POST",
          "/query",
          compact({
            ...this.scope(params.collection),
            query: params.query,
            type: "unified",
            operator: params.operator,
            max_results: params.maxResults,
            mode: params.mode,
            graph_context: params.graphContext,
            alpha: params.alpha,
            recency_bias: params.recencyBias
          }),
          serialization.SearchV2RetrievalResult.parseOrThrow
        )
      );
    }
    return this.call(
      "/query",
      () => this.sdk.query({
        ...this.scope(params.collection),
        query: params.query,
        type: kindToType(params.kind),
        operator: params.operator,
        maxResults: params.maxResults,
        mode: params.mode,
        graphContext: params.graphContext,
        alpha: params.alpha,
        recencyBias: params.recencyBias
      })
    );
  }
  /** Ingest a memory or knowledge item (SDK `context.ingest`, multipart). */
  ingest(params) {
    if (params.kind === "unified") return this.ingestUnified(params);
    const request = {
      ...this.scope(params.collection),
      type: kindToType(params.kind)
    };
    if (params.upsert != null) {
      request.upsert = String(params.upsert);
    }
    if (params.kind === "memory") {
      const infer = params.infer ?? true;
      const item = {};
      if (params.pairs != null) item.user_assistant_pairs = params.pairs;
      if (params.text != null) item.text = params.text;
      item.infer = infer;
      item.is_markdown = params.isMarkdown ?? false;
      if (infer && params.customInstructions != null) {
        item.custom_instructions = params.customInstructions;
      }
      if (params.sourceId != null) item.source_id = params.sourceId;
      if (params.title != null) item.title = params.title;
      if (params.userName != null) item.user_name = params.userName;
      if (params.documentMetadata != null) {
        item.document_metadata = params.documentMetadata;
      }
      request.memories = JSON.stringify([item]);
    } else {
      if (params.text != null) {
        request.documents = {
          data: Buffer.from(params.text, "utf-8"),
          filename: params.filename ?? `${params.title ?? "document"}.md`,
          contentType: "text/markdown"
        };
      }
      if (params.title != null) {
        request.documentMetadata = JSON.stringify({ title: params.title });
      }
    }
    return this.call("/context/ingest", () => this.sdk.context.ingest(request));
  }
  /**
   * The unified ingest shape (PRO-1618): one `items[]` array, each item text or
   * a conversation, no corpus selector, sent as the JSON body of
   * `POST /context/ingest`. On a split database the items land in its memory
   * corpus, so a caller that has not created a unified database sees no change.
   */
  ingestUnified(params) {
    const item = {};
    if (params.text != null) item.text = params.text;
    if (params.pairs != null) {
      item.conversation = params.pairs.flatMap((turn) => [
        { role: "user", content: turn.user, ...params.userName ? { name: params.userName } : {} },
        { role: "assistant", content: turn.assistant }
      ]);
    }
    if (params.sourceId != null) item.context_id = params.sourceId;
    if (params.title != null) item.title = params.title;
    item.enrich = params.infer ?? true;
    if (item.enrich && params.customInstructions != null) {
      item.custom_instructions = params.customInstructions;
    }
    if (params.documentMetadata != null) {
      try {
        item.custom_attributes = JSON.parse(params.documentMetadata);
      } catch {
        item.custom_attributes = { document_metadata: params.documentMetadata };
      }
    }
    const body = {
      ...this.scope(params.collection),
      items: [item],
      ...params.upsert != null ? { upsert: params.upsert } : {}
    };
    return this.call(
      "/context/ingest",
      () => this.rawTyped(
        "unified ingest",
        "POST",
        "/context/ingest",
        body,
        serialization.IngestionV2SourceUploadResponse.parseOrThrow
      )
    );
  }
  /** List memories or knowledge sources (SDK `context.list`). */
  list(params = {}) {
    if (params.kind === "unified") {
      return this.call(
        "/context/list",
        () => this.rawTyped(
          "unified list",
          "POST",
          "/context/list",
          compact({
            ...this.scope(params.collection),
            type: "unified",
            ids: params.ids,
            page: params.page,
            page_size: params.pageSize
          }),
          serialization.ListV2SourceListResponse.parseOrThrow
        )
      );
    }
    return this.call(
      "/context/list",
      () => this.sdk.context.list({
        ...this.scope(params.collection),
        type: kindToType(params.kind),
        ids: params.ids,
        page: params.page,
        pageSize: params.pageSize
      })
    );
  }
  /** Fetch a source's content (SDK `context.inspect`; was "fetch content"). */
  inspect(params) {
    return this.call(
      "/context/inspect",
      () => this.sdk.context.inspect({
        ...this.scope(params.collection),
        id: params.id,
        mode: params.mode,
        expirySeconds: params.expirySeconds
      })
    );
  }
  /** Per-source indexing progress (SDK `context.status`). */
  ingestionStatus(params) {
    return this.call(
      "/context/status",
      () => this.sdk.context.status({
        ...this.scope(params.collection),
        ids: params.ids
      })
    );
  }
  /** Knowledge-graph relations (SDK `context.relations`). */
  relations(params = {}) {
    if (params.kind === "unified") {
      const scope = this.scope(params.collection);
      return this.call(
        "/context/relations",
        () => this.rawTyped(
          "unified relations",
          "GET",
          `/context/relations${queryString({
            database: scope.database,
            collection: scope.collection,
            id: params.id,
            type: "unified",
            limit: params.limit,
            cursor: params.cursor
          })}`,
          void 0,
          serialization.GraphGraphRelationsResponse.parseOrThrow
        )
      );
    }
    return this.call(
      "/context/relations",
      () => this.sdk.context.relations({
        ...this.scope(params.collection),
        id: params.id,
        type: kindToType(params.kind),
        limit: params.limit,
        cursor: params.cursor
      })
    );
  }
  /** Delete memories or knowledge sources (SDK `context.delete`). */
  delete(params) {
    if (params.kind === "unified") {
      return this.call(
        "/context",
        () => this.rawTyped(
          "unified delete",
          "DELETE",
          "/context",
          compact({ ...this.scope(params.collection), ids: params.ids, type: "unified" }),
          serialization.SourcesMemoryDeleteResponse.parseOrThrow
        )
      );
    }
    return this.call(
      "/context",
      () => this.sdk.context.delete({
        ...this.scope(params.collection),
        ids: params.ids,
        type: kindToType(params.kind)
      })
    );
  }
};
var DatabasesResource = class extends Resource {
  constructor(sdk, database, collection) {
    super(sdk, database, collection);
  }
  create(params) {
    if (params.type != null) {
      return this.call(
        "/databases",
        () => this.requireRaw("database create with a layout").request(
          "POST",
          "/databases",
          {
            database: params.database,
            type: params.type,
            ...params.databaseMetadataSchema != null ? { database_metadata_schema: params.databaseMetadataSchema } : {},
            ...params.embeddingsDimension != null ? { embeddings_dimension: params.embeddingsDimension } : {}
          }
        )
      );
    }
    return this.call(
      "/databases",
      () => this.sdk.databases.create({
        database: params.database,
        databaseMetadataSchema: params.databaseMetadataSchema,
        embeddingsDimension: params.embeddingsDimension
      })
    );
  }
  delete(database) {
    return this.call("/databases", () => this.sdk.databases.delete({ database }));
  }
  list() {
    return this.call("/databases", () => this.sdk.databases.list());
  }
  layoutCache;
  /**
   * Every database this key can see, with its storage layout (PRO-1618), from
   * `GET /databases` `details[]`. Memoised for the process: a layout is fixed
   * at creation, so it cannot go stale.
   */
  layouts() {
    if (!this.layoutCache) {
      this.layoutCache = this.requireRaw("layout probe").request("GET", "/databases").then((listed) => {
        const map = /* @__PURE__ */ new Map();
        for (const row of listed.details ?? []) {
          if (row.database) map.set(row.database, row.type === "unified" ? "unified" : "split");
        }
        return map;
      }).catch((err) => {
        this.layoutCache = void 0;
        throw err;
      });
    }
    return this.layoutCache;
  }
  /**
   * The layout of one database. Unknown, or a failed probe, reads as `split`,
   * which every database created before PRO-1618 is: the worst case is the old
   * default, never a wrong unified call.
   */
  async layout(database) {
    try {
      return (await this.layouts()).get(database) ?? "split";
    } catch {
      return "split";
    }
  }
  collections(database) {
    return this.call(
      "/databases/collections",
      () => this.sdk.databases.collections({ database })
    );
  }
  stats(database) {
    return this.call(
      "/databases/stats",
      () => this.sdk.databases.stats({ database })
    );
  }
  /** Infra provisioning readiness — renamed away from `status` (SDK `databases.status`). */
  readiness(database) {
    return this.call(
      "/databases/status",
      () => this.sdk.databases.status({ database })
    );
  }
};
var HydraDB = class {
  context;
  databases;
  constructor(config, sdk) {
    const client = sdk ?? new HydraDBClient({
      token: config.token,
      ...config.baseUrl != null ? { baseUrl: config.baseUrl } : {}
    });
    this.context = new ContextResource(client, config.database, config.collection);
    this.databases = new DatabasesResource(
      client,
      config.database,
      config.collection
    );
    const raw = new RawHttp({ token: config.token, baseUrl: config.baseUrl, fetch: config.fetch });
    this.context.attachRaw(raw);
    this.databases.attachRaw(raw);
  }
};

// log.ts
var TAG = "[hydra-db]";
var _backend = null;
var _debug = false;
var log = {
  init(backend, debug) {
    _backend = backend;
    _debug = debug;
  },
  setDebug(enabled) {
    _debug = enabled;
  },
  info(...args) {
    const msg = `${TAG} ${args.map(String).join(" ")}`;
    if (_backend) _backend.info(msg);
    else console.log(msg);
  },
  warn(...args) {
    const msg = `${TAG} ${args.map(String).join(" ")}`;
    if (_backend) _backend.warn(msg);
    else console.warn(msg);
  },
  error(...args) {
    const msg = `${TAG} ${args.map(String).join(" ")}`;
    if (_backend) _backend.error(msg);
    else console.error(msg);
  },
  debug(...args) {
    if (!_debug) return;
    const msg = `${TAG} ${args.map(String).join(" ")}`;
    if (_backend?.debug) _backend.debug(msg);
    else if (_backend) _backend.info(msg);
    else console.debug(msg);
  }
};

// client.ts
var INGEST_INSTRUCTIONS = "Focus on extracting user preferences, habits, opinions, likes, dislikes, goals, and recurring themes. Capture any stated or implied personal context that would help personalise future interactions. Capture important personal details like name, age, email ids, phone numbers, etc. along with the original name and context so that it can be used to personalise future interactions.";
var HydraClient = class {
  tenantId;
  subTenantId;
  hydra;
  layoutSetting;
  kindPromise;
  constructor(apiKey, tenantId, subTenantId, baseUrl, hydra, layout = "auto") {
    this.tenantId = tenantId;
    this.subTenantId = subTenantId;
    this.layoutSetting = layout;
    this.hydra = hydra ?? new HydraDB({
      token: apiKey,
      database: tenantId,
      collection: subTenantId,
      ...baseUrl != null ? { baseUrl } : {}
    });
    log.info(`connected (tenant=${tenantId}, sub=${subTenantId})`);
  }
  /**
   * The kind every call sends (PRO-1618). A unified database refuses
   * `memory`, so on one the plugin sends `unified`; on a split database
   * (every database created before) it keeps sending `memory`, exactly as
   * before. Resolved once per process; a failed probe reads as split.
   */
  kind() {
    if (!this.kindPromise) {
      this.kindPromise = this.layoutSetting === "auto" ? Promise.resolve().then(() => this.hydra.databases.layout(this.tenantId)).then((layout) => layout === "unified" ? "unified" : "memory").catch(() => "memory") : Promise.resolve(this.layoutSetting === "unified" ? "unified" : "memory");
    }
    return this.kindPromise;
  }
  /**
   * Run one call with the resolved kind. If the kind came from a probe that
   * could not tell (it failed, or the database was not in the list it saw)
   * and the server answers with the rule ("type 'memory' is not valid on a
   * unified database"), that answer IS the layout: pin it and retry once as
   * `unified`. A pinned `layout` setting is never second-guessed.
   */
  async withKind(run) {
    const kind = await this.kind();
    try {
      return await run(kind);
    } catch (err) {
      const refused = err instanceof HydraWrapperError && err.status === 400 && /unified database/i.test(err.message);
      if (refused && kind !== "unified" && this.layoutSetting === "auto") {
        log.warn("[hydra] the database is unified; switching every call to kind unified");
        this.kindPromise = Promise.resolve("unified");
        return run("unified");
      }
      throw err;
    }
  }
  // --- Ingest ---
  async ingestConversation(turns, sourceId, opts) {
    const data = await this.withKind((kind) => this.hydra.context.ingest({
      kind,
      pairs: turns,
      infer: true,
      sourceId,
      userName: opts?.userName ?? "User",
      customInstructions: INGEST_INSTRUCTIONS,
      upsert: true,
      ...opts?.metadata && {
        documentMetadata: JSON.stringify(opts.metadata)
      }
    }));
    return toAddMemoryResponse(data);
  }
  async ingestText(text, opts) {
    const shouldInfer = opts?.infer ?? true;
    const data = await this.withKind((kind) => this.hydra.context.ingest({
      kind,
      text,
      infer: shouldInfer,
      isMarkdown: opts?.isMarkdown ?? false,
      ...shouldInfer && {
        customInstructions: opts?.customInstructions ?? INGEST_INSTRUCTIONS
      },
      ...opts?.sourceId && { sourceId: opts.sourceId },
      ...opts?.title && { title: opts.title },
      upsert: true
    }));
    return toAddMemoryResponse(data);
  }
  // --- Recall ---
  async recall(query, opts) {
    const data = await this.withKind((kind) => this.hydra.context.query({
      query,
      kind,
      maxResults: opts?.maxResults ?? 10,
      mode: opts?.mode ?? "thinking",
      alpha: 0.8,
      recencyBias: opts?.recencyBias ?? 0,
      graphContext: opts?.graphContext ?? true
    }));
    return toRecallResponse(data);
  }
  // --- List ---
  async listMemories() {
    const data = await this.withKind((kind) => this.hydra.context.list({ kind }));
    return toListMemoriesResponse(data);
  }
  async listSources(sourceIds) {
    const data = await this.hydra.context.list({
      kind: "knowledge",
      ...sourceIds && { ids: sourceIds }
    });
    return toListSourcesResponse(data);
  }
  // --- Delete ---
  async deleteMemory(memoryId) {
    const data = await this.withKind((kind) => this.hydra.context.delete({
      ids: [memoryId],
      kind
    }));
    return toDeleteMemoryResponse(data);
  }
  // --- Fetch Content ---
  async fetchContent(sourceId, mode = "content") {
    const data = await this.hydra.context.inspect({
      id: sourceId,
      mode
    });
    return toFetchContentResponse(data);
  }
  // --- Accessors ---
  getTenantId() {
    return this.tenantId;
  }
  getSubTenantId() {
    return this.subTenantId;
  }
};

// commands/onboarding.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

// tool-names.ts
var TOOL_NAMES = {
  // Canonical (CONTRACT §3).
  QUERY: "hydradb_query",
  INGEST: "hydradb_ingest",
  LIST: "hydradb_list",
  INSPECT: "hydradb_inspect",
  DELETE: "hydradb_delete",
  // Deprecated aliases — kept working for backward compatibility.
  SEARCH: "hydra_search",
  STORE: "hydra_store",
  LIST_MEMORIES: "hydra_list_memories",
  GET_CONTENT: "hydra_get_content",
  DELETE_MEMORY: "hydra_delete_memory"
};
var CANONICAL_TOOL_NAMES = [
  TOOL_NAMES.QUERY,
  TOOL_NAMES.INGEST,
  TOOL_NAMES.LIST,
  TOOL_NAMES.INSPECT,
  TOOL_NAMES.DELETE
];
var DEPRECATED_TOOL_NAMES = [
  TOOL_NAMES.SEARCH,
  TOOL_NAMES.STORE,
  TOOL_NAMES.LIST_MEMORIES,
  TOOL_NAMES.GET_CONTENT,
  TOOL_NAMES.DELETE_MEMORY
];
var ALIAS_REPLACEMENTS = {
  [TOOL_NAMES.SEARCH]: TOOL_NAMES.QUERY,
  [TOOL_NAMES.STORE]: TOOL_NAMES.INGEST,
  [TOOL_NAMES.LIST_MEMORIES]: TOOL_NAMES.LIST,
  [TOOL_NAMES.GET_CONTENT]: TOOL_NAMES.INSPECT,
  [TOOL_NAMES.DELETE_MEMORY]: TOOL_NAMES.DELETE
};
var SLASH_NAMES = {
  QUERY: "/hydradb-query",
  INGEST: "/hydradb-ingest",
  LIST: "/hydradb-list",
  INSPECT: "/hydradb-inspect",
  DELETE: "/hydradb-delete"
};
var CANONICAL_SLASH_NAMES = [
  SLASH_NAMES.QUERY,
  SLASH_NAMES.INGEST,
  SLASH_NAMES.LIST,
  SLASH_NAMES.INSPECT,
  SLASH_NAMES.DELETE
];
var SLASH_ALIAS_REPLACEMENTS = {
  "/hydra-recall": SLASH_NAMES.QUERY,
  "/hydra-remember": SLASH_NAMES.INGEST,
  "/hydra-list": SLASH_NAMES.LIST,
  "/hydra-get": SLASH_NAMES.INSPECT,
  "/hydra-delete": SLASH_NAMES.DELETE
};
var warned = /* @__PURE__ */ new Set();
function warnDeprecated(kind, name, replacement) {
  if (warned.has(name)) return;
  warned.add(name);
  console.error(
    `[hydra-db] The ${kind} "${name}" is deprecated and will be removed in a future major version; use "${replacement}" instead.`
  );
}

// commands/onboarding.ts
var DEFAULTS = {
  subTenantId: "hydra-openclaw-plugin",
  ignoreTerm: "hydra-ignore",
  autoRecall: true,
  autoCapture: true,
  maxRecallResults: 10,
  recallMode: "fast",
  graphContext: true,
  debug: false
};
var c = {
  reset: "\x1B[0m",
  bold: "\x1B[1m",
  dim: "\x1B[2m",
  cyan: "\x1B[36m",
  green: "\x1B[32m",
  yellow: "\x1B[33m",
  red: "\x1B[31m",
  magenta: "\x1B[35m",
  white: "\x1B[37m",
  bgCyan: "\x1B[46m",
  bgGreen: "\x1B[42m",
  black: "\x1B[30m"
};
function mask(value, visible = 4) {
  if (value.length <= visible) return "****";
  return `${"*".repeat(value.length - visible)}${value.slice(-visible)}`;
}
function createRl() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
}
function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}
async function promptText(rl, label, opts) {
  const def = opts?.default;
  const hint = def ? `${c.dim} (${def})${c.reset}` : opts?.required ? `${c.red} *${c.reset}` : "";
  const prefix = `  ${c.cyan}?${c.reset} ${c.bold}${label}${c.reset}${hint}${c.dim} \u203A${c.reset} `;
  while (true) {
    const raw = await ask(rl, prefix);
    const value = raw.trim();
    if (value) return value;
    if (def) return def;
    if (opts?.required) {
      console.log(`    ${c.red}This field is required.${c.reset}`);
      continue;
    }
    return "";
  }
}
async function promptChoice(rl, label, choices, defaultChoice) {
  const tags = choices.map((ch) => ch === defaultChoice ? `${c.green}${c.bold}${ch}${c.reset}` : `${c.dim}${ch}${c.reset}`).join(`${c.dim} / ${c.reset}`);
  const prefix = `  ${c.cyan}?${c.reset} ${c.bold}${label}${c.reset} ${tags}${c.dim} \u203A${c.reset} `;
  while (true) {
    const raw = await ask(rl, prefix);
    const value = raw.trim().toLowerCase();
    if (!value) return defaultChoice;
    const match = choices.find((ch) => ch.toLowerCase() === value);
    if (match) return match;
    console.log(`    ${c.yellow}Choose one of: ${choices.join(", ")}${c.reset}`);
  }
}
async function promptBool(rl, label, defaultVal) {
  const hint = defaultVal ? `${c.dim} (${c.green}Y${c.reset}${c.dim}/n)${c.reset}` : `${c.dim} (y/${c.green}N${c.reset}${c.dim})${c.reset}`;
  const prefix = `  ${c.cyan}?${c.reset} ${c.bold}${label}${c.reset}${hint}${c.dim} \u203A${c.reset} `;
  const raw = await ask(rl, prefix);
  const value = raw.trim().toLowerCase();
  if (!value) return defaultVal;
  return value === "y" || value === "yes" || value === "true";
}
async function promptNumber(rl, label, defaultVal, min, max) {
  const prefix = `  ${c.cyan}?${c.reset} ${c.bold}${label}${c.reset}${c.dim} (${defaultVal}) [${min}\u2013${max}] \u203A${c.reset} `;
  while (true) {
    const raw = await ask(rl, prefix);
    const value = raw.trim();
    if (!value) return defaultVal;
    const n = Number.parseInt(value, 10);
    if (!Number.isNaN(n) && n >= min && n <= max) return n;
    console.log(`    ${c.yellow}Enter a number between ${min} and ${max}.${c.reset}`);
  }
}
function printBanner() {
  console.log();
  console.log(`  ${c.bgCyan}${c.black}${c.bold}                              ${c.reset}`);
  console.log(`  ${c.bgCyan}${c.black}${c.bold}    \u25C6  Hydra DB \u2014 Onboard    ${c.reset}`);
  console.log(`  ${c.bgCyan}${c.black}${c.bold}                              ${c.reset}`);
  console.log();
}
function printSection(title) {
  console.log();
  console.log(`  ${c.magenta}${c.bold}\u2500\u2500 ${title} ${"\u2500".repeat(Math.max(0, 40 - title.length))}${c.reset}`);
  console.log();
}
function printSummaryRow(label, value, sensitive = false) {
  const display = sensitive ? mask(value) : value;
  console.log(`  ${c.dim}\u2502${c.reset}  ${c.bold}${label.padEnd(18)}${c.reset} ${c.cyan}${display}${c.reset}`);
}
function printSuccess(msg) {
  console.log();
  console.log(`  ${c.bgGreen}${c.black}${c.bold} \u2713 ${c.reset} ${c.green}${msg}${c.reset}`);
  console.log();
}
function buildConfigObj(result) {
  const obj = {};
  obj.apiKey = result.apiKey;
  obj.tenantId = result.tenantId;
  if (result.subTenantId !== DEFAULTS.subTenantId) {
    obj.subTenantId = result.subTenantId;
  }
  if (result.ignoreTerm !== DEFAULTS.ignoreTerm) {
    obj.ignoreTerm = result.ignoreTerm;
  }
  if (result.autoRecall !== void 0 && result.autoRecall !== DEFAULTS.autoRecall) {
    obj.autoRecall = result.autoRecall;
  }
  if (result.autoCapture !== void 0 && result.autoCapture !== DEFAULTS.autoCapture) {
    obj.autoCapture = result.autoCapture;
  }
  if (result.maxRecallResults !== void 0 && result.maxRecallResults !== DEFAULTS.maxRecallResults) {
    obj.maxRecallResults = result.maxRecallResults;
  }
  if (result.recallMode !== void 0 && result.recallMode !== DEFAULTS.recallMode) {
    obj.recallMode = result.recallMode;
  }
  if (result.graphContext !== void 0 && result.graphContext !== DEFAULTS.graphContext) {
    obj.graphContext = result.graphContext;
  }
  if (result.debug !== void 0 && result.debug !== DEFAULTS.debug) {
    obj.debug = result.debug;
  }
  return obj;
}
function resolveOpenClawConfigPath() {
  if (process.env.OPENCLAW_CONFIG_PATH) {
    return process.env.OPENCLAW_CONFIG_PATH;
  }
  if (process.env.OPENCLAW_STATE_DIR) {
    return path.join(process.env.OPENCLAW_STATE_DIR, "openclaw.json");
  }
  if (process.env.OPENCLAW_HOME) {
    return path.join(process.env.OPENCLAW_HOME, ".openclaw", "openclaw.json");
  }
  return path.join(os.homedir(), ".openclaw", "openclaw.json");
}
var OPENCLAW_CONFIG_PATH = resolveOpenClawConfigPath();
function persistConfig(configObj) {
  try {
    const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, "utf-8");
    const root = JSON.parse(raw);
    if (!root.plugins) root.plugins = {};
    if (!root.plugins.entries) root.plugins.entries = {};
    if (!root.plugins.entries["openclaw"]) {
      root.plugins.entries["openclaw"] = { enabled: true };
    }
    root.plugins.entries["openclaw"].config = configObj;
    fs.writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(root, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}
async function runBasicWizard(cfg) {
  const rl = createRl();
  try {
    printBanner();
    console.log(`  ${c.dim}Configure the essential settings for Hydra DB.${c.reset}`);
    console.log(`  ${c.dim}Press Enter to accept defaults shown in parentheses.${c.reset}`);
    printSection("Credentials");
    const apiKey = await promptText(rl, "API Key", {
      required: true,
      secret: true
    });
    const tenantId = await promptText(rl, "Tenant ID", {
      required: true
    });
    printSection("Customisation");
    const subTenantId = await promptText(rl, "Sub-Tenant ID", {
      default: cfg?.subTenantId ?? DEFAULTS.subTenantId
    });
    const ignoreTerm = await promptText(rl, "Ignore Term", {
      default: cfg?.ignoreTerm ?? DEFAULTS.ignoreTerm
    });
    const result = { apiKey, tenantId, subTenantId, ignoreTerm };
    const configObj = buildConfigObj(result);
    printSection("Summary");
    console.log(`  ${c.dim}\u250C${"\u2500".repeat(50)}${c.reset}`);
    printSummaryRow("API Key", apiKey, true);
    printSummaryRow("Tenant ID", tenantId);
    printSummaryRow("Sub-Tenant ID", subTenantId);
    printSummaryRow("Ignore Term", ignoreTerm);
    console.log(`  ${c.dim}\u2514${"\u2500".repeat(50)}${c.reset}`);
    const saved = await promptBool(rl, `Write config to ${OPENCLAW_CONFIG_PATH}?`, true);
    if (saved && persistConfig(configObj)) {
      printSuccess("Config saved! Restart the gateway (`openclaw gateway restart`) to apply.");
    } else if (saved) {
      console.log(`  ${c.red}Failed to write config. Add manually:${c.reset}`);
      console.log();
      for (const line of JSON.stringify(configObj, null, 2).split("\n")) {
        console.log(`    ${c.cyan}${line}${c.reset}`);
      }
    } else {
      console.log();
      console.log(`  ${c.yellow}${c.bold}Add to openclaw.json plugins.entries.openclaw.config:${c.reset}`);
      console.log();
      for (const line of JSON.stringify(configObj, null, 2).split("\n")) {
        console.log(`    ${c.cyan}${line}${c.reset}`);
      }
    }
    console.log();
    console.log(`  ${c.dim}Run \`hydra onboard --advanced\` to fine-tune all options.${c.reset}`);
  } finally {
    rl.close();
  }
}
async function runAdvancedWizard(cfg) {
  const rl = createRl();
  try {
    printBanner();
    console.log(`  ${c.dim}Full configuration wizard \u2014 customise every option.${c.reset}`);
    console.log(`  ${c.dim}Press Enter to accept defaults shown in parentheses.${c.reset}`);
    printSection("Credentials");
    const apiKey = await promptText(rl, "API Key", {
      required: true,
      secret: true
    });
    const tenantId = await promptText(rl, "Tenant ID", {
      required: true
    });
    const subTenantId = await promptText(rl, "Sub-Tenant ID", {
      default: cfg?.subTenantId ?? DEFAULTS.subTenantId
    });
    printSection("Behaviour");
    const autoRecall = await promptBool(rl, "Enable Auto-Recall?", cfg?.autoRecall ?? DEFAULTS.autoRecall);
    const autoCapture = await promptBool(rl, "Enable Auto-Capture?", cfg?.autoCapture ?? DEFAULTS.autoCapture);
    const ignoreTerm = await promptText(rl, "Ignore Term", {
      default: cfg?.ignoreTerm ?? DEFAULTS.ignoreTerm
    });
    printSection("Recall Settings");
    const maxRecallResults = await promptNumber(
      rl,
      "Max Recall Results",
      cfg?.maxRecallResults ?? DEFAULTS.maxRecallResults,
      1,
      50
    );
    const recallMode = await promptChoice(
      rl,
      "Recall Mode",
      ["fast", "thinking"],
      cfg?.recallMode ?? DEFAULTS.recallMode
    );
    const graphContext = await promptBool(rl, "Enable Graph Context?", cfg?.graphContext ?? DEFAULTS.graphContext);
    printSection("Debug");
    const debug = await promptBool(rl, "Enable Debug Logging?", cfg?.debug ?? DEFAULTS.debug);
    const result = {
      apiKey,
      tenantId,
      subTenantId,
      ignoreTerm,
      autoRecall,
      autoCapture,
      maxRecallResults,
      recallMode,
      graphContext,
      debug
    };
    printSection("Summary");
    console.log(`  ${c.dim}\u250C${"\u2500".repeat(50)}${c.reset}`);
    printSummaryRow("API Key", apiKey, true);
    printSummaryRow("Tenant ID", tenantId);
    printSummaryRow("Sub-Tenant ID", subTenantId);
    printSummaryRow("Auto-Recall", String(autoRecall));
    printSummaryRow("Auto-Capture", String(autoCapture));
    printSummaryRow("Ignore Term", ignoreTerm);
    printSummaryRow("Max Results", String(maxRecallResults));
    printSummaryRow("Recall Mode", recallMode);
    printSummaryRow("Graph Context", String(graphContext));
    printSummaryRow("Debug", String(debug));
    console.log(`  ${c.dim}\u2514${"\u2500".repeat(50)}${c.reset}`);
    const configObj = buildConfigObj(result);
    const saved = await promptBool(rl, `Write config to ${OPENCLAW_CONFIG_PATH}?`, true);
    if (saved && persistConfig(configObj)) {
      printSuccess("Config saved! Restart the gateway (`openclaw gateway restart`) to apply.");
    } else if (saved) {
      console.log(`  ${c.red}Failed to write config. Add manually:${c.reset}`);
      console.log();
      for (const line of JSON.stringify(configObj, null, 2).split("\n")) {
        console.log(`    ${c.cyan}${line}${c.reset}`);
      }
    } else {
      console.log();
      console.log(`  ${c.yellow}${c.bold}Add to openclaw.json plugins.entries.openclaw.config:${c.reset}`);
      console.log();
      for (const line of JSON.stringify(configObj, null, 2).split("\n")) {
        console.log(`    ${c.cyan}${line}${c.reset}`);
      }
    }
  } finally {
    rl.close();
  }
}
function registerOnboardingCli(cfg, opts) {
  return (root) => {
    root.command("onboard").description("Interactive Hydra DB onboarding wizard").option("--advanced", "Configure all options (credentials, behaviour, recall, debug)").action(async (cmdOpts) => {
      if (opts?.deprecatedReplacement) {
        warnDeprecated(
          "CLI command",
          "hydra onboard",
          `${opts.deprecatedReplacement} onboard`
        );
      }
      if (cmdOpts.advanced) {
        await runAdvancedWizard(cfg);
      } else {
        await runBasicWizard(cfg);
      }
    });
  };
}
function registerOnboardingSlashCommands(api, client, cfg) {
  api.registerCommand({
    name: "hydra-onboard",
    description: "Show Hydra plugin config status (run `hydra onboard` in CLI for interactive wizard)",
    acceptsArgs: false,
    requireAuth: false,
    handler: async () => {
      try {
        const lines = [
          "=== Hydra DB \u2014 Current Config ===",
          "",
          `  API Key:       ${cfg.apiKey ? `${mask(cfg.apiKey)} \u2713` : "NOT SET \u2717"}`,
          `  Tenant ID:     ${cfg.tenantId ? `${mask(cfg.tenantId, 8)} \u2713` : "NOT SET \u2717"}`,
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
          "     or `hydra onboard --advanced` for all options."
        ];
        return { text: lines.join("\n") };
      } catch (err) {
        log.error("/hydra-onboard", err);
        return { text: "Failed to show status. Check logs." };
      }
    }
  });
}

// session.ts
function toHookSourceId(sessionId) {
  return `hook_${sessionId}`;
}
function toToolSourceId(sessionId) {
  return `tool_${sessionId}`;
}

// commands/slash.ts
function preview(text, max = 80) {
  return text.length > max ? `${text.slice(0, max)}\u2026` : text;
}
function registerCommandWithAlias(api, spec, canonicalSlash, aliasSlash) {
  const canonical = canonicalSlash.replace(/^\//, "");
  const alias = aliasSlash.replace(/^\//, "");
  api.registerCommand({
    name: canonical,
    description: spec.description,
    acceptsArgs: spec.acceptsArgs,
    requireAuth: spec.requireAuth,
    handler: spec.handler
  });
  api.registerCommand({
    name: alias,
    description: `(deprecated \u2014 use /${canonical}) ${spec.description}`,
    acceptsArgs: spec.acceptsArgs,
    requireAuth: spec.requireAuth,
    handler: (ctx) => {
      warnDeprecated("slash command", aliasSlash, canonicalSlash);
      return spec.handler(ctx);
    }
  });
}
function registerSlashCommands(api, client, cfg, getSessionId) {
  registerCommandWithAlias(
    api,
    {
      description: "Save a piece of information to Hydra memory",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx) => {
        const text = ctx.args?.trim();
        if (!text) return { text: "Usage: /hydradb-ingest <text to store>" };
        try {
          const sid = getSessionId();
          const sourceId = sid ? toToolSourceId(sid) : void 0;
          await client.ingestText(text, { sourceId, title: "Manual Memory", infer: true });
          return { text: `Saved: "${preview(text, 60)}"` };
        } catch (err) {
          log.error("/hydradb-ingest", err);
          return { text: "Failed to save. Check logs." };
        }
      }
    },
    SLASH_NAMES.INGEST,
    "/hydra-remember"
  );
  registerCommandWithAlias(
    api,
    {
      description: "Search your Hydra memories",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx) => {
        const query = ctx.args?.trim();
        if (!query) return { text: "Usage: /hydradb-query <query>" };
        try {
          const res = await client.recall(query, {
            maxResults: cfg.maxRecallResults,
            mode: cfg.recallMode,
            graphContext: cfg.graphContext
          });
          if (!res.chunks || res.chunks.length === 0) {
            return { text: `No memories found for "${query}"` };
          }
          const lines = res.chunks.slice(0, 10).map((c2, i) => {
            const score = c2.relevancy_score != null ? ` (${Math.round(c2.relevancy_score * 100)}%)` : "";
            const title = c2.source_title ? ` [${c2.source_title}]` : "";
            return `${i + 1}.${title} ${preview(c2.chunk_content, 120)}${score}`;
          });
          return { text: `Found ${res.chunks.length} chunks:

${lines.join("\n")}` };
        } catch (err) {
          log.error("/hydradb-query", err);
          return { text: "Recall failed. Check logs." };
        }
      }
    },
    SLASH_NAMES.QUERY,
    "/hydra-recall"
  );
  registerCommandWithAlias(
    api,
    {
      description: "List all stored user memories",
      acceptsArgs: false,
      requireAuth: true,
      handler: async () => {
        try {
          const res = await client.listMemories();
          const memories = res.user_memories ?? [];
          if (memories.length === 0) return { text: "No memories stored yet." };
          const lines = memories.map(
            (m, i) => `${i + 1}. [${m.memory_id}] ${preview(m.memory_content, 100)}`
          );
          return { text: `${memories.length} memories:

${lines.join("\n")}` };
        } catch (err) {
          log.error("/hydradb-list", err);
          return { text: "Failed to list memories. Check logs." };
        }
      }
    },
    SLASH_NAMES.LIST,
    "/hydra-list"
  );
  registerCommandWithAlias(
    api,
    {
      description: "Delete a specific memory by its ID",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx) => {
        const memoryId = ctx.args?.trim();
        if (!memoryId) return { text: "Usage: /hydradb-delete <memory_id>" };
        try {
          const res = await client.deleteMemory(memoryId);
          if (res.user_memory_deleted) {
            return { text: `Deleted memory: ${memoryId}` };
          }
          return { text: `Memory ${memoryId} was not found or already deleted.` };
        } catch (err) {
          log.error("/hydradb-delete", err);
          return { text: "Delete failed. Check logs." };
        }
      }
    },
    SLASH_NAMES.DELETE,
    "/hydra-delete"
  );
  registerCommandWithAlias(
    api,
    {
      description: "Fetch the content of a specific source by its ID",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx) => {
        const sourceId = ctx.args?.trim();
        if (!sourceId) return { text: "Usage: /hydradb-inspect <source_id>" };
        try {
          const res = await client.fetchContent(sourceId);
          if (!res.success || res.error) {
            return { text: `Could not fetch source ${sourceId}: ${res.error ?? "unknown error"}` };
          }
          const content = res.content ?? res.content_base64 ?? "(no text content)";
          return { text: `Source: ${sourceId}

${preview(content, 2e3)}` };
        } catch (err) {
          log.error("/hydradb-inspect", err);
          return { text: "Fetch failed. Check logs." };
        }
      }
    },
    SLASH_NAMES.INSPECT,
    "/hydra-get"
  );
}

// config.ts
var KNOWN_KEYS = /* @__PURE__ */ new Set([
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
  "layout"
]);
var DEFAULT_SUB_TENANT = "hydra-openclaw-plugin";
var DEFAULT_IGNORE_TERM = "hydra-ignore";
function envOrNull(name) {
  return typeof process !== "undefined" ? process.env[name] : void 0;
}
var warnedEnvAliases = /* @__PURE__ */ new Set();
function warnEnvAlias(deprecated, canonical) {
  if (warnedEnvAliases.has(deprecated)) return;
  warnedEnvAliases.add(deprecated);
  console.error(
    `[hydra-db] The environment variable ${deprecated} is deprecated; use ${canonical} instead.`
  );
}
function envWithAliases(canonical, deprecated) {
  const canon = envOrNull(canonical);
  if (canon) return canon;
  for (const dep of deprecated) {
    const value = envOrNull(dep);
    if (value) {
      warnEnvAlias(dep, canonical);
      return value;
    }
  }
  return void 0;
}
function resolveEnvVars(value) {
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => {
    const val = envOrNull(name);
    if (!val) throw new Error(`Environment variable ${name} is not set`);
    return val;
  });
}
function parseConfig(raw) {
  const cfg = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const unknown = Object.keys(cfg).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length > 0) {
    throw new Error(`hydra-db: unrecognized config keys: ${unknown.join(", ")}`);
  }
  const apiKey = typeof cfg.apiKey === "string" && cfg.apiKey.length > 0 ? resolveEnvVars(cfg.apiKey) : envWithAliases("HYDRADB_API_KEY", ["HYDRA_OPENCLAW_API_KEY"]);
  if (!apiKey) {
    throw new Error(
      "hydra-db: apiKey is required \u2014 set it in plugin config or via the HYDRADB_API_KEY env var"
    );
  }
  const tenantId = typeof cfg.tenantId === "string" && cfg.tenantId.length > 0 ? resolveEnvVars(cfg.tenantId) : envWithAliases("HYDRADB_DATABASE", ["HYDRA_OPENCLAW_TENANT_ID"]);
  if (!tenantId) {
    throw new Error(
      "hydra-db: tenantId is required \u2014 set it in plugin config or via the HYDRADB_DATABASE env var"
    );
  }
  const subTenantId = typeof cfg.subTenantId === "string" && cfg.subTenantId.length > 0 ? cfg.subTenantId : envWithAliases("HYDRADB_COLLECTION", []) ?? DEFAULT_SUB_TENANT;
  const baseUrl = envWithAliases("HYDRADB_BASE_URL", []);
  return {
    apiKey,
    tenantId,
    subTenantId,
    ...baseUrl ? { baseUrl } : {},
    autoRecall: cfg.autoRecall ?? true,
    autoCapture: cfg.autoCapture ?? true,
    maxRecallResults: cfg.maxRecallResults ?? 10,
    recallMode: cfg.recallMode === "thinking" ? "thinking" : "fast",
    graphContext: cfg.graphContext ?? true,
    ignoreTerm: typeof cfg.ignoreTerm === "string" && cfg.ignoreTerm.length > 0 ? cfg.ignoreTerm : DEFAULT_IGNORE_TERM,
    debug: cfg.debug ?? false,
    layout: parseLayout(cfg.layout)
  };
}
function parseLayout(value) {
  if (value === void 0) return "auto";
  if (value === "split" || value === "unified" || value === "auto") return value;
  throw new Error(`hydra-db: layout must be "split", "unified" or "auto"`);
}
function tryParseConfig(raw) {
  try {
    return parseConfig(raw);
  } catch {
    return null;
  }
}
function parseConfigSoft(raw) {
  const cfg = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const unknown = Object.keys(cfg).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length > 0) {
    throw new Error(`hydra-db: unrecognized config keys: ${unknown.join(", ")}`);
  }
  return cfg;
}
var hydraConfigSchema = {
  parse: parseConfigSoft
};

// messages.ts
function containsIgnoreTerm(text, ignoreTerm) {
  return text.toLowerCase().includes(ignoreTerm.toLowerCase());
}
function filterIgnoredTurns(turns, ignoreTerm) {
  return turns.filter(
    (t) => !containsIgnoreTerm(t.user, ignoreTerm) && !containsIgnoreTerm(t.assistant, ignoreTerm)
  );
}
function textFromMessage(msg) {
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter(
      (b) => b && typeof b === "object" && b.type === "text"
    ).map((b) => b.text).filter(Boolean).join("\n");
  }
  return "";
}
function extractAllTurns(messages) {
  const turns = [];
  let currentUserText = null;
  let currentAssistantText = null;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg;
    const text = textFromMessage(m);
    if (m.role === "user") {
      if (!text) continue;
      if (currentUserText && currentAssistantText) {
        turns.push({ user: currentUserText, assistant: currentAssistantText });
      }
      currentUserText = text;
      currentAssistantText = "no-message";
    } else if (m.role === "assistant") {
      if (!text) continue;
      currentAssistantText = text;
    }
  }
  if (currentUserText && currentAssistantText) {
    turns.push({ user: currentUserText, assistant: currentAssistantText });
  }
  return turns;
}

// hooks/capture.ts
var MAX_HOOK_TURNS = -1;
function removeInjectedBlocks(text) {
  return text.replace(/<hydra-context>[\s\S]*?<\/hydra-context>\s*/g, "").trim();
}
function createIngestionHook(client, cfg) {
  return async (event, sessionId) => {
    try {
      log.debug(`[capture] hook fired \u2014 success=${event.success} msgs=${Array.isArray(event.messages) ? event.messages.length : "N/A"} sid=${sessionId ?? "none"}`);
      if (!event.success) {
        log.debug("[capture] skipped \u2014 event.success is falsy");
        return;
      }
      if (!Array.isArray(event.messages) || event.messages.length === 0) {
        log.debug("[capture] skipped \u2014 no messages in event");
        return;
      }
      if (!sessionId) {
        log.debug("[capture] skipped \u2014 no session id available");
        return;
      }
      const rawTurns = extractAllTurns(event.messages);
      const allTurns = filterIgnoredTurns(rawTurns, cfg.ignoreTerm);
      if (rawTurns.length > 0 && allTurns.length < rawTurns.length) {
        log.debug(`[capture] filtered ${rawTurns.length - allTurns.length} turns containing ignore term "${cfg.ignoreTerm}"`);
      }
      if (allTurns.length === 0) {
        log.debug(`[capture] skipped \u2014 no user-assistant turns found in ${event.messages.length} messages`);
        const roles = event.messages.slice(-5).map((m) => m && typeof m === "object" ? m.role : "?");
        log.debug(`[capture] last 5 message roles: ${JSON.stringify(roles)}`);
        return;
      }
      const recentTurns = MAX_HOOK_TURNS === -1 ? allTurns : allTurns.slice(-MAX_HOOK_TURNS);
      const turns = recentTurns.map((t) => ({
        user: removeInjectedBlocks(t.user),
        assistant: removeInjectedBlocks(t.assistant)
      })).filter((t) => t.user.length >= 5 && t.assistant.length >= 5);
      if (turns.length === 0) {
        log.debug("[capture] skipped \u2014 all turns too short after cleaning");
        return;
      }
      const sourceId = toHookSourceId(sessionId);
      const now = /* @__PURE__ */ new Date();
      const timestamp = now.toISOString();
      const readableTime = now.toLocaleString("en-US", {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short"
      });
      const annotatedTurns = turns.map((t, i) => ({
        user: i === 0 ? `[Temporal details: ${readableTime}]

${t.user}` : t.user,
        assistant: t.assistant
      }));
      log.debug(`[capture] ingesting ${annotatedTurns.length} turns (of ${allTurns.length} total) @ ${timestamp} -> ${sourceId}`);
      await client.ingestConversation(
        annotatedTurns,
        sourceId,
        {
          metadata: {
            captured_at: timestamp,
            source: "openclaw_hook",
            turn_count: annotatedTurns.length
          }
        }
      );
      log.debug("[capture] ingestion succeeded");
    } catch (err) {
      log.error("[capture] hook error", err);
    }
  };
}

// context.ts
function formatTriplet(triplet) {
  const src = triplet.source?.name ?? "?";
  const rel = triplet.relation;
  const predicate = rel?.raw_predicate ?? rel?.canonical_predicate ?? "related to";
  const tgt = triplet.target?.name ?? "?";
  const ctx = rel?.context ? ` [${rel.context}]` : "";
  return `  (${src}) \u2014[${predicate}]\u2192 (${tgt})${ctx}`;
}
function buildRecalledContext(response, opts) {
  const minScore = opts?.minEvidenceScore ?? 0.4;
  const chunks = response.chunks ?? [];
  const graphCtx = response.graph_context ?? {
    query_paths: [],
    chunk_relations: [],
    chunk_id_to_group_ids: {}
  };
  const extraContextMap = response.additional_context ?? {};
  const rawRelations = graphCtx.chunk_relations ?? [];
  const relationIndex = {};
  for (let idx = 0; idx < rawRelations.length; idx++) {
    const relation = rawRelations[idx];
    if ((relation.relevancy_score ?? 0) < minScore) continue;
    const groupId = relation.group_id ?? `p_${idx}`;
    relationIndex[groupId] = relation;
  }
  const chunkToGroupIds = graphCtx.chunk_id_to_group_ids ?? {};
  const consumedExtraIds = /* @__PURE__ */ new Set();
  const chunkSections = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const lines = [];
    lines.push(`Chunk ${i + 1}`);
    const meta = chunk.document_metadata ?? {};
    const title = chunk.source_title || meta.title;
    if (title) {
      lines.push(`Source: ${title}`);
    }
    lines.push(chunk.chunk_content ?? "");
    const chunkUuid = chunk.chunk_uuid;
    const linkedGroupIds = chunkToGroupIds[chunkUuid] ?? [];
    const matchedRelations = [];
    for (const gid of linkedGroupIds) {
      if (relationIndex[gid]) {
        matchedRelations.push(relationIndex[gid]);
      }
    }
    if (matchedRelations.length === 0) {
      for (const rel of Object.values(relationIndex)) {
        const triplets = rel.triplets ?? [];
        const hasChunk = triplets.some(
          (t) => t.relation?.chunk_id === chunkUuid
        );
        if (hasChunk) {
          matchedRelations.push(rel);
        }
      }
    }
    const relationLines = [];
    for (const rel of matchedRelations) {
      const triplets = rel.triplets ?? [];
      if (triplets.length > 0) {
        for (const triplet of triplets) {
          relationLines.push(formatTriplet(triplet));
        }
      } else if (rel.combined_context) {
        relationLines.push(`  ${rel.combined_context}`);
      }
    }
    if (relationLines.length > 0) {
      lines.push("Graph Relations:");
      lines.push(...relationLines);
    }
    const extraIds = chunk.extra_context_ids ?? [];
    if (extraIds.length > 0 && Object.keys(extraContextMap).length > 0) {
      const extraLines = [];
      for (const ctxId of extraIds) {
        if (consumedExtraIds.has(ctxId)) continue;
        const extraChunk = extraContextMap[ctxId];
        if (extraChunk) {
          consumedExtraIds.add(ctxId);
          const extraContent = extraChunk.chunk_content ?? "";
          const extraTitle = extraChunk.source_title ?? "";
          if (extraTitle) {
            extraLines.push(
              `  Related Context (${extraTitle}): ${extraContent}`
            );
          } else {
            extraLines.push(`  Related Context: ${extraContent}`);
          }
        }
      }
      if (extraLines.length > 0) {
        lines.push("Extra Context:");
        lines.push(...extraLines);
      }
    }
    chunkSections.push(lines.join("\n"));
  }
  const entityPathLines = [];
  const rawPaths = graphCtx.query_paths ?? [];
  for (const path2 of rawPaths) {
    if (path2.combined_context) {
      entityPathLines.push(path2.combined_context);
    } else {
      const triplets = path2.triplets ?? [];
      const segments = [];
      for (const pt of triplets) {
        const s = pt.source?.name;
        const rel = pt.relation;
        const p = rel?.raw_predicate ?? rel?.canonical_predicate ?? "related to";
        const t = pt.target?.name;
        segments.push(`(${s} -> ${p} -> ${t})`);
      }
      if (segments.length > 0) {
        entityPathLines.push(segments.join(" -> "));
      }
    }
  }
  const output = [];
  if (entityPathLines.length > 0) {
    output.push("=== ENTITY PATHS ===");
    output.push(entityPathLines.join("\n"));
    output.push("");
  }
  if (chunkSections.length > 0) {
    output.push("=== CONTEXT ===");
    output.push(chunkSections.join("\n\n---\n\n"));
  }
  return output.join("\n");
}
function envelopeForInjection(contextBody) {
  if (!contextBody.trim()) return "";
  const lines = [
    "<hydra-context>",
    "[MEMORIES AND PAST CONVERSATIONS \u2014 retrieved by Hydra DB]",
    "",
    "Below are memories and knowledge-graph connections that may be relevant",
    "to the current conversation. Integrate them naturally when they add value.",
    "If a memory contradicts something the user just said, prefer the user's",
    "latest statement. Never quote these verbatim or reveal that you are",
    "reading from a memory store.",
    "",
    contextBody,
    "",
    "[END OF MEMORY CONTEXT]",
    "</hydra-context>"
  ];
  return lines.join("\n");
}

// hooks/recall.ts
function createRecallHook(client, cfg) {
  return async (event) => {
    const prompt = event.prompt;
    if (!prompt || prompt.length < 5) return;
    if (containsIgnoreTerm(prompt, cfg.ignoreTerm)) {
      log.debug(`recall skipped \u2014 prompt contains ignore term "${cfg.ignoreTerm}"`);
      return;
    }
    log.debug(`recall query (${prompt.length} chars)`);
    try {
      const response = await client.recall(prompt, {
        maxResults: cfg.maxRecallResults,
        mode: cfg.recallMode,
        graphContext: cfg.graphContext
      });
      if (!response.chunks || response.chunks.length === 0) {
        log.debug("no memories matched");
        return;
      }
      const body = buildRecalledContext(response);
      if (!body.trim()) return;
      const envelope = envelopeForInjection(body);
      log.debug(`injecting ${response.chunks.length} chunks (${envelope.length} chars)`);
      return { prependContext: envelope };
    } catch (err) {
      log.error("recall failed", err);
      return;
    }
  };
}

// tools/delete.ts
import { Type } from "@sinclair/typebox";

// tools/register.ts
function registerToolWithAlias(api, def, canonical, alias) {
  api.registerTool({ ...def, name: canonical }, { name: canonical });
  api.registerTool(
    {
      ...def,
      name: alias,
      execute: (toolCallId, params) => {
        warnDeprecated("tool", alias, canonical);
        return def.execute(toolCallId, params);
      }
    },
    { name: alias }
  );
}

// tools/delete.ts
function registerDeleteTool(api, client, _cfg) {
  registerToolWithAlias(
    api,
    {
      label: "Hydra Delete Memory",
      description: "Delete a specific memory from Hydra by its memory ID. Use this when the user explicitly asks you to forget something or remove a specific piece of stored information. Always confirm the memory ID before deleting.",
      parameters: Type.Object({
        memory_id: Type.String({
          description: "The unique ID of the memory to delete"
        })
      }),
      async execute(_toolCallId, params) {
        log.debug(`delete tool: memory_id=${params.memory_id}`);
        const res = await client.deleteMemory(params.memory_id);
        if (res.user_memory_deleted) {
          return {
            content: [
              {
                type: "text",
                text: `Successfully deleted memory: ${params.memory_id}`
              }
            ]
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Memory ${params.memory_id} was not found or has already been deleted.`
            }
          ]
        };
      }
    },
    TOOL_NAMES.DELETE,
    TOOL_NAMES.DELETE_MEMORY
  );
}

// tools/get.ts
import { Type as Type2 } from "@sinclair/typebox";
function registerGetTool(api, client, _cfg) {
  registerToolWithAlias(
    api,
    {
      label: "Hydra Get Content",
      description: "Fetch the full content of a specific source from Hydra by its source ID. Use this to retrieve the complete text of a memory source when you need more details than what's shown in search results.",
      parameters: Type2.Object({
        source_id: Type2.String({
          description: "The unique source ID to fetch content for"
        })
      }),
      async execute(_toolCallId, params) {
        log.debug(`get tool: source_id=${params.source_id}`);
        const res = await client.fetchContent(params.source_id);
        if (!res.success || res.error) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to fetch source ${params.source_id}: ${res.error ?? "unknown error"}`
              }
            ]
          };
        }
        const content = res.content ?? res.content_base64 ?? "(no text content available)";
        const preview2 = content.length > 3e3 ? `${content.slice(0, 3e3)}\u2026

[Content truncated, showing first 3000 characters]` : content;
        return {
          content: [
            {
              type: "text",
              text: `Source: ${params.source_id}

${preview2}`
            }
          ]
        };
      }
    },
    TOOL_NAMES.INSPECT,
    TOOL_NAMES.GET_CONTENT
  );
}

// tools/list.ts
import { Type as Type3 } from "@sinclair/typebox";
function registerListTool(api, client, _cfg) {
  registerToolWithAlias(
    api,
    {
      label: "Hydra List Memories",
      description: "List all user memories stored in Hydra. Returns memory IDs and content summaries. Use this when the user asks what you remember about them or wants to see their stored information.",
      parameters: Type3.Object({}),
      async execute(_toolCallId, _params) {
        log.debug("list tool: fetching all memories");
        const res = await client.listMemories();
        const memories = res.user_memories ?? [];
        if (memories.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No memories stored yet."
              }
            ]
          };
        }
        const lines = memories.map((m, i) => {
          const preview2 = m.memory_content.length > 100 ? `${m.memory_content.slice(0, 100)}\u2026` : m.memory_content;
          return `${i + 1}. [ID: ${m.memory_id}]
   ${preview2}`;
        });
        return {
          content: [
            {
              type: "text",
              text: `Found ${memories.length} memories:

${lines.join("\n\n")}`
            }
          ]
        };
      }
    },
    TOOL_NAMES.LIST,
    TOOL_NAMES.LIST_MEMORIES
  );
}

// tools/search.ts
import { Type as Type4 } from "@sinclair/typebox";
function registerSearchTool(api, client, cfg) {
  registerToolWithAlias(
    api,
    {
      label: "Hydra Search",
      description: "Search through Hydra DB memories. Returns relevant chunks with graph-enriched context.",
      parameters: Type4.Object({
        query: Type4.String({ description: "Search query" }),
        limit: Type4.Optional(
          Type4.Number({ description: "Max results (default: 10)" })
        )
      }),
      async execute(_toolCallId, params) {
        const limit = params.limit ?? cfg.maxRecallResults;
        log.debug(`search tool: "${params.query}" limit=${limit}`);
        const res = await client.recall(params.query, {
          maxResults: limit,
          mode: cfg.recallMode,
          graphContext: cfg.graphContext
        });
        if (!res.chunks || res.chunks.length === 0) {
          return {
            content: [{ type: "text", text: "No relevant memories found." }]
          };
        }
        const contextStr = buildRecalledContext(res);
        return {
          content: [
            {
              type: "text",
              text: `Found ${res.chunks.length} chunks

---
Full context:
${contextStr}`
            }
          ],
          details: {
            count: res.chunks.length,
            hasGraphContext: !!res.graph_context
          }
        };
      }
    },
    TOOL_NAMES.QUERY,
    TOOL_NAMES.SEARCH
  );
}

// tools/store.ts
import { Type as Type5 } from "@sinclair/typebox";
var MAX_STORE_TURNS = 10;
function removeInjectedBlocks2(text) {
  return text.replace(/<hydra-context>[\s\S]*?<\/hydra-context>\s*/g, "").trim();
}
function registerStoreTool(api, client, cfg, getSessionId, getMessages) {
  registerToolWithAlias(
    api,
    {
      label: "Hydra Store",
      description: "Save the full conversation history to Hydra DB memory. Use this to persist facts, preferences, or decisions the user wants remembered. The complete chat history will be sent for context-rich storage.",
      parameters: Type5.Object({
        text: Type5.String({
          description: "A brief summary or note about what is being saved"
        }),
        title: Type5.Optional(
          Type5.String({
            description: "Optional title for the memory entry"
          })
        )
      }),
      async execute(_toolCallId, params) {
        const sid = getSessionId();
        const sourceId = sid ? toToolSourceId(sid) : void 0;
        const messages = getMessages();
        log.debug(`[store] tool called \u2014 sid=${sid ?? "none"} msgs=${messages.length} text="${params.text.slice(0, 50)}"`);
        const rawTurns = extractAllTurns(messages);
        const filteredTurns = filterIgnoredTurns(rawTurns, cfg.ignoreTerm);
        const recentTurns = filteredTurns.slice(-MAX_STORE_TURNS);
        const turns = recentTurns.map((t) => ({
          user: removeInjectedBlocks2(t.user),
          assistant: removeInjectedBlocks2(t.assistant)
        }));
        log.debug(`[store] extracted ${rawTurns.length} total turns, ${rawTurns.length - filteredTurns.length} ignored, using last ${turns.length} (MAX_STORE_TURNS=${MAX_STORE_TURNS})`);
        if (turns.length > 0 && sourceId) {
          const now = /* @__PURE__ */ new Date();
          const readableTime = now.toLocaleString("en-US", {
            weekday: "short",
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            timeZoneName: "short"
          });
          const annotatedTurns = turns.map((t, i) => ({
            user: i === 0 ? `[Temporal details: ${readableTime}]

${t.user}` : t.user,
            assistant: t.assistant
          }));
          log.debug(`[store] ingesting ${annotatedTurns.length} conversation turns -> ${sourceId}`);
          await client.ingestConversation(annotatedTurns, sourceId, {
            metadata: {
              captured_at: now.toISOString(),
              source: "openclaw_tool",
              note: params.text
            }
          });
          return {
            content: [
              {
                type: "text",
                text: `Saved ${annotatedTurns.length} conversation turns to Hydra (${sourceId}). Note: "${params.text.length > 80 ? `${params.text.slice(0, 80)}\u2026` : params.text}"`
              }
            ]
          };
        }
        log.debug("[store] no conversation turns found, falling back to text ingestion");
        await client.ingestText(params.text, {
          sourceId,
          title: params.title ?? "Agent Memory",
          infer: true
        });
        return {
          content: [
            {
              type: "text",
              text: `Saved to Hydra: "${params.text.length > 80 ? `${params.text.slice(0, 80)}\u2026` : params.text}"`
            }
          ]
        };
      }
    },
    TOOL_NAMES.INGEST,
    TOOL_NAMES.STORE
  );
}

// index.ts
var NOT_CONFIGURED_MSG = "[hydra-db] Not configured. Run `openclaw hydra onboard` to set up credentials.";
var index_default = {
  id: "openclaw",
  name: "Hydra DB",
  description: "State-of-the-art agentic memory for OpenClaw powered by Hydra DB \u2014 auto-capture, recall, and graph-enriched context",
  kind: "memory",
  configSchema: hydraConfigSchema,
  register(api) {
    const cfg = tryParseConfig(api.pluginConfig);
    const cliClient = cfg ? new HydraClient(cfg.apiKey, cfg.tenantId, cfg.subTenantId, cfg.baseUrl, void 0, cfg.layout) : null;
    api.registerCli(
      ({ program }) => {
        const canonicalRoot = program.command("hydradb").description("Hydra DB memory commands");
        registerOnboardingCli(cfg ?? void 0)(canonicalRoot);
        registerCanonicalCliCommands(canonicalRoot, cliClient, cfg);
        const legacyRoot = program.command("hydra").description("(deprecated \u2014 use `hydradb`) Hydra DB memory commands");
        registerOnboardingCli(cfg ?? void 0, {
          deprecatedReplacement: "hydradb"
        })(legacyRoot);
        registerLegacyCliCommands(legacyRoot, cliClient, cfg);
      },
      { commands: ["hydradb", "hydra"] }
    );
    if (!cfg) {
      api.registerService({
        id: "openclaw",
        start: () => console.log(NOT_CONFIGURED_MSG),
        stop: () => {
        }
      });
      return;
    }
    log.init(api.logger, cfg.debug);
    const client = new HydraClient(cfg.apiKey, cfg.tenantId, cfg.subTenantId, cfg.baseUrl, void 0, cfg.layout);
    let activeSessionId;
    let conversationMessages = [];
    const getSessionId = () => activeSessionId;
    const getMessages = () => conversationMessages;
    registerSearchTool(api, client, cfg);
    registerStoreTool(api, client, cfg, getSessionId, getMessages);
    registerListTool(api, client, cfg);
    registerDeleteTool(api, client, cfg);
    registerGetTool(api, client, cfg);
    if (cfg.autoRecall) {
      const onRecall = createRecallHook(client, cfg);
      api.on(
        "before_agent_start",
        (event, ctx) => {
          if (ctx.sessionId) activeSessionId = ctx.sessionId;
          if (Array.isArray(event.messages)) conversationMessages = event.messages;
          log.debug(`[session] before_agent_start \u2014 sid=${activeSessionId ?? "none"} msgs=${conversationMessages.length}`);
          return onRecall(event);
        }
      );
    }
    if (cfg.autoCapture) {
      const captureHandler = createIngestionHook(client, cfg);
      api.on(
        "agent_end",
        (event, ctx) => {
          if (ctx.sessionId) activeSessionId = ctx.sessionId;
          if (Array.isArray(event.messages)) conversationMessages = event.messages;
          log.debug(`[session] agent_end \u2014 sid=${activeSessionId ?? "none"} msgs=${conversationMessages.length} ctxKeys=${Object.keys(ctx).join(",")}`);
          return captureHandler(event, activeSessionId);
        }
      );
    }
    registerSlashCommands(api, client, cfg, getSessionId);
    registerOnboardingSlashCommands(api, client, cfg);
    api.registerService({
      id: "openclaw",
      start: () => log.info("plugin started"),
      stop: () => log.info("plugin stopped")
    });
  }
};
function makeRequireCreds(client, cfg) {
  return () => {
    if (client && cfg) return { client, cfg };
    console.error(NOT_CONFIGURED_MSG);
    return null;
  };
}
async function queryAction(ctx, query, opts) {
  const limit = Number.parseInt(opts.limit, 10) || 10;
  const res = await ctx.client.recall(query, {
    maxResults: limit,
    mode: ctx.cfg.recallMode,
    graphContext: ctx.cfg.graphContext
  });
  if (!res.chunks || res.chunks.length === 0) {
    console.log("No memories found.");
    return;
  }
  for (const chunk of res.chunks) {
    const score = chunk.relevancy_score != null ? ` (${(chunk.relevancy_score * 100).toFixed(0)}%)` : "";
    const title = chunk.source_title ? `[${chunk.source_title}] ` : "";
    console.log(`- ${title}${chunk.chunk_content.slice(0, 200)}${score}`);
  }
}
async function ingestAction(ctx, text, opts) {
  await ctx.client.ingestText(text, { title: opts.title ?? "Manual Memory", infer: true });
  console.log(`Saved: "${text.length > 60 ? `${text.slice(0, 60)}\u2026` : text}"`);
}
async function listAction(ctx) {
  const res = await ctx.client.listMemories();
  const memories = res.user_memories ?? [];
  if (memories.length === 0) {
    console.log("No memories stored.");
    return;
  }
  for (const m of memories) {
    console.log(`[${m.memory_id}] ${m.memory_content.slice(0, 150)}`);
  }
  console.log(`
Total: ${memories.length}`);
}
async function deleteAction(ctx, memoryId) {
  const res = await ctx.client.deleteMemory(memoryId);
  console.log(res.user_memory_deleted ? `Deleted: ${memoryId}` : `Not found: ${memoryId}`);
}
async function inspectAction(ctx, sourceId) {
  const res = await ctx.client.fetchContent(sourceId);
  if (!res.success || res.error) {
    console.error(`Error: ${res.error ?? "unknown"}`);
    return;
  }
  console.log(res.content ?? res.content_base64 ?? "(no text content)");
}
function statusAction(ctx) {
  console.log(`Tenant:       ${ctx.client.getTenantId()}`);
  console.log(`Sub-Tenant:   ${ctx.client.getSubTenantId()}`);
  console.log(`Auto-Recall:  ${ctx.cfg.autoRecall}`);
  console.log(`Auto-Capture: ${ctx.cfg.autoCapture}`);
  console.log(`Recall Mode:  ${ctx.cfg.recallMode}`);
  console.log(`Graph:        ${ctx.cfg.graphContext}`);
  console.log(`Max Results:  ${ctx.cfg.maxRecallResults}`);
  console.log(`Ignore Term:  ${ctx.cfg.ignoreTerm}`);
}
function registerCanonicalCliCommands(root, client, cfg) {
  const requireCreds = makeRequireCreds(client, cfg);
  root.command("query").argument("<query>", "Search query").option("--limit <n>", "Max results", "10").action(async (query, opts) => {
    const ctx = requireCreds();
    if (ctx) await queryAction(ctx, query, opts);
  });
  root.command("ingest").argument("<text>", "Text to store as a memory").option("--title <title>", "Optional title").action(async (text, opts) => {
    const ctx = requireCreds();
    if (ctx) await ingestAction(ctx, text, opts);
  });
  root.command("list").description("List all user memories").action(async () => {
    const ctx = requireCreds();
    if (ctx) await listAction(ctx);
  });
  root.command("inspect").argument("<source_id>", "Source ID to fetch").action(async (sourceId) => {
    const ctx = requireCreds();
    if (ctx) await inspectAction(ctx, sourceId);
  });
  root.command("delete").argument("<memory_id>", "Memory ID to delete").action(async (memoryId) => {
    const ctx = requireCreds();
    if (ctx) await deleteAction(ctx, memoryId);
  });
  root.command("status").description("Show plugin configuration").action(() => {
    const ctx = requireCreds();
    if (ctx) statusAction(ctx);
  });
}
function registerLegacyCliCommands(root, client, cfg) {
  const requireCreds = makeRequireCreds(client, cfg);
  root.command("search").argument("<query>", "Search query").option("--limit <n>", "Max results", "10").action(async (query, opts) => {
    warnDeprecated("CLI command", "hydra search", "hydradb query");
    const ctx = requireCreds();
    if (ctx) await queryAction(ctx, query, opts);
  });
  root.command("list").description("List all user memories").action(async () => {
    warnDeprecated("CLI command", "hydra list", "hydradb list");
    const ctx = requireCreds();
    if (ctx) await listAction(ctx);
  });
  root.command("delete").argument("<memory_id>", "Memory ID to delete").action(async (memoryId) => {
    warnDeprecated("CLI command", "hydra delete", "hydradb delete");
    const ctx = requireCreds();
    if (ctx) await deleteAction(ctx, memoryId);
  });
  root.command("get").argument("<source_id>", "Source ID to fetch").action(async (sourceId) => {
    warnDeprecated("CLI command", "hydra get", "hydradb inspect");
    const ctx = requireCreds();
    if (ctx) await inspectAction(ctx, sourceId);
  });
  root.command("status").description("Show plugin configuration").action(() => {
    warnDeprecated("CLI command", "hydra status", "hydradb status");
    const ctx = requireCreds();
    if (ctx) statusAction(ctx);
  });
}
export {
  index_default as default
};
