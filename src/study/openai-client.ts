import type { CampaignModel, LLMClient, TurnRecord } from './campaign-types';

/**
 * The real LLMClient, over the OpenAI Responses API.
 *
 * Cost discipline (docs/cost-projection.md): low reasoning effort, a capped
 * output budget, and a STABLE PREFIX — instructions and tool definitions
 * never change within a run and prior items are echoed back verbatim, which
 * is what earns the ≥70% cached-input ratio the projection is built on.
 * Usage is read off the response, never estimated: the canary gate depends
 * on it being real.
 *
 * Untested against the live API until the key gate opens (STATUS: "Blocked
 * / waiting on Sid"). Everything the campaign depends on structurally is
 * proven through MockClient instead.
 */

const ENDPOINT = 'https://api.openai.com/v1/responses';
const KICKOFF = 'You are connected to the release console. Begin.';
const MAX_OUTPUT_TOKENS = 4096;
const RETRIES = 3;

export interface ToolDefLike {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Anything we send back to the API as a prior conversation item. */
export type InputItem = Record<string, unknown>;

interface ResponsesUsage {
  input_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens?: number;
}

interface ResponsesBody {
  output?: Array<Record<string, unknown>>;
  usage?: ResponsesUsage;
  error?: { message?: string };
}

/** Pure: the request body for one turn. Exported so it is testable keyless. */
export function buildRequest(
  model: CampaignModel,
  system: string,
  tools: ToolDefLike[],
  input: InputItem[]
): Record<string, unknown> {
  return {
    model,
    instructions: system,
    input,
    tools: tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
    tool_choice: 'auto',
    reasoning: { effort: 'low' },
    max_output_tokens: MAX_OUTPUT_TOKENS,
    store: false,
  };
}

/** Pure: pull the model's tool calls, text, and usage out of a response. */
export function parseResponse(body: ResponsesBody): {
  items: InputItem[];
  toolCalls: Array<{ callId: string; tool: string; input: Record<string, unknown> }>;
  assistantText?: string;
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
} {
  const items = (body.output ?? []) as InputItem[];
  const toolCalls: Array<{ callId: string; tool: string; input: Record<string, unknown> }> = [];
  const texts: string[] = [];

  for (const item of items) {
    if (item.type === 'function_call') {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(String(item.arguments ?? '{}')) as Record<string, unknown>;
      } catch {
        parsed = {}; // malformed args are the agent's problem: the gate reports invalid-input
      }
      toolCalls.push({
        callId: String(item.call_id ?? ''),
        tool: String(item.name ?? ''),
        input: parsed,
      });
    } else if (item.type === 'message') {
      for (const part of (item.content ?? []) as Array<{ type?: string; text?: string }>) {
        if (part.text) texts.push(part.text);
      }
    }
  }

  const usage = body.usage ?? {};
  return {
    items,
    toolCalls,
    ...(texts.length > 0 ? { assistantText: texts.join('\n') } : {}),
    usage: {
      inputTokens: usage.input_tokens ?? 0,
      cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
    },
  };
}

export class OpenAIClient implements LLMClient {
  private items: InputItem[] = [];
  private lastCallIds: string[] = [];

  constructor(
    private readonly model: CampaignModel,
    private readonly apiKey = process.env.OPENAI_API_KEY ?? '',
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async turn(req: {
    system: string;
    transcript: TurnRecord[];
    tools: ToolDefLike[];
  }): ReturnType<LLMClient['turn']> {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is not set');

    if (req.transcript.length === 0) {
      // a fresh run on a reused client instance
      this.items = [{ role: 'user', content: KICKOFF }];
      this.lastCallIds = [];
    } else {
      // feed back the results of the calls we returned last turn, threaded by
      // the API's own call_ids (never ids we invented)
      const last = req.transcript[req.transcript.length - 1]!;
      last.toolCalls.forEach((call, i) => {
        const callId = this.lastCallIds[i];
        if (!callId) return;
        this.items.push({ type: 'function_call_output', call_id: callId, output: call.result });
      });
    }

    const body = await this.post(buildRequest(this.model, req.system, req.tools, this.items));
    const parsed = parseResponse(body);
    this.items.push(...parsed.items);
    this.lastCallIds = parsed.toolCalls.map((c) => c.callId);

    return {
      toolCalls: parsed.toolCalls.map((c) => ({ tool: c.tool, input: c.input })),
      ...(parsed.assistantText ? { assistantText: parsed.assistantText } : {}),
      usage: parsed.usage,
    };
  }

  private async post(payload: Record<string, unknown>): Promise<ResponsesBody> {
    let lastError = '';
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const res = await this.fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
      });
      if (res.ok) return (await res.json()) as ResponsesBody;

      lastError = `${res.status} ${await res.text()}`.slice(0, 300);
      // 4xx other than rate-limiting will not fix itself — fail fast, keep the spend
      if (res.status !== 429 && res.status < 500) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
    throw new Error(`OpenAI Responses API failed: ${lastError}`);
  }
}
