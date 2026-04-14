# Zendesk MCP Server

Streamable HTTP MCP server for Zendesk. Stateless — OAuth access token arrives per-request via `Authorization: Bearer` header.

## Authentication

| Field | Source |
|---|---|
| Access token | `Authorization: Bearer <token>` header (MintMCP `headerMapping`) |
| Subdomain | `SUBDOMAIN` env var or `X-MintMCP-Env-SUBDOMAIN` header |

## Tools

- `get_ticket` — fetch a ticket by ID
- `get_tickets` — paginated ticket list with sort (20/page)
- `search_tickets` — Zendesk search syntax (20/page)
- `get_ticket_comments` — comment thread with attachment metadata (5/page)
- `get_ticket_attachment` — fetch image by attachment ID (jpeg/png/gif/webp, ≤10MB)
- `create_ticket` — create a ticket (strict schema)
- `update_ticket` — update ticket fields (strict schema)
- `create_ticket_comment` — add public comment or internal note

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
  -e SUBDOMAIN=your_subdomain \
  zendesk-mcp
```
