import { describe, expect, it } from 'vitest';
import type { QueryRequest } from '../sim/queries';
import type { ModelContextLike, ToolDescriptor } from './shim';
import { createAirlockTools } from './tools';

// M3-02: mode-gated dynamic registration against a fake modelContext —
// registration lifetimes (AbortController), tombstones, proposal flow.

function fakeMc() {
  const registered = new Map<string, ToolDescriptor>();
  const mc: ModelContextLike = {
    registerTool: (tool, opts) => {
      registered.set(tool.name, tool);
      opts?.signal?.addEventListener('abort', () => registered.delete(tool.name));
    },
  };
  return { mc, registered };
}

function fixture() {
  const queries: QueryRequest[] = [];
  const proposals: Array<{ tool: string; input: Record<string, unknown> }> = [];
  const { mc, registered } = fakeMc();
  const tools = createAirlockTools(
    async (q) => {
      queries.push(q);
      return { asOfSeq: 1, echo: q.kind };
    },
    async (tool, input) => {
      proposals.push({ tool, input });
      return { seq: 99 };
    },
    mc
  );
  return { tools, registered, queries, proposals };
}

describe('mode-gated registration (M3-02)', () => {
  it('triage registers the 6 read tools and no writes', () => {
    const { tools, registered } = fixture();
    expect(registered.size).toBe(6);
    expect([...registered.keys()]).toContain('explain_surface');
    expect(tools.list().filter((t) => t.status === 'active')).toHaveLength(6);
    for (const t of registered.values()) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it('diagnosis adds the flag proposal; recovery adds the full write set', () => {
    const { tools, registered } = fixture();
    const d = tools.setMode('diagnosis');
    expect(d).toEqual({ from: 'triage', added: ['propose_flag_change'], removed: [] });
    expect(registered.has('propose_flag_change')).toBe(true);

    const r = tools.setMode('recovery');
    expect(r.added).toEqual(
      expect.arrayContaining(['propose_rollback', 'propose_rollforward', 'propose_env_change', 'propose_route_change'])
    );
    expect(r.removed).toEqual([]);
    expect(registered.size).toBe(6 + 5);
    expect(registered.get('propose_rollback')!.annotations?.readOnlyHint).toBe(false);
  });

  it('leaving a mode aborts registrations and leaves tombstones', () => {
    const { tools, registered } = fixture();
    tools.setMode('recovery');
    tools.setMode('triage');
    expect(registered.size).toBe(6); // abort really unregistered (fake honors signal)
    const tombs = tools.list().filter((t) => t.status === 'tombstoned');
    expect(tombs).toHaveLength(5);
    expect(tombs[0]!.tombstone).toContain('left with recovery mode');
  });

  it('invoking a write tool outside its mode fails as not-registered', async () => {
    const { tools } = fixture();
    await expect(tools.invoke('propose_rollback', {})).rejects.toThrow(/not-registered-in-mode/);
    await expect(tools.invoke('no_such_tool', {})).rejects.toThrow(/unknown tool/);
  });

  it('write tools propose through the vocabulary and report pending status', async () => {
    const { tools, proposals } = fixture();
    tools.setMode('recovery');
    const text = await tools.invoke('propose_rollback', { deployId: 'd-201' });
    expect(proposals).toEqual([{ tool: 'deploy.rollback', input: { deployId: 'd-201' } }]);
    const res = JSON.parse(text);
    expect(res.status).toBe('proposed');
    expect(res.proposalSeq).toBe(99);
    expect(res.note).toContain('Nothing has changed');
  });

  it('write tools tolerate Chrome-151 string input', async () => {
    const { tools, proposals } = fixture();
    tools.setMode('recovery');
    await tools.invoke('propose_flag_change', '{"id":"new-checkout","state":"off"}');
    expect(proposals[0]).toEqual({ tool: 'flag.set', input: { id: 'new-checkout', state: 'off' } });
  });

  it('explain_surface queries the surface kind', async () => {
    const { tools, queries } = fixture();
    await tools.invoke('explain_surface', {});
    expect(queries).toEqual([{ kind: 'surface' }]);
  });

  it('name and description budgets hold (Chrome guidance)', () => {
    const { tools, registered } = fixture();
    tools.setMode('recovery');
    for (const t of registered.values()) {
      expect(t.name.length, t.name).toBeLessThanOrEqual(30);
      expect(t.description.length, t.name).toBeLessThanOrEqual(500);
    }
  });
});
