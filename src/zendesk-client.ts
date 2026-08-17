/** Zendesk API client. Per-request credentials via AsyncLocalStorage. */

import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";

/** Per-request context carrying the user's Zendesk credentials. */
export interface RequestContext {
  accessToken: string;
  zendeskDomain: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

function getContext(): RequestContext {
  const ctx = requestContext.getStore();
  if (!ctx?.accessToken || !ctx?.zendeskDomain) {
    throw new Error(
      "Missing Zendesk credentials. The OAuth access token must be forwarded as " +
        "an Authorization: Bearer header, and ZENDESK_DOMAIN must be set as a container " +
        "env var or forwarded via X-MintMCP-Env-ZENDESK_DOMAIN."
    );
  }
  return ctx;
}

/** Default request timeout. */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ZendeskRequestOptions {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path: string; // e.g. "/api/v2/tickets.json"
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  timeoutMs?: number;
}

function buildUrl(zendeskDomain: string, path: string, query?: ZendeskRequestOptions["query"]): URL {
  const url = new URL(path, `https://${zendeskDomain}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === "") continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url;
}

/**
 * Retry-After is legally delta-seconds or an HTTP-date. Returns null when the value is
 * unusable, including an elapsed date; 0 is a legal wait, so callers must test for null
 * rather than falsiness. The letter gate keeps Date.parse from reading numeric junk like
 * "-5" as a year, and RFC 9110 wants the zoneless asctime form read as UTC
 */
function parseRetryAfterSeconds(header: string | null): number | null {
  const value = header?.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  if (!/[a-z]/i.test(value)) return null;
  const zoned = /\b(gmt|utc|[+-]\d{4})\b/i.test(value) ? value : `${value} GMT`;
  const asDate = Date.parse(zoned);
  if (Number.isNaN(asDate)) return null;
  const seconds = Math.ceil((asDate - Date.now()) / 1000);
  return seconds > 0 ? seconds : null;
}

export async function zendeskRequest<T = unknown>(opts: ZendeskRequestOptions): Promise<T> {
  const ctx = getContext();
  const url = buildUrl(ctx.zendeskDomain, opts.path, opts.query);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${ctx.accessToken}`,
    Accept: "application/json",
  };
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: opts.method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const truncated = text.length > 500 ? text.slice(0, 500) + "..." : text;
    // The Search API limit is far tighter than the plain REST endpoints, so a 429
    // must read as "wait" rather than as a generic retryable failure
    if (res.status === 429) {
      const wait = parseRetryAfterSeconds(res.headers.get("retry-after"));
      const guidance =
        wait !== null
          ? `retry after ${wait} seconds`
          : "no usable Retry-After was supplied, so wait at least 60 seconds";
      throw new Error(
        `Zendesk API 429: rate limited, ${guidance}. Do not retry sooner.` +
          (truncated ? ` Upstream: ${truncated}` : "")
      );
    }
    throw new Error(`Zendesk API ${res.status}: ${truncated || res.statusText}`);
  }

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return (await res.json()) as T;
  }
  return (await res.text()) as unknown as T;
}

// ─── Attachment fetch ───────────────────────────────────────────────────────

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const MAGIC_BYTES: Record<string, Uint8Array[]> = {
  "image/jpeg": [new Uint8Array([0xff, 0xd8, 0xff])],
  "image/png": [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  "image/gif": [
    new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]), // GIF87a
    new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), // GIF89a
  ],
  "image/webp": [new Uint8Array([0x52, 0x49, 0x46, 0x46])], // RIFF (+ WEBP at byte 8)
};

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// Zendesk accounts are always <subdomain>.zendesk.com, so that is the whole
// allowlist. Do NOT add a `u` flag: it would make [a-z] match unicode look-alikes.
export function isZendeskHost(host: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.zendesk\.com$/i.test(host);
}

/** Trusted hosts for attachment CDN redirects. */
function isZendeskAttachmentHost(hostname: string, zendeskDomain: string): boolean {
  // Exact zendeskDomain match for the Zendesk API host itself.
  if (hostname === zendeskDomain) return true;
  // Zendesk's CDN for attachment content.
  if (hostname === "zdusercontent.com") return true;
  if (hostname.endsWith(".zdusercontent.com")) return true;
  return false;
}

function startsWith(buf: Uint8Array, sig: Uint8Array): boolean {
  if (buf.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (buf[i] !== sig[i]) return false;
  return true;
}

export interface AttachmentResult {
  contentType: string;
  dataBase64: string;
}

export async function fetchAttachment(contentUrl: string): Promise<AttachmentResult> {
  const ctx = getContext();

  // Validate the URL is on the configured Zendesk zendeskDomain.
  let parsed: URL;
  try {
    parsed = new URL(contentUrl);
  } catch {
    throw new Error(`Invalid content_url: ${contentUrl}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`content_url must use https, got: ${parsed.protocol}`);
  }
  if (parsed.hostname !== ctx.zendeskDomain) {
    throw new Error(
      `content_url host '${parsed.hostname}' does not match configured domain ` +
        `'${ctx.zendeskDomain}'.`
    );
  }

  // Follow redirects manually. Strip auth on cross-origin hops.
  let currentUrl = parsed.toString();
  let sendAuth = true;
  let finalResponse: Response | null = null;
  const MAX_REDIRECTS = 3;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers: Record<string, string> = {};
    if (sendAuth) headers["Authorization"] = `Bearer ${ctx.accessToken}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(currentUrl, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    // Not a redirect — this is our final response.
    if (res.status < 300 || res.status >= 400) {
      finalResponse = res;
      break;
    }

    // Redirect: validate the next host before following.
    const location = res.headers.get("location");
    if (!location) {
      throw new Error(`Redirect ${res.status} with no Location header`);
    }
    let next: URL;
    try {
      next = new URL(location, currentUrl);
    } catch {
      throw new Error(`Invalid redirect Location: ${location}`);
    }
    if (next.protocol !== "https:") {
      throw new Error(`Refusing to follow non-https redirect to ${next.href}`);
    }
    if (!isZendeskAttachmentHost(next.hostname, ctx.zendeskDomain)) {
      throw new Error(
        `Refusing to follow redirect to untrusted host '${next.hostname}'. ` +
          "Zendesk attachments must redirect only to Zendesk or zdusercontent.com."
      );
    }
    if (next.hostname !== parsed.hostname) sendAuth = false;
    currentUrl = next.toString();
  }

  if (!finalResponse) {
    throw new Error(`Too many redirects (> ${MAX_REDIRECTS}) fetching attachment`);
  }
  if (!finalResponse.ok) {
    throw new Error(`Attachment fetch failed: ${finalResponse.status} ${finalResponse.statusText}`);
  }

  // MIME allowlist.
  const contentType = (finalResponse.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
    throw new Error(
      `Attachment type '${contentType}' is not allowed. Supported: ${[...ALLOWED_IMAGE_TYPES].join(", ")}`
    );
  }

  // Size-capped streaming read.
  const reader = finalResponse.body?.getReader();
  if (!reader) {
    throw new Error("Attachment response had no body");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ATTACHMENT_BYTES) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      throw new Error(
        `Attachment exceeds ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB size limit`
      );
    }
    chunks.push(value);
  }

  const body = Buffer.concat(chunks);

  // Magic byte validation.
  const signatures = MAGIC_BYTES[contentType] ?? [];
  const bodyView = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (signatures.length && !signatures.some((sig) => startsWith(bodyView, sig))) {
    throw new Error(
      `File header does not match declared content type '${contentType}'. Attachment may be spoofed.`
    );
  }
  // Extra check for WebP: bytes 8-11 must be 'WEBP'.
  if (contentType === "image/webp") {
    const webpMarker = body.subarray(8, 12).toString("ascii");
    if (webpMarker !== "WEBP") {
      throw new Error("File header does not match declared content type 'image/webp'.");
    }
  }

  return {
    contentType,
    dataBase64: body.toString("base64"),
  };
}

// ─── Convenience helpers over zendeskRequest ────────────────────────────────

export async function getAttachment(id: number): Promise<unknown> {
  const res = await zendeskRequest<{ attachment: unknown }>({
    method: "GET",
    path: `/api/v2/attachments/${id}.json`,
  });
  return res.attachment;
}

export async function getTicket(id: number): Promise<unknown> {
  const res = await zendeskRequest<{ ticket: unknown }>({
    method: "GET",
    path: `/api/v2/tickets/${id}.json`,
  });
  return res.ticket;
}

export async function listTickets(params: {
  page?: number;
  sort_by?: string;
  sort_order?: "asc" | "desc";
}): Promise<unknown> {
  const perPage = 20;
  return zendeskRequest({
    method: "GET",
    path: "/api/v2/tickets.json",
    query: {
      page: params.page ?? 1,
      per_page: perPage,
      sort_by: params.sort_by ?? "created_at",
      sort_order: params.sort_order ?? "desc",
    },
  });
}

export async function getTicketComments(
  ticketId: number,
  params?: { page?: number }
): Promise<unknown> {
  const perPage = 5;
  return zendeskRequest({
    method: "GET",
    path: `/api/v2/tickets/${ticketId}/comments.json`,
    query: {
      page: params?.page ?? 1,
      per_page: perPage,
    },
  });
}

export async function listTicketForms(params?: { page?: number }): Promise<unknown> {
  return zendeskRequest({
    method: "GET",
    path: "/api/v2/ticket_forms.json",
    query: {
      page: params?.page ?? 1,
      per_page: 20,
    },
  });
}

export async function searchTickets(query: string, params?: { page?: number }): Promise<unknown> {
  return zendeskRequest({
    method: "GET",
    path: "/api/v2/search.json",
    query: {
      query: `type:ticket ${query}`,
      page: params?.page ?? 1,
      per_page: 20,
    },
  });
}

export const MAX_USER_SEARCH_QUERY_LENGTH = 512;

/** Deep paging is the mechanism for exporting a user directory, so it is capped */
export const MAX_USER_SEARCH_PAGE = 2;

function buildUserSearchQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error(
      "search_users requires a non-empty query. Provide a search term such as " +
        'email:"a@b.com", a name, or role:end-user.'
    );
  }
  if (trimmed.length > MAX_USER_SEARCH_QUERY_LENGTH) {
    throw new Error(
      `search_users query must be ${MAX_USER_SEARCH_QUERY_LENGTH} characters or fewer ` +
        `(got ${trimmed.length}).`
    );
  }
  // Word-anchored so a legitimate name search like "prototype:" still passes
  if (/\btype\s*:/i.test(trimmed)) {
    throw new Error(
      "search_users query must not contain a 'type:' term. This tool always searches " +
        "type:user; use search_tickets for tickets."
    );
  }
  return `type:user ${trimmed}`;
}

export async function searchUsers(query: string, params?: { page?: number }): Promise<unknown> {
  const page = params?.page ?? 1;
  if (page > MAX_USER_SEARCH_PAGE) {
    throw new Error(
      `search_users serves at most ${MAX_USER_SEARCH_PAGE} pages. Narrow the query instead of paging.`
    );
  }
  return zendeskRequest({
    method: "GET",
    path: "/api/v2/search.json",
    query: {
      query: buildUserSearchQuery(query),
      page,
      per_page: 20,
    },
  });
}

export async function listMacros(params?: {
  page?: number;
  active?: boolean;
}): Promise<unknown> {
  const perPage = 20;
  return zendeskRequest({
    method: "GET",
    path: "/api/v2/macros.json",
    query: {
      page: params?.page ?? 1,
      per_page: perPage,
      active: params?.active === undefined ? undefined : String(params.active),
      // Zendesk defaults this to false, which for an admin token lists the
      // personal macros of every other agent.
      only_viewable: params?.active === false ? undefined : "true",
    },
  });
}

export async function getMacro(id: number): Promise<unknown> {
  const res = await zendeskRequest<{ macro: unknown }>({
    method: "GET",
    path: `/api/v2/macros/${id}.json`,
  });
  return res.macro;
}

export async function applyMacroToTicket(
  ticketId: number,
  macroId: number
): Promise<unknown> {
  // normalize_comment makes newlines match what the ticket comment editor
  // produces, which is where this body is headed.
  const res = await zendeskRequest<{ result?: { ticket?: unknown } }>({
    method: "GET",
    path: `/api/v2/tickets/${ticketId}/macros/${macroId}/apply.json`,
    query: { normalize_comment: "true" },
  });
  return res.result?.ticket;
}

// ─── Mutating operations ────────────────────────────────────────────────────

// Allowlisted fields for update_ticket.
const UPDATE_TICKET_FIELDS = [
  "subject",
  "status",
  "priority",
  "type",
  "assignee_id",
  "requester_id",
  "tags",
  "custom_fields",
  "due_at",
  "ticket_form_id",
] as const;
export type UpdateTicketField = (typeof UPDATE_TICKET_FIELDS)[number];

export async function updateTicket(
  ticketId: number,
  fields: Partial<Record<UpdateTicketField, unknown>>
): Promise<unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const key of UPDATE_TICKET_FIELDS) {
    if (fields[key] !== undefined) cleaned[key] = fields[key];
  }
  const res = await zendeskRequest<{ ticket: unknown }>({
    method: "PUT",
    path: `/api/v2/tickets/${ticketId}.json`,
    body: { ticket: cleaned },
  });
  return res.ticket;
}

const CREATE_TICKET_FIELDS = [
  "subject",
  "description",
  "requester_id",
  "assignee_id",
  "priority",
  "type",
  "tags",
  "custom_fields",
  "ticket_form_id",
] as const;
export type CreateTicketField = (typeof CREATE_TICKET_FIELDS)[number];

export async function createTicket(
  fields: Partial<Record<CreateTicketField, unknown>> & {
    subject: string;
    description: string;
    first_comment_visibility?: "public" | "internal";
  }
): Promise<unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const key of CREATE_TICKET_FIELDS) {
    if (fields[key] !== undefined) cleaned[key] = fields[key];
  }
  // Refuse anything unrecognised rather than guessing: this helper is exported, so a
  // caller outside the Zod-validated path could otherwise email the customer an
  // unapproved draft. Omission stays public to preserve the original behaviour
  const requested: unknown =
    fields.first_comment_visibility === undefined ? "public" : fields.first_comment_visibility;
  if (requested !== "public" && requested !== "internal") {
    throw new Error(
      `Unsupported first_comment_visibility ${JSON.stringify(requested)}. Expected "public" or "internal".`
    );
  }
  // Zendesk requires a "comment" with body for ticket creation. public:false files it
  // as an internal note, which is what suppresses the default requester notification
  const ticket = {
    ...cleaned,
    comment: {
      body: fields.description,
      public: requested === "public",
    },
  };
  const res = await zendeskRequest<{ ticket: unknown }>({
    method: "POST",
    path: "/api/v2/tickets.json",
    body: { ticket },
  });
  return res.ticket;
}

export async function createTicketComment(
  ticketId: number,
  comment: string,
  opts: { public: boolean; html?: boolean }
): Promise<unknown> {
  // Zendesk renders html_body as rich text; body is delivered as plain text, so
  // markup sent through it reaches the customer as visible tags.
  const payload = opts.html
    ? { html_body: comment, public: opts.public }
    : { body: comment, public: opts.public };
  const res = await zendeskRequest<{ ticket: unknown }>({
    method: "PUT",
    path: `/api/v2/tickets/${ticketId}.json`,
    body: { ticket: { comment: payload } },
  });
  return res.ticket;
}

