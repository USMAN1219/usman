/**
 * Converts a Zod schema into the strict JSON Schema subset accepted by Claude
 * structured outputs: every object closed (additionalProperties: false) with
 * all properties required, enums kept (so the API enforces them), and
 * unsupported keywords (numeric/string bounds, maxItems, ...) removed - those
 * are still enforced locally by Zod when the response is validated.
 */
import { z } from "zod";

const DROP = new Set([
  "$schema",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "maxItems",
  "uniqueItems",
  "default",
  "examples",
]);

function strict(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strict);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (DROP.has(k)) continue;
    if (k === "minItems" && v !== 0 && v !== 1) continue;
    out[k] = k === "properties" || k === "$defs" ? Object.fromEntries(Object.entries(v as object).map(([pk, pv]) => [pk, strict(pv)])) : strict(v);
  }
  if (out.type === "object") {
    out.additionalProperties = false;
    out.required = Object.keys((out.properties as object) ?? {});
  }
  return out;
}

export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return strict(z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "throw" })) as Record<string, unknown>;
}
