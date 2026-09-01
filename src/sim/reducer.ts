import type {
  Deploy,
  Event,
  Flag,
  HealthStatus,
  Migration,
  Route,
  Service,
  TrafficState,
  World,
} from './types';

/**
 * Pure reducer: World is derived ONLY by folding events (schema v1).
 * Never mutates its input; unhandled kinds are explicit no-ops so the
 * world stays a pure function of the log as kinds get richer (M2-03+).
 */

export function initialWorld(): World {
  return {
    services: [],
    deploys: [],
    flags: [],
    envVars: [],
    routes: [],
    migrations: [],
    dns: [],
    incident: { statusPosts: [] },
    traffic: { rps: 0, errRate: 0, p95: 0, byRoute: {} },
    damage: { usersErrored: 0, ticketsOpened: 0, revenueLost: 0 },
  };
}

export function reduce(world: World, event: Event): World {
  switch (event.kind) {
    case 'service.health': {
      const d = event.data as {
        service: string;
        status: HealthStatus;
        reason?: string;
        name?: string;
        deps?: string[];
        version?: string;
      };
      const existing = world.services.find((s) => s.id === d.service);
      const next: Service = {
        id: d.service,
        name: d.name ?? existing?.name ?? d.service,
        deps: d.deps ?? existing?.deps ?? [],
        health: d.status,
        version: d.version ?? existing?.version ?? '1.0.0',
      };
      return {
        ...world,
        services: existing
          ? world.services.map((s) => (s.id === d.service ? next : s))
          : [...world.services, next],
      };
    }

    case 'deploy.finished': {
      const d = event.data as unknown as Omit<Deploy, 'status' | 'at'>;
      const deploy: Deploy = { ...d, at: event.t, status: 'live' };
      // flags named in flagsTouched materialize (default on) and get stamped
      let flags = world.flags;
      for (const flagId of deploy.flagsTouched) {
        const existing = flags.find((f) => f.id === flagId);
        flags = existing
          ? flags.map((f) => (f.id === flagId ? { ...f, touchedByDeploy: deploy.id } : f))
          : [...flags, { id: flagId, name: flagId, state: 'on' as const, touchedByDeploy: deploy.id }];
      }
      return {
        ...world,
        flags,
        deploys: [
          ...world.deploys.map((p) =>
            p.service === deploy.service && p.status === 'live'
              ? { ...p, status: 'superseded' as const }
              : p
          ),
          deploy,
        ],
        services: world.services.map((s) =>
          s.id === deploy.service ? { ...s, version: deploy.version } : s
        ),
      };
    }

    case 'traffic.tick': {
      const d = event.data as unknown as TrafficState;
      return { ...world, traffic: d };
    }

    case 'user.impact': {
      const d = event.data as {
        usersErrored: number;
        ticketsOpened: number;
        revenueLostFormula: { rps: number; errRate: number; valuePerReq: number };
      };
      const f = d.revenueLostFormula;
      return {
        ...world,
        damage: {
          usersErrored: world.damage.usersErrored + d.usersErrored,
          ticketsOpened: world.damage.ticketsOpened + d.ticketsOpened,
          revenueLost: world.damage.revenueLost + f.rps * f.errRate * f.valuePerReq,
        },
      };
    }

    case 'migration.applied': {
      const d = event.data as unknown as Migration;
      return { ...world, migrations: [...world.migrations, d] };
    }

    // action.executed is the ONLY world-mutation vocabulary for non-sim-world
    // state (flags/env/routes/rollbacks) — the same shape whether the actor is
    // 'sim' (scenario setup), 'human' (console UI), or 'agent' (WebMCP tools,
    // M3 — where the proposed/approved gate precedes it). Decision 2026-08-28.
    case 'action.executed': {
      const { tool, input } = event.data as { tool: string; input: Record<string, unknown> };
      switch (tool) {
        case 'flag.set': {
          const i = input as { id: string; state: Flag['state']; name?: string };
          const existing = world.flags.find((f) => f.id === i.id);
          const next: Flag = {
            id: i.id,
            name: i.name ?? existing?.name ?? i.id,
            state: i.state,
            ...(existing?.touchedByDeploy ? { touchedByDeploy: existing.touchedByDeploy } : {}),
          };
          return {
            ...world,
            flags: existing
              ? world.flags.map((f) => (f.id === i.id ? next : f))
              : [...world.flags, next],
          };
        }
        // ---- incident management -------------------------------------
        case 'incident.acknowledge': {
          const i = input as { by: string };
          return { ...world, incident: { ...world.incident, acknowledgedBy: i.by } };
        }
        case 'incident.severity': {
          const i = input as { level: 'sev1' | 'sev2' | 'sev3' };
          return { ...world, incident: { ...world.incident, severity: i.level } };
        }
        case 'incident.escalate': {
          const i = input as { team: string };
          return { ...world, incident: { ...world.incident, escalatedTo: i.team } };
        }
        case 'statuspage.post': {
          const i = input as { state: 'investigating' | 'identified' | 'monitoring' | 'resolved'; text: string };
          return {
            ...world,
            incident: {
              ...world.incident,
              statusPosts: [...world.incident.statusPosts, { state: i.state, text: i.text, at: event.t }],
            },
          };
        }
        case 'alerts.silence': {
          const i = input as { silenced: boolean };
          return { ...world, incident: { ...world.incident, alertsSilenced: i.silenced } };
        }
        case 'deploy.freeze': {
          const i = input as { frozen: boolean };
          return { ...world, incident: { ...world.incident, deploysFrozen: i.frozen } };
        }

        // ---- traffic -------------------------------------------------
        case 'traffic.shift': {
          const i = input as { route: string; percent: number; target?: string };
          return {
            ...world,
            routes: world.routes.map((r) =>
              r.id === i.route
                ? { ...r, splitPercent: i.percent, ...(i.target ? { target: i.target } : {}) }
                : r
            ),
          };
        }
        case 'traffic.drain': {
          const i = input as { route: string };
          return {
            ...world,
            routes: world.routes.map((r) => (r.id === i.route ? { ...r, drained: true } : r)),
          };
        }
        case 'ratelimit.set': {
          const i = input as { route: string; rps: number };
          return {
            ...world,
            routes: world.routes.map((r) => (r.id === i.route ? { ...r, rateLimitRps: i.rps } : r)),
          };
        }
        case 'canary.set': {
          const i = input as { deployId: string; percent: number };
          return {
            ...world,
            deploys: world.deploys.map((d) =>
              d.id === i.deployId ? { ...d, canaryPct: i.percent } : d
            ),
          };
        }

        // ---- compute -------------------------------------------------
        case 'service.scale': {
          const i = input as { service: string; replicas: number };
          return {
            ...world,
            services: world.services.map((s) =>
              s.id === i.service ? { ...s, replicas: i.replicas } : s
            ),
          };
        }
        case 'service.restart': {
          const i = input as { service: string };
          // the restart itself is instantaneous in the world; the COST (dropped
          // in-flight requests, cold caches) is applied by the template's
          // onAction, which owns consequences
          return {
            ...world,
            services: world.services.map((s) =>
              s.id === i.service ? { ...s, restartedAtTick: (s.restartedAtTick ?? 0) + 1 } : s
            ),
          };
        }

        // ---- data ----------------------------------------------------
        case 'db.failover': {
          const i = input as { service: string };
          return { ...world, dbPrimary: `${i.service}-replica` };
        }
        case 'cache.flush':
          // no persistent world state — the consequence is a refill storm,
          // which the template applies
          return world;

        // ---- dns -----------------------------------------------------
        case 'dns.cutover': {
          const i = input as { hostname: string; target: string };
          const existing = world.dns.find((d) => d.hostname === i.hostname);
          const rec = { hostname: i.hostname, target: i.target };
          return {
            ...world,
            dns: existing
              ? world.dns.map((d) => (d.hostname === i.hostname ? rec : d))
              : [...world.dns, rec],
          };
        }

        case 'env.set': {
          const i = input as { key: string; value: string };
          const redacted =
            i.value.length <= 4 ? '••••' : `${i.value.slice(0, 2)}••••${i.value.slice(-2)}`;
          const entry = { key: i.key, valueRedacted: redacted, changedAt: event.t };
          const exists = world.envVars.some((v) => v.key === i.key);
          return {
            ...world,
            envVars: exists
              ? world.envVars.map((v) => (v.key === i.key ? entry : v))
              : [...world.envVars, entry],
          };
        }
        case 'route.set': {
          const i = input as { id: string; target: string; path?: string; tier?: Route['tier'] };
          const existing = world.routes.find((r) => r.id === i.id);
          const next: Route = {
            id: i.id,
            path: i.path ?? existing?.path ?? `/${i.id}`,
            target: i.target,
            tier: i.tier ?? existing?.tier ?? 'route',
          };
          return {
            ...world,
            routes: existing
              ? world.routes.map((r) => (r.id === i.id ? next : r))
              : [...world.routes, next],
          };
        }
        case 'deploy.rollback': {
          const i = input as { deployId: string };
          const target = world.deploys.find((d) => d.id === i.deployId);
          if (!target || target.status !== 'live') return world;
          // most recent superseded deploy for the service becomes live again;
          // no predecessor → nothing to revert to → the rollback is rejected
          const previous = [...world.deploys]
            .reverse()
            .find((d) => d.service === target.service && d.status === 'superseded');
          if (!previous) return world;
          return {
            ...world,
            deploys: world.deploys.map((d) => {
              if (d.id === target.id) return { ...d, status: 'rolled_back' as const };
              if (previous && d.id === previous.id) return { ...d, status: 'live' as const };
              return d;
            }),
            services: world.services.map((s) =>
              s.id === target.service ? { ...s, version: previous?.version ?? s.version } : s
            ),
          };
        }
        default:
          return world; // unknown tools execute without world effect (template may react)
      }
    }

    // Kinds that carry information but don't change World: the log itself is
    // their home; read tools and UI query it directly.
    case 'deploy.started':
    case 'deploy.failed':
    case 'cache.state':
    case 'queue.state':
    case 'log.line':
    case 'action.proposed':
    case 'action.approved':
    case 'action.rejected':
    case 'action.blocked':
    case 'tool.called':
    case 'mode.changed':
    case 'selection.changed':
    // the agent's own read of the situation: recorded, never world-changing
    case 'finding.recorded':
    case 'scenario.seeded':
    case 'annotation.added':
      return world;
  }
}

export function replay(events: readonly Event[], from: World = initialWorld()): World {
  return events.reduce(reduce, from);
}
