/**
 * WebMCP compat layer. Two realities we must bridge (observed, M0):
 * - modelContext lives on `document` in Chrome 151; older builds/spec
 *   drafts put it on `navigator`.
 * - Chrome 151 executeTool uses the pre-Aug-19-spec signature: input
 *   must be a JSON *string* (2 args required). Later builds take an
 *   object. We probe nothing; we just stringify, which 151 requires
 *   and JSON-parsing servers tolerate.
 */

export type ToolDescriptor = {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  execute: (input: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;
};

type ModelContextLike = {
  registerTool: (tool: ToolDescriptor, opts?: { signal?: AbortSignal }) => unknown;
  getTools?: () => unknown;
  executeTool?: (name: string, input: string) => Promise<unknown>;
  addEventListener?: (type: string, cb: (e: Event) => void) => void;
};

export function getModelContext(): ModelContextLike | null {
  const d = document as Document & { modelContext?: ModelContextLike };
  const n = navigator as Navigator & { modelContext?: ModelContextLike };
  return d.modelContext ?? n.modelContext ?? null;
}

export function hasWebMCP(): boolean {
  return getModelContext() !== null;
}

/** Page-side tool invocation (drives the scripted-agent plumbing loop). */
export async function executeToolCompat(name: string, input: unknown): Promise<unknown> {
  const mc = getModelContext();
  if (!mc?.executeTool) throw new Error('WebMCP executeTool unavailable');
  return mc.executeTool(name, JSON.stringify(input ?? {}));
}
