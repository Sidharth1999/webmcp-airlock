import type { ActionOutcome, Event, World } from './types';
import type { WriteAction } from './vocabulary';

/**
 * The generic outcome of an executed action, derived after the fact from
 * three things the engine already has: the world before, the world after,
 * and whatever the template emitted in reaction. Templates that know more
 * (retry-storm's fleet) answer first via `TemplateInstance.outcome`; this is
 * the floor beneath them, so that NO action lands as a bare "executed".
 *
 * Paid-run finding (2026-09-02, ChatGPT in-app browser): an approved
 * roll-forward into a fleet with no headroom reported "executed" and the
 * ledger said "nothing in the world moved". The agent then scaled past the
 * autoscaler ceiling, rolled forward again, rolled back, and restarted —
 * every one a no-op or worse, none of them explained. The scenario was
 * right; its legibility was wrong.
 */

const WORLD_KEYS: (keyof World)[] = [
  'incident', 'services', 'deploys', 'flags', 'envVars', 'routes', 'migrations', 'dbPrimary', 'dns',
];

/** Top-level world keys whose VALUE moved (not merely their reference). */
export function worldDiff(before: World, after: World): string[] {
  const out: string[] = [];
  for (const k of WORLD_KEYS) {
    if (before[k] === after[k]) continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out.push(k);
  }
  return out;
}

export function deriveOutcome(
  before: World,
  after: World,
  reacted: readonly Event[],
  spec: WriteAction | undefined,
  tool: string,
  input: Record<string, unknown>
): ActionOutcome {
  const changed = worldDiff(before, after);
  const said = spec?.describe(input, before) ?? tool;
  if (changed.length) return { effect: 'changed', reason: said, changed };
  if (reacted.length) {
    // the world's own state did not move but the incident reacted: the first
    // thing the sim said about it is the outcome
    const voice = reacted.find(
      (e) => e.kind === 'log.line' || e.kind === 'service.health' || e.kind === 'deploy.failed'
    );
    const d = (voice?.data ?? {}) as { msg?: string; reason?: string };
    const msg = d.msg ?? d.reason ?? '';
    return {
      effect: 'changed',
      reason: msg || `${said}: the incident reacted`,
      changed: [...new Set(reacted.map((e) => e.kind))],
    };
  }
  return { effect: 'none', reason: noopReason(before, tool, input, said) };
}

/** Why an action the reducer accepted still changed nothing. */
function noopReason(world: World, tool: string, input: Record<string, unknown>, said: string): string {
  switch (tool) {
    case 'deploy.rollback': {
      const id = String(input.deployId ?? '?');
      const target = world.deploys.find((d) => d.id === id);
      if (!target) return `rollback has no effect: there is no deploy ${id}`;
      if (target.status !== 'live') {
        return `rollback has no effect: ${id} is ${target.status.replace('_', ' ')}, not the live build of ${target.service}`;
      }
      return `rollback has no effect: ${id} has no superseded predecessor to restore`;
    }
    case 'flag.set': {
      const f = world.flags.find((x) => x.id === String(input.id));
      if (f) return `flag ${f.id} is already ${String(f.state)}: nothing changed`;
      break;
    }
    case 'ratelimit.set':
    case 'traffic.drain':
    case 'traffic.shift': {
      const r = world.routes.find((x) => x.id === String(input.route));
      if (!r) return `${said}: no route ${String(input.route)} on this console`;
      if (tool === 'ratelimit.set') return `${r.path} is already capped at ${String(input.rps)} req/s: nothing changed`;
      if (tool === 'traffic.drain') return `${r.path} is already drained: nothing changed`;
      break;
    }
    case 'service.scale':
    case 'service.restart': {
      if (!world.services.some((s) => s.id === String(input.service))) {
        return `${said}: no service ${String(input.service)} on this console`;
      }
      break;
    }
    case 'canary.set': {
      if (!world.deploys.some((d) => d.id === String(input.deployId))) {
        return `${said}: no deploy ${String(input.deployId)} on this console`;
      }
      break;
    }
  }
  return `${said}: nothing in this incident responds to it, and no state changed`;
}

/** The service an outcome's log line files under. */
export function serviceOf(world: World, input: Record<string, unknown>): string {
  if (typeof input.service === 'string') return input.service;
  if (typeof input.route === 'string') {
    const r = world.routes.find((x) => x.id === input.route);
    if (r) return r.target;
  }
  if (typeof input.deployId === 'string') {
    const d = world.deploys.find((x) => x.id === input.deployId);
    if (d) return d.service;
  }
  return 'console';
}
