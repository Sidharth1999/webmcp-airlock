import { MODE_ACTIONS, MODE_WRITE_TOOLS } from '../sim/modes';
import { describe, expect, it } from 'vitest';
import type { QueryRequest } from '../sim/queries';
import type { ModelContextLike, ToolDescriptor } from './shim';
import { createAirlockTools, READ_TOOLS, WRITE_TOOLS } from './tools';
import { Engine } from '../sim/engine';
import { runQuery } from '../sim/queries';

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
      return { seq: 99, outcome: 'proposed' as const };
    },
    () => {},
    mc
  );
  return { tools, registered, queries, proposals };
}

describe('mode-gated registration (M3-02)', () => {
  it('triage grants communication, and NOTHING that changes production', () => {
    const { tools, registered } = fixture();
    // Triage is not a read-only waiting room: a page can safely let an agent
    // help run an incident (acknowledge, severity, page a team, status page)
    // long before it lets one touch production. What triage must never grant
    // is a lever that changes what customers are served.
    const PRODUCTION = [
      'propose_flag_change', 'propose_rollback', 'propose_rollforward',
      'propose_env_change', 'propose_route_change', 'propose_traffic_change',
      'propose_drain', 'propose_rate_limit', 'propose_restart', 'propose_scale',
      'propose_cache_flush', 'propose_failover', 'propose_canary',
    ];
    for (const name of PRODUCTION) {
      expect(registered.has(name), `${name} must not exist in triage`).toBe(false);
    }
    expect(registered.size).toBe(12); // 6 reads + record_finding + 5 incident-command
    expect([...registered.keys()]).toContain('explain_surface');
    expect(tools.list().filter((t) => t.status === 'active')).toHaveLength(12);
    // STRONGER than the old blanket check: the six READS are read-only, and
    // the only other tool in triage is record_finding — which writes to the
    // console's timeline (so it is honestly not readOnly) but carries no
    // world-changing verb. No way to mutate the world exists in this mode.
    for (const spec of READ_TOOLS) {
      expect(registered.get(spec.name)!.annotations?.readOnlyHint, spec.name).toBe(true);
    }
    const nonRead = [...registered.keys()].filter((n) => !READ_TOOLS.some((r) => r.name === n));
    expect(nonRead).toContain('record_finding');
    // every other non-read in triage is incident command, never production
    expect(nonRead.filter((n) => n.startsWith('propose_')).sort()).toEqual([
      'propose_acknowledge', 'propose_escalate', 'propose_severity',
      'propose_silence_alerts', 'propose_status_update',
    ]);
  });

  it('diagnosis adds the flag proposal; recovery adds the full write set', () => {
    const { tools, registered } = fixture();
    const d = tools.setMode('diagnosis');
    // diagnosis adds the REVERSIBLE production levers on top of triage's
    // incident-command grants; nothing is taken away
    expect(d.from).toBe('triage');
    expect(d.removed).toEqual([]);
    expect(d.added.sort()).toEqual([
      'propose_canary', 'propose_deploy_freeze', 'propose_flag_change', 'propose_rate_limit',
    ]);
    expect(registered.has('propose_flag_change')).toBe(true);

    const r = tools.setMode('recovery');
    expect(r.added).toEqual(
      expect.arrayContaining(['propose_rollback', 'propose_rollforward', 'propose_env_change', 'propose_route_change'])
    );
    expect(r.removed).toEqual([]);
    expect(registered.size).toBe(19 + 7); // all proposals + 6 reads + record_finding
    expect(registered.get('propose_rollback')!.annotations?.readOnlyHint).toBe(false);
  });

  it('leaving a mode aborts registrations and leaves tombstones', () => {
    const { tools, registered } = fixture();
    tools.setMode('recovery');
    tools.setMode('triage');
    expect(registered.size).toBe(12); // abort really unregistered (fake honors signal)
    const tombs = tools.list().filter((t) => t.status === 'tombstoned');
    expect(tombs).toHaveLength(14); // everything recovery granted beyond triage
    expect(tombs[0]!.tombstone).toContain('left with recovery mode');
  });

  it('invoking a write tool outside its mode forwards the ATTEMPT to the engine (M3-04)', async () => {
    // real WebMCP would not list the tool, but drivers/the ungated arm can
    // still attempt it — the attempt must reach the engine to be logged as
    // action.blocked (the stub here answers; policy is engine-tested)
    const { tools, proposals } = fixture();
    await tools.invoke('propose_rollback', { deployId: 'd-201' });
    expect(proposals).toEqual([{ tool: 'deploy.rollback', input: { deployId: 'd-201' } }]);
    await expect(tools.invoke('no_such_tool', {})).rejects.toThrow(/unknown tool/);
  });

  it('a blocked proposal outcome surfaces as status blocked with the reason', async () => {
    const { mc } = fakeMc();
    const tools = createAirlockTools(
      async () => ({ asOfSeq: 1 }),
      async () => ({ seq: 7, outcome: 'blocked' as const, reason: 'not-available-in-mode' }),
      () => {},
      mc
    );
    const res = JSON.parse(await tools.invoke('propose_rollback', { deployId: 'd-201' }));
    expect(res.status).toBe('blocked');
    expect(res.reason).toBe('not-available-in-mode');
    expect(res.blockedSeq).toBe(7);
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

describe('reset (M3-close review): a fresh world gets a fresh rail', () => {
  it('reset() returns to triage and clears tombstones from the previous scenario', () => {
    const { tools, registered } = fixture();
    tools.setMode('recovery');
    tools.reset();
    expect(tools.mode()).toBe('triage');
    expect(tools.list().filter((t) => t.status === 'tombstoned')).toHaveLength(0);
    // back to triage's own grants: 6 reads + record_finding + 5 incident-command
    expect(registered.size).toBe(12); // recovery's registrations really aborted
  });
});

// M4 readOnlyHint audit: the annotations a host reads before it decides
// whether to ask. These are load-bearing claims about our tools, so they are
// asserted, not trusted — including the one honest exception (the audit
// trail) and the de-structuring invariant reaching the agent-visible copy.
describe('readOnlyHint audit — the six reads (M4)', () => {
  it('every read is annotated read-only; only read_logs is annotated untrusted', () => {
    const { tools, registered } = fixture();
    tools.setMode('recovery'); // writes on stage too, so the contrast is real
    for (const spec of READ_TOOLS) {
      const t = registered.get(spec.name)!;
      expect(t.annotations?.readOnlyHint, spec.name).toBe(true);
    }
    const untrusted = [...registered.values()]
      .filter((t) => t.annotations?.untrustedContentHint)
      .map((t) => t.name);
    expect(untrusted).toEqual(['read_logs']);
  });

  it('every proposal tool is annotated NOT read-only', () => {
    const { tools, registered } = fixture();
    tools.setMode('recovery');
    for (const spec of WRITE_TOOLS) {
      const t = registered.get(spec.name)!;
      expect(t.annotations?.readOnlyHint, spec.name).toBe(false);
    }
  });

  it('reads stay registered through every mode transition (the airlock gates writes, never observability)', () => {
    const { tools, registered } = fixture();
    for (const to of ['diagnosis', 'recovery', 'triage'] as const) {
      tools.setMode(to);
      for (const spec of READ_TOOLS) {
        expect(registered.has(spec.name), `${spec.name} after → ${to}`).toBe(true);
      }
    }
  });

  it('no description or input schema advertises a reversibility enum (de-structuring reaches the UI copy)', () => {
    const { tools, registered } = fixture();
    tools.setMode('recovery');
    for (const t of registered.values()) {
      const copy = `${t.description} ${JSON.stringify(t.inputSchema)}`;
      expect(copy, `${t.name} copy`).not.toMatch(/reversib|irreversib/i);
    }
  });

  it('parameter descriptions hold the Chrome budget (≤150)', () => {
    const { tools, registered } = fixture();
    tools.setMode('recovery');
    for (const t of registered.values()) {
      const props = (t.inputSchema as { properties?: Record<string, { description?: string }> })
        .properties ?? {};
      for (const [k, v] of Object.entries(props)) {
        expect(v.description?.length ?? 0, `${t.name}.${k}`).toBeLessThanOrEqual(150);
      }
    }
  });

  it('invoking any read leaves the world byte-identical; the audit trail is the only trace', async () => {
    const engine = new Engine({ templateId: 'migration-trap', seed: 42 });
    engine.step(30); // a world with deploys, traffic, logs — not a fresh one
    const { mc } = fakeMc();
    const tools = createAirlockTools(
      async (q, viaTool) => {
        // mirrors src/sim/worker.ts: answer from the log, then audit the call
        const result = runQuery(engine.events, engine.world, q);
        if (viaTool) {
          engine.record('tool.called', 'agent', {
            tool: viaTool,
            input: {},
            resultBytes: JSON.stringify(result).length,
          });
        }
        return result;
      },
      async () => ({ seq: 0, outcome: 'proposed' as const }),
      () => {},
      mc
    );

    for (const spec of READ_TOOLS) {
      const worldBefore = JSON.stringify(engine.world);
      const seqBefore = engine.events.length;
      await tools.invoke(spec.name, {});
      expect(JSON.stringify(engine.world), `${spec.name} mutated the world`).toBe(worldBefore);
      const added = engine.events.slice(seqBefore);
      expect(added.map((e) => e.kind), `${spec.name} side effects`).toEqual(['tool.called']);
    }
  });
});

describe('capability authority: some levers are human-only', () => {
  it('no agent tool can propose a DNS cutover', () => {
    // The page grants the agent nineteen proposals and withholds this one.
    // DNS propagation takes minutes and resolvers cache, so it is the wrong
    // instrument for an incident you are trying to end now — and "the page
    // decided the agent may never attempt this" is the capability-authority
    // claim in its sharpest form. The HUMAN keeps the control in the console.
    expect(WRITE_TOOLS.some((t) => t.action === 'dns.cutover')).toBe(false);
    expect(MODE_ACTIONS.recovery.has('dns.cutover')).toBe(true);
  });

  it('every granted tool maps to a real action the engine will execute', () => {
    for (const t of WRITE_TOOLS) {
      expect(MODE_ACTIONS.recovery.has(t.action), `${t.name} -> ${t.action}`).toBe(true);
    }
  });

  it('the registration surface and the engine gate agree', () => {
    // Defense in depth only works if both halves say the same thing.
    for (const mode of ['triage', 'diagnosis', 'recovery'] as const) {
      const granted = MODE_WRITE_TOOLS[mode]
        .map((n) => WRITE_TOOLS.find((t) => t.name === n)?.action)
        .filter(Boolean) as string[];
      for (const action of granted) {
        expect(MODE_ACTIONS[mode].has(action), `${mode}: ${action}`).toBe(true);
      }
    }
  });
});
