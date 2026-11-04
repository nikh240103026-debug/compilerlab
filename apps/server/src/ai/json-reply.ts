import { z } from 'zod';

// The only JSON Schema keywords Gemini's responseJsonSchema documents. Others may be rejected.
const SUPPORTED_KEYWORDS = new Set([
  '$id',
  '$defs',
  '$ref',
  '$anchor',
  'type',
  'format',
  'title',
  'description',
  'enum',
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'anyOf',
  'oneOf',
  'properties',
  'additionalProperties',
  'required',
]);

function clean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(clean);
  if (typeof node !== 'object' || node === null) return node;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'const') {
      result.enum = [value];
    } else if (!SUPPORTED_KEYWORDS.has(key)) {
      continue;
    } else if (key === 'properties' || key === '$defs') {
      result[key] = Object.fromEntries(
        Object.entries(value as object).map(([name, child]) => [name, clean(child)]),
      );
    } else if (key === 'enum' || key === 'required') {
      result[key] = value;
    } else if (
      (key === 'minimum' || key === 'maximum') &&
      Math.abs(value as number) >= Number.MAX_SAFE_INTEGER
    ) {
      // Zod's integer type states the safe-integer range, which says nothing useful to the model.
      continue;
    } else {
      result[key] = clean(value);
    }
  }
  return result;
}

/** The schema in the form Gemini takes. Zod still does the real checking of each reply. */
export function toGeminiSchema(schema: z.ZodType): unknown {
  return clean(z.toJSONSchema(schema, { unrepresentable: 'any' }));
}

/** A readable text of the same schema, for a model that would not take it as a parameter. */
export function schemaAsText(schema: z.ZodType): string {
  return JSON.stringify(toGeminiSchema(schema));
}

/** Reads JSON from a reply, allowing for a Markdown fence or a sentence around it. */
export function parseJsonReply(reply: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = reply.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)?.[1];
  const candidates = [fenced ?? trimmed];
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      // Try the next reading.
    }
  }
  return { ok: false };
}

/** The first few problems with a reply, in words the model can act on. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join('.') || 'the reply'}: ${issue.message}`)
    .join('; ');
}
