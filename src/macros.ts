/** Pure shaping and output contract for Zendesk macro objects. No I/O. */

import { z } from "zod";

interface MacroAction {
  field: string;
  value: unknown;
}

const MAX_ACTIONS = 50;
const MAX_COMMENT_CHARS = 20_000;
// Kept below a usable message length so the raw passthrough is not postable content.
const MAX_ACTION_VALUE_CHARS = 2_000;

const COMMENT_BODY_FIELDS = new Set(["comment_value", "comment_value_html"]);
const COMMENT_ACTION_FIELDS = new Set([...COMMENT_BODY_FIELDS, "comment_mode_is_public"]);

const WITHHELD_MARKER = "[withheld: exceeds the size cap, read this macro in Zendesk]";
const CAPPED_SUFFIX = "...[capped]";

// Zendesk macro bodies support Liquid control tags as well as {{...}} substitutions,
// and either one left unrendered would reach the customer verbatim.
const PLACEHOLDER_PATTERN = /\{\{|\{%/;

// The apply endpoint returns rich text only when the macro has no plain-text
// fallback, and never says which it sent, so the body itself is the only signal.
const HTML_TAG_PATTERN = /<\/?[a-z][a-z0-9]*(\s[^>]*)?>/i;

// ─── Output contract ────────────────────────────────────────────────────────

const MacroActionSchema = z.object({ field: z.string(), value: z.unknown() });

const MacroSummaryShape = {
  id: z.number(),
  title: z.string(),
  description: z.string().nullable(),
  active: z.boolean(),
  position: z.number().nullable(),
  updated_at: z.string().nullable(),
};

export const MacroSummarySchema = z.object(MacroSummaryShape);

const MacroCommentShape = {
  comment_withheld: z.boolean(),
  comment_public: z.boolean().nullable(),
  comment_channel: z.string().nullable(),
  contains_placeholders: z.boolean(),
};

export const MacroDetailShape = {
  ...MacroSummaryShape,
  ...MacroCommentShape,
  created_at: z.string().nullable(),
  comment_template: z.string().nullable(),
  comment_is_html: z.boolean(),
  field_changes: z.array(MacroActionSchema),
  actions: z.array(MacroActionSchema),
  actions_truncated: z.boolean(),
};

export const MacroApplyShape = {
  ...MacroCommentShape,
  ticket_id: z.number(),
  macro_id: z.number(),
  comment_body: z.string().nullable(),
  send_as_html: z.boolean(),
};

// ─── Shaping ────────────────────────────────────────────────────────────────

// A macro comment action holds either the text or a [channel, text] pair.
function readText(value: unknown): string | null {
  if (Array.isArray(value)) return typeof value[1] === "string" ? value[1] : null;
  return typeof value === "string" ? value : null;
}

function readChannel(value: unknown): string | null {
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : null;
}

function normalizeActions(raw: unknown): MacroAction[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a: any) => typeof a?.field === "string")
    .map((a: any) => ({ field: a.field as string, value: a.value }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Zendesk returned an unexpected ${label} payload (expected an object).`);
  }
  return value;
}

function isOversized(text: string | null): boolean {
  return text !== null && text.length > MAX_COMMENT_CHARS;
}

function containsPlaceholders(body: string | null): boolean {
  return body !== null && PLACEHOLDER_PATTERN.test(body);
}

function describeCommentBody(body: string | null) {
  const withheld = isOversized(body);
  return {
    body: withheld ? null : body,
    comment_withheld: withheld,
    contains_placeholders: containsPlaceholders(body),
  };
}

function hasOversizedBody(actions: MacroAction[]): boolean {
  return actions.some((a) => COMMENT_BODY_FIELDS.has(a.field) && isOversized(readText(a.value)));
}

function capActionValue(value: unknown): { value: unknown; capped: boolean } {
  let capped = false;
  const cap = (text: string) => {
    if (text.length <= MAX_ACTION_VALUE_CHARS) return text;
    capped = true;
    return text.slice(0, MAX_ACTION_VALUE_CHARS) + CAPPED_SUFFIX;
  };

  if (typeof value === "string") return { value: cap(value), capped };
  if (Array.isArray(value) && value.every((e) => typeof e === "string")) {
    return { value: value.map(cap), capped };
  }
  if (value !== null && typeof value === "object") {
    const json = JSON.stringify(value) ?? "";
    if (json.length > MAX_ACTION_VALUE_CHARS) return { value: WITHHELD_MARKER, capped: true };
  }
  return { value, capped: false };
}

// Bodies are redacted in lockstep with comment_template, so a withheld body
// cannot leak back here as a partial message.
function shapeActions(
  actions: MacroAction[],
  redactBodies: boolean
): { actions: MacroAction[]; truncated: boolean } {
  let truncated = actions.length > MAX_ACTIONS;
  const out = actions.slice(0, MAX_ACTIONS).map((action) => {
    if (redactBodies && COMMENT_BODY_FIELDS.has(action.field)) {
      truncated = true;
      const channel = readChannel(action.value);
      const value = channel === null
        ? WITHHELD_MARKER
        : [capActionValue(channel).value, WITHHELD_MARKER];
      return { field: action.field, value };
    }
    const result = capActionValue(action.value);
    truncated = truncated || result.capped;
    return { field: action.field, value: result.value };
  });
  return { actions: out, truncated };
}

function extractComment(actions: MacroAction[]) {
  const html = actions.find((a) => a.field === "comment_value_html");
  const plain = actions.find((a) => a.field === "comment_value");
  const mode = actions.find((a) => a.field === "comment_mode_is_public");

  const source = readText(html?.value) !== null ? html : plain;
  const { body, ...bodyFields } = describeCommentBody(readText(source?.value));

  return {
    comment_template: body,
    ...bodyFields,
    comment_is_html: source === html && html !== undefined,
    // Channel scoping is stored on comment_value, so it survives preferring the HTML body.
    comment_channel: readChannel(source?.value) ?? readChannel(plain?.value),
    // Zendesk stringifies booleans in macro actions.
    comment_public: mode ? mode.value === true || mode.value === "true" : null,
  };
}

export function shapeMacroSummary(raw: unknown) {
  const m = requireObject(raw, "macro");
  if (typeof m.id !== "number" || typeof m.title !== "string") {
    throw new Error("Zendesk returned a macro without a numeric id and string title.");
  }
  return {
    id: m.id,
    title: m.title,
    description: m.description ?? null,
    active: m.active ?? true,
    position: m.position ?? null,
    updated_at: m.updated_at ?? null,
  };
}

export function shapeMacroDetail(raw: unknown) {
  const m = requireObject(raw, "macro");
  const allActions = normalizeActions(m.actions);
  const { actions, truncated } = shapeActions(allActions, hasOversizedBody(allActions));

  return {
    ...shapeMacroSummary(m),
    created_at: m.created_at ?? null,
    ...extractComment(allActions),
    field_changes: actions.filter((a) => !COMMENT_ACTION_FIELDS.has(a.field)),
    actions,
    actions_truncated: truncated,
  };
}

// Show Ticket After Changes returns the WHOLE ticket, not a change list, so its
// non-comment keys are the ticket itself and are not the macro's field changes.
export function shapeMacroApply(ticketId: number, macroId: number, raw: unknown) {
  const ticket = requireObject(raw, "macro apply result");
  const comment = isRecord(ticket.comment) ? ticket.comment : {};
  const rendered = typeof comment.body === "string" ? comment.body : null;
  const { body, ...bodyFields } = describeCommentBody(rendered);
  const scoped = Array.isArray(comment.scoped_body) ? comment.scoped_body[0] : null;

  return {
    ticket_id: ticketId,
    macro_id: macroId,
    comment_body: body,
    ...bodyFields,
    comment_public: typeof comment.public === "boolean" ? comment.public : null,
    comment_channel: readChannel(scoped),
    send_as_html: rendered !== null && HTML_TAG_PATTERN.test(rendered),
  };
}
