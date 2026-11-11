import { createHash } from 'crypto';

import { toJSONSchema, type z } from 'zod';

/*
 * Prompts are versioned code (design §9): any change to the system text, the tool schema or the
 * model makes a new promptVersion, so results can be traced and an upgrade evaluated first.
 */

/** A versioned prompt: model, system text, forced output tool and the schema it is checked with. */
export type PromptPack<T> = {
  modelId: string;
  promptVersion: string;
  system: string;
  toolName: string;
  toolDescription: string;
  toolSchema: Record<string, unknown>;
  output: z.ZodType<T>;
  /** Output allocation the operation was sized for: below `min` a complete answer is not expected. */
  outputTokens: { min: number; max: number };
  timeoutMs: number;
  repairMessage(issues: { path: string; message: string }[]): string;
};

/** JSON Schema of a tool input, generated from the same definition the output is checked with. */
export function toolSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = toJSONSchema(schema, { target: 'draft-7' }) as Record<
    string,
    unknown
  >;
  return rest;
}

/** Note sent with a single repair attempt: paths and generic messages only, never content. */
export function repairNote(toolName: string) {
  return (issues: { path: string; message: string }[]): string => {
    const lines = issues
      .slice(0, 20)
      .map((issue) => `- ${issue.path || '(root)'}: ${issue.message}`);
    return `The tool input did not match the schema:\n${lines.join('\n')}\nCall ${toolName} again with the complete, corrected input.`;
  };
}

/** Delimits untrusted text with a marker derived from it, so the text cannot already contain it. */
export function fenced(label: string, text: string): { marker: string; block: string } {
  const marker = `${label}-${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
  return { marker, block: `${marker}\n${text}\n${marker}` };
}

/** Bytes a request sends besides the user text: system, tool schema and name. */
export const fixedBytes = (pack: PromptPack<unknown>) =>
  Buffer.byteLength(pack.system) +
  Buffer.byteLength(JSON.stringify(pack.toolSchema)) +
  Buffer.byteLength(pack.toolDescription) +
  Buffer.byteLength(pack.toolName);
