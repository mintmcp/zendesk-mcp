# Zendesk MCP Server

Streamable HTTP MCP server for Zendesk. Stateless — OAuth access token arrives per-request via `Authorization: Bearer` header.

## Transport

Streamable HTTP (stateless). Listens on `POST /mcp` and exposes a `GET /healthz` liveness probe.

## Authentication

| Field | Source | Details |
|---|---|---|
| Access token | `Authorization: Bearer <token>` header | MintMCP forwards the OAuth token per-request via `headerMapping` |
| Subdomain | `SUBDOMAIN` env var or `X-MintMCP-Env-SUBDOMAIN` header | Global env var for single-tenant, or per-request header for multi-tenant |

Users complete the OAuth flow through MintMCP. MintMCP forwards the resulting access token as `Authorization: Bearer <token>` on every MCP request. API tokens and other Zendesk credential types are not supported — OAuth bearer auth only.

## Modes

`ZENDESK_MCP_MODE=readonly` (default) or `readwrite`. In readonly mode the mutating tools are not registered and cannot be called.

## Tools

**Read (always available):**
- `get_ticket` — fetch a ticket by ID (full detail with description, custom fields)
- `get_tickets` — paginated ticket list with sort (20/page)
- `search_tickets` — Zendesk search syntax, e.g. `status:open priority:high` (20/page)
- `get_ticket_comments` — comment thread with attachment metadata (5/page)
- `get_ticket_attachment` — fetch image by attachment ID (jpeg/png/gif/webp, ≤10MB)

**Write (readwrite mode only):**
- `create_ticket` — strict schema, unknown fields rejected
- `update_ticket` — strict schema, allowlisted fields only
- `create_ticket_comment` — add public comment or internal note

All tools return structured content via `outputSchema` + `structuredContent`. Page sizes are fixed server-side — the model can only advance pages, not control batch size.

## Security

### SSRF and credential leak in attachment fetch

`get_ticket_attachment` resolves attachment URLs server-side (the model passes an `attachment_id`, never a URL). The fetch path in `zendesk-client.ts` has six layered defenses:

1. URL must be `https://<configured subdomain>.zendesk.com/...`.
2. Redirects followed manually (max 3 hops), every hop validated against host allowlist.
3. Authorization header stripped on cross-origin redirects.
4. Non-`https` redirects refused.
5. MIME allowlist: `image/jpeg`, `image/png`, `image/gif`, `image/webp` only.
6. Magic byte validation + 10MB streaming size cap.

### Field mutation restrictions

Mutating tools use `.strict()` zod schemas — unknown keys are rejected at the MCP boundary. An explicit field allowlist in the client re-filters before the API call (defense in depth).

### Prompt injection

Ticket content is user-authored and may contain prompt-injection attempts. Mitigations:
- Readwrite mode must be explicitly opted in via `ZENDESK_MCP_MODE=readwrite`.
- Mutating tool descriptions require user confirmation before execution.
- Server instructions warn the model to treat ticket content as data, not commands.

### Blocking I/O

All HTTP calls use native `fetch` with explicit `AbortController` 30s timeouts.

## Development

```bash
npm install
npm run build
npm run dev          # tsx watch mode
```

Local smoke test:

```bash
export ZENDESK_MCP_MODE=readwrite
export SUBDOMAIN=your_subdomain
npm run build && node dist/server.js

curl -X POST http://localhost:8000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $YOUR_OAUTH_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Docker

```bash
docker build -t zendesk-mcp .
docker run --rm -p 8000:8000 \
  -e ZENDESK_MCP_MODE=readonly \
  -e SUBDOMAIN=your_subdomain \
  zendesk-mcp
```

Base image is `node:22-slim`. Final stage installs production deps only, drops to the `node` user, exposes port 8000.

## Dependencies

- `@modelcontextprotocol/sdk`, `express`, `zod` — zero other runtime deps.
- No axios (avoiding its SSRF/XSRF CVE history).
