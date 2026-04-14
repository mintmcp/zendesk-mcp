/**
 * Zendesk MCP server — streamable HTTP, stateless.
 * OAuth token via Authorization header, subdomain via env var.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import {
  requestContext,
  getTicket,
  listTickets,
  getTicketComments,
  searchTickets,
  getAttachment,
  fetchAttachment,
  updateTicket,
  createTicket,
  createTicketComment,
} from "./zendesk-client.js";

const server = new McpServer({ name: "zendesk", version: "1.0.0" });

// ─── Output shaping ──────────────────────────────────────────────────────────
//
// Shape raw Zendesk API responses into clean, consistent objects that match
// the declared outputSchema for each tool.

function shapeTicketSummary(t: any) {
  return {
    id: t.id,
    subject: t.subject,
    status: t.status,
    priority: t.priority ?? null,
    type: t.type ?? null,
    created_at: t.created_at,
    updated_at: t.updated_at,
    requester_id: t.requester_id,
    assignee_id: t.assignee_id ?? null,
    group_id: t.group_id ?? null,
    tags: t.tags ?? [],
    via_channel: t.via?.channel ?? null,
  };
}

function shapeTicketDetail(t: any) {
  return {
    ...shapeTicketSummary(t),
    description: t.description ?? null,
    organization_id: t.organization_id ?? null,
    submitter_id: t.submitter_id ?? null,
    due_at: t.due_at ?? null,
    problem_id: t.problem_id ?? null,
    has_incidents: t.has_incidents ?? false,
    is_public: t.is_public ?? true,
    satisfaction_rating: t.satisfaction_rating?.score ?? null,
    custom_fields: (t.custom_fields ?? []).filter((f: any) => f.value != null),
    collaborator_ids: t.collaborator_ids ?? [],
    brand_id: t.brand_id ?? null,
  };
}

function shapeComment(c: any) {
  return {
    id: c.id,
    author_id: c.author_id,
    body: c.body ?? c.plain_body ?? "",
    public: c.public ?? true,
    created_at: c.created_at,
    attachments: (c.attachments ?? []).map((a: any) => ({
      id: a.id,
      file_name: a.file_name,
      content_type: a.content_type,
      size: a.size,
    })),
  };
}

function structured(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

// ─── Reusable schema fragments ────────────────────────────────────────────────

const TicketSummaryShape = {
  id: z.number(),
  subject: z.string(),
  status: z.string(),
  priority: z.string().nullable(),
  type: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  requester_id: z.number(),
  assignee_id: z.number().nullable(),
  group_id: z.number().nullable(),
  tags: z.array(z.string()),
  via_channel: z.string().nullable(),
};

const CustomFieldSchema = z.object({ id: z.number(), value: z.unknown() });

const TicketDetailShape = {
  ...TicketSummaryShape,
  description: z.string().nullable(),
  organization_id: z.number().nullable(),
  submitter_id: z.number().nullable(),
  due_at: z.string().nullable(),
  problem_id: z.number().nullable(),
  has_incidents: z.boolean(),
  is_public: z.boolean(),
  satisfaction_rating: z.string().nullable(),
  custom_fields: z.array(CustomFieldSchema),
  collaborator_ids: z.array(z.number()),
  brand_id: z.number().nullable(),
};

const AttachmentSchema = z.object({
  id: z.number(),
  file_name: z.string(),
  content_type: z.string(),
  size: z.number(),
});

const CommentShape = {
  id: z.number(),
  author_id: z.number(),
  body: z.string(),
  public: z.boolean(),
  created_at: z.string(),
  attachments: z.array(AttachmentSchema),
};

const PaginationShape = {
  count: z.number(),
  next_page: z.string().nullable(),
  previous_page: z.string().nullable(),
};

// ─── Read-only tools ────────────────────────────────────────────────────────

server.registerTool(
  "get_ticket",
  {
    description:
      "Retrieve a Zendesk ticket by its ID. Returns full detail including description and custom fields.",
    inputSchema: {
      ticket_id: z.number().int().positive().describe("The ID of the ticket to retrieve"),
    },
    outputSchema: TicketDetailShape,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ ticket_id }) => {
    const ticket = await getTicket(ticket_id);
    return structured(shapeTicketDetail(ticket));
  }
);

server.registerTool(
  "get_tickets",
  {
    description: "List tickets with pagination.",
    inputSchema: {
      page: z.number().int().positive().optional().describe("Page number (1-based)"),
      sort_by: z
        .enum(["created_at", "updated_at", "priority", "status"])
        .optional()
        .describe("Field to sort by"),
      sort_order: z.enum(["asc", "desc"]).optional().describe("Sort order"),
    },
    outputSchema: {
      tickets: z.array(z.object(TicketSummaryShape)),
      ...PaginationShape,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => {
    const raw = (await listTickets(args)) as any;
    const data = {
      tickets: (raw.tickets ?? []).map(shapeTicketSummary),
      count: raw.count ?? 0,
      next_page: raw.next_page ?? null,
      previous_page: raw.previous_page ?? null,
    };
    return structured(data);
  }
);

server.registerTool(
  "search_tickets",
  {
    description:
      "Search tickets using Zendesk search syntax (e.g. 'status:open priority:high'). See Zendesk search reference for operators.",
    inputSchema: {
      query: z.string().min(1).describe("Zendesk search query (type:ticket is added automatically)"),
      page: z.number().int().positive().optional().describe("Page number (1-based)"),
    },
    outputSchema: {
      results: z.array(z.object(TicketSummaryShape)),
      ...PaginationShape,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ query, page }) => {
    const raw = (await searchTickets(query, { page })) as any;
    const data = {
      results: (raw.results ?? []).map(shapeTicketSummary),
      count: raw.count ?? 0,
      next_page: raw.next_page ?? null,
      previous_page: raw.previous_page ?? null,
    };
    return structured(data);
  }
);

server.registerTool(
  "get_ticket_comments",
  {
    description:
      "Retrieve comments for a ticket with pagination. Includes attachment metadata (use attachment id with get_ticket_attachment).",
    inputSchema: {
      ticket_id: z.number().int().positive().describe("The ID of the ticket"),
      page: z.number().int().positive().optional().describe("Page number (1-based)"),
    },
    outputSchema: {
      comments: z.array(z.object(CommentShape)),
      ...PaginationShape,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ ticket_id, page }) => {
    const raw = (await getTicketComments(ticket_id, { page })) as any;
    const data = {
      comments: (raw.comments ?? []).map(shapeComment),
      count: raw.count ?? 0,
      next_page: raw.next_page ?? null,
      previous_page: raw.previous_page ?? null,
    };
    return structured(data);
  }
);

server.registerTool(
  "get_ticket_attachment",
  {
    description:
      "Fetch an image attachment (jpeg/png/gif/webp, ≤10MB) by its attachment ID from get_ticket_comments.",
    inputSchema: {
      attachment_id: z.number().int().positive().describe("The attachment id from get_ticket_comments"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ attachment_id }) => {
    const meta = await getAttachment(attachment_id);
    const { contentType, dataBase64 } = await fetchAttachment((meta as any).content_url);
    return {
      content: [
        { type: "image" as const, data: dataBase64, mimeType: contentType },
      ],
    };
  }
);

// ─── Mutating tools ───────────────────────────────────────────────────────

const MUTATION_WARNING =
  " IMPORTANT: This is a mutating action. Confirm with the user BEFORE calling this tool — show them the exact content/fields you plan to send and wait for explicit approval.";

const CreateTicketSchema = z
  .object({
    subject: z.string().min(1).describe("Ticket subject"),
    description: z.string().min(1).describe("Ticket description / first comment body"),
    requester_id: z.number().int().positive().optional(),
    assignee_id: z.number().int().positive().optional(),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    type: z.enum(["problem", "incident", "question", "task"]).optional(),
    tags: z.array(z.string()).optional(),
    custom_fields: z
      .array(z.object({ id: z.number().int().positive(), value: z.unknown() }).strict())
      .optional(),
  })
  .strict();

server.registerTool(
  "create_ticket",
  {
    description: "Create a new Zendesk ticket." + MUTATION_WARNING,
    inputSchema: CreateTicketSchema,
    outputSchema: { message: z.string(), ticket: z.object(TicketDetailShape) },
    annotations: { openWorldHint: true },
  },
  async (args: z.infer<typeof CreateTicketSchema>) => {
    const ticket = await createTicket(args);
    const data = { message: "Ticket created", ticket: shapeTicketDetail(ticket) };
    return structured(data);
  }
);

const UpdateTicketSchema = z
  .object({
    ticket_id: z.number().int().positive().describe("The ID of the ticket to update"),
    subject: z.string().optional(),
    status: z.enum(["new", "open", "pending", "hold", "solved", "closed"]).optional(),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    type: z.enum(["problem", "incident", "question", "task"]).optional(),
    assignee_id: z.number().int().positive().optional(),
    requester_id: z.number().int().positive().optional(),
    tags: z.array(z.string()).optional(),
    custom_fields: z
      .array(z.object({ id: z.number().int().positive(), value: z.unknown() }).strict())
      .optional(),
    due_at: z.string().optional().describe("ISO-8601 datetime"),
  })
  .strict();

server.registerTool(
  "update_ticket",
  {
    description:
      "Update fields on an existing Zendesk ticket (status, priority, assignee, etc.). Only the fields in this schema may be updated." +
      MUTATION_WARNING,
    inputSchema: UpdateTicketSchema,
    outputSchema: { message: z.string(), ticket: z.object(TicketDetailShape) },
    annotations: { openWorldHint: true },
  },
  async (args: z.infer<typeof UpdateTicketSchema>) => {
    const { ticket_id, ...fields } = args;
    const ticket = await updateTicket(ticket_id, fields);
    const data = { message: "Ticket updated", ticket: shapeTicketDetail(ticket) };
    return structured(data);
  }
);

server.registerTool(
  "create_ticket_comment",
  {
    description:
      "Add a comment to an existing ticket. Set public=false for an internal note." + MUTATION_WARNING,
    inputSchema: {
      ticket_id: z.number().int().positive(),
      comment: z.string().min(1).describe("Comment body (HTML or plain text)"),
      public: z.boolean().default(true).describe("Whether the comment is visible to the requester"),
    },
    outputSchema: { message: z.string(), ticket_id: z.number() },
    annotations: { destructiveHint: false, openWorldHint: true },
  },
  async ({ ticket_id, comment, public: isPublic }) => {
    await createTicketComment(ticket_id, comment, isPublic);
    return structured({ message: `Comment created on ticket ${ticket_id}`, ticket_id });
  }
);

// ─── HTTP transport ─────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "4mb" }));

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/mcp", async (req, res) => {
  // Access token: MintMCP forwards the OAuth token as `Authorization: Bearer <token>`.
  // Subdomain: global env var set on the container, or per-request via X-MintMCP-Env-SUBDOMAIN.
  const authHeader = req.headers["authorization"] ?? "";
  const accessToken = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : "";
  const subdomainHeader = req.headers["x-mintmcp-env-subdomain"];
  const subdomain = (typeof subdomainHeader === "string" ? subdomainHeader : "")
    || process.env.SUBDOMAIN
    || "";

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  requestContext.run({ accessToken, subdomain }, async () => {
    try {
      res.on("close", () => transport.close());
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });
});

const PORT = parseInt(process.env.PORT || "8000", 10);
app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Zendesk MCP server listening on 0.0.0.0:${PORT}/mcp`
  );
});
