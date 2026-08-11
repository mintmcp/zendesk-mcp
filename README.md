# Zendesk MCP Server

Streamable HTTP MCP server for Zendesk. Stateless — OAuth access token arrives per-request via `Authorization: Bearer` header.

## Authentication

| Field | Source |
|---|---|
| Access token | `Authorization: Bearer <token>` header (MintMCP `headerMapping`) |
| Zendesk domain | `ZENDESK_DOMAIN` env var or `X-MintMCP-Env-ZENDESK_DOMAIN` header |

`search_users` needs read access to users and an agent-role token (user search is Admin/Agent/Light Agent only). The MintMCP registry entry requests Zendesk's blanket `read` scope, which already covers it, so no separate `users:read` grant or re-authorization is required. Scopes are requested by the registry entry, not by this repo.

## Tools

- `get_ticket` — fetch a ticket by ID
- `get_tickets` — paginated ticket list with sort (20/page)
- `search_tickets` — Zendesk search syntax (20/page)
- `search_users` — Zendesk user search syntax (20/page, max page 2, capped to limit directory enumeration); resolve an email to a `requester_id`. The query must be non-blank, at most 512 characters, and may not contain a `type:` term; results lag the index by about a minute. Note that Zendesk `email:` matching is **not** exact even when quoted (it also matches addresses starting with the value), so the caller must compare the returned `email` before trusting an id
- `get_ticket_forms` — list configured ticket forms to discover `ticket_form_id` (20/page)
- `get_ticket_comments` — comment thread with attachment metadata (5/page)
- `get_ticket_attachment` — fetch image by attachment ID (jpeg/png/gif/webp, ≤10MB)
- `list_macros` — paginated macro list, titles and IDs only (20/page)
- `get_macro` — a macro's stored content; the comment is a template and may hold unresolved `{{placeholders}}`
- `apply_macro_to_ticket` — preview a macro against a ticket with placeholders resolved; does not modify the ticket
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
