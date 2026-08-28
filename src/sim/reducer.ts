import type { Deploy, Event, HealthStatus, Migration, Service, TrafficState, World } from './types';

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
      return {
        ...world,
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

    // Kinds that carry information but don't change World (yet): the log
    // itself is their home; read tools and UI query it directly. M2-03/M3
    // extend the world cases (flags/env/routes via action.executed).
    case 'deploy.started':
    case 'deploy.failed':
    case 'cache.state':
    case 'queue.state':
    case 'log.line':
    case 'action.proposed':
    case 'action.approved':
    case 'action.rejected':
    case 'action.executed':
    case 'action.blocked':
    case 'tool.called':
    case 'mode.changed':
    case 'selection.changed':
    case 'scenario.seeded':
    case 'annotation.added':
      return world;
  }
}

export function replay(events: readonly Event[], from: World = initialWorld()): World {
  return events.reduce(reduce, from);
}
