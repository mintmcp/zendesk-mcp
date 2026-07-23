# Zendesk MCP Server

Streamable HTTP MCP server for Zendesk. Stateless — OAuth access token arrives per-request via `Authorization: Bearer` header.

## Authentication

| Field | Source |
|---|---|
| Access token | `Authorization: Bearer <token>` header (MintMCP `headerMapping`) |
| Zendesk domain | `ZENDESK_DOMAIN` env var or `X-MintMCP-Env-ZENDESK_DOMAIN` header |

## Tools

- `get_ticket` — fetch a ticket by ID
- `get_tickets` — paginated ticket list with sort (20/page)
- `search_tickets` — Zendesk search syntax (20/page)
- `get_ticket_comments` — comment thread with attachment metadata (5/page)
- `get_ticket_attachment` — fetch image by attachment ID (jpeg/png/gif/webp, ≤10MB)
- `create_ticket` — create a ticket (strict schema)
- `update_ticket` — update ticket fields (strict schema)
- `create_ticket_comment_public` — add a public comment, visible to the requester
- `create_ticket_comment_internal` — add an internal note, not visible to the requester

All tools return structured content via `outputSchema` + `structuredContent`. Page sizes are fixed server-side.

## Development

```bash
npm install
npm run build
npm run dev          # tsx watch mode
```

## Docker

```bash
docker build -t zendesk-mcp .
docker run --rm -p 8000:8000 \
  -e ZENDESK_DOMAIN=your_subdomain.zendesk.com \
  zendesk-mcp
```
