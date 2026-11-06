/**
 * Commands.
 *
 * The original registers client commands with Brigadier:
 *   /water stats|pause|reload|ball|sand|remove|set|settings|render
 * Bedrock's script commands are namespaced, so the port exposes /rw:* through
 * the custom command registry (stable in @minecraft/server 2.1.0+). When the
 * registry is missing the same operations stay reachable through
 *   /scriptevent rw:stats
 * which is the documented fallback on builds without custom commands.
 */
import * as mc from '@minecraft/server';
import {
  settings, setSetting, settingNames, applyPreset, serializeSettings, DEFAULTS_FROZEN
} from '../core/settings.js';
import { log } from './bedrock.js';

export const COMMAND_HELP = [
  '/rw:stats - simulation statistics',
  '/rw:pause - pause or resume the simulation',
  '/rw:reload - re-read realistic water/sand around you',
  '/rw:remove water|sand|all - delete simulated blocks near you',
  '/rw:set <name> <value> - change a simulation setting',
  '/rw:settings - list settings',
  '/rw:quality low|medium|high|ultra - apply a quality preset',
  '/rw:physics [on|off|convert|clear] - block physics converter',
  '/rw:diag - which subsystems loaded (use this if nothing happens)',
  'Fallback: /scriptevent rw:<command> [args]'
];

/**
 * @param {{world:any, getSolver:Function, reload:Function, removeAll:Function, ball:Function}} api
 */
export function registerCommands(api) {
  const make = (name, description, params, fn) => {
    let types;
    try { types = mc.CustomCommandParamType; } catch { types = undefined; }
    if (!types) return null;
    const toParam = (p) => {
      // Enums are passed as strings and validated in the handler: registering a
      // string enum needs a separately registered enum name, which is extra API
      // surface we do not need here.
      const typeMap = { int: types.Integer, float: types.Float, string: types.String, bool: types.Boolean };
      const t = typeMap[p.type];
      if (t === undefined) return null;
      return { name: p.name, type: t };
    };
    const mandatory = (params ?? []).filter(p => !p.optional).map(toParam);
    const optional = (params ?? []).filter(p => p.optional).map(toParam);
    if (mandatory.some(p => p === null) || optional.some(p => p === null)) return null;
    let perm = 'GameDirectors';
    try { perm = mc.CustomCommandPermissionLevel?.GameDirectors ?? perm; } catch { /* keep string */ }
    return {
      name,
      description,
      permissionLevel: perm,
      ...(mandatory.length ? { mandatoryParameters: mandatory } : {}),
      ...(optional.length ? { optionalParameters: optional } : {}),
      run: fn
    };
  };

  const specs = [
    make('rw:stats', 'Show realistic water simulation statistics', [],
      (origin) => { reply(origin, api.getSolver(origin)?.statsLine() ?? 'no simulation yet'); }),
    make('rw:pause', 'Pause or resume the realistic water simulation', [],
      (origin) => {
        settings.paused = !settings.paused;
        api.world.setDynamicProperty('rw:settings', serializeSettings());
        reply(origin, settings.paused ? 'Simulation paused' : 'Simulation running');
      }),
    make('rw:reload', 'Re-read realistic water and sand blocks around you', [],
      (origin) => { api.reload(origin); reply(origin, 'Re-reading realistic water/sand around you'); }),
    make('rw:remove', 'Remove simulated water or sand around you', [{ name: 'what', type: 'string', optional: true }],
      (origin, args) => { reply(origin, api.removeAll(origin, args?.[0] ?? 'all')); }),
    make('rw:set', 'Change a simulation setting', [{ name: 'name', type: 'string' }, { name: 'value', type: 'string' }],
      (origin, args) => {
        const res = setSetting(String(args?.[0]), String(args?.[1]));
        if (!res.ok) { reply(origin, res.error); return; }
        api.world.setDynamicProperty('rw:settings', serializeSettings());
        reply(origin, `${args?.[0]} = ${res.value}`);
      }),
    make('rw:settings', 'List simulation settings', [],
      (origin) => { reply(origin, settingNames().map(n => `${n}=${settings[n]}`).join('  ')); }),
    make('rw:quality', 'Apply a quality preset', [{ name: 'preset', type: 'string' }],
      (origin, args) => {
        const name = String(args?.[0] ?? 'high');
        if (!applyPreset(name)) { reply(origin, `unknown preset ${name}`); return; }
        api.world.setDynamicProperty('rw:settings', serializeSettings());
        reply(origin, `quality = ${name}`);
      }),
    make('rw:physics', 'Convert blocks into weight-driven physics bodies',
      [{ name: 'mode', type: 'string', optional: true }],
      (origin, args) => {
        const sim = api.physics;
        if (!sim) { reply(origin, 'physics subsystem did not load - run /rw:diag'); return; }
        const mode = String(args?.[0] ?? 'status').toLowerCase();
        if (mode === 'on' || mode === 'off') {
          reply(origin, `physics auto-convert ${sim.setAuto(mode === 'on') ? 'on: every block you place becomes a body' : 'off'}`);
          api.world.setDynamicProperty('rw:settings', serializeSettings());
          return;
        }
        if (mode === 'convert') {
          const player = origin?.sourceEntity;
          reply(origin, player ? sim.convertAhead(player) : 'Run this as a player');
          return;
        }
        if (mode === 'clear') { reply(origin, `put ${sim.clear()} physics bodies back as blocks`); return; }
        reply(origin, sim.statsLine());
      }),
    make('rw:diag', 'Report which subsystems loaded', [],
      (origin) => { reply(origin, api.diag ? api.diag() : 'diagnostics unavailable'); }),
    make('rw:help', 'List realistic water commands', [],
      (origin) => { reply(origin, COMMAND_HELP.join('\n')); })
  ].filter(Boolean);

  /** @returns {number} number of registered commands */
  const install = (registry) => {
    let n = 0;
    for (const spec of specs) {
      try {
        registry.registerCommand(
          {
            name: spec.name,
            description: spec.description,
            permissionLevel: spec.permissionLevel,
            ...(spec.mandatoryParameters ? { mandatoryParameters: spec.mandatoryParameters } : {}),
            ...(spec.optionalParameters ? { optionalParameters: spec.optionalParameters } : {})
          },
          (origin, args) => { spec.run(origin, args); }
        );
        n++;
      } catch (e) {
        log('command registration failed', spec.name, e?.message ?? e);
      }
    }
    return n;
  };

  // structured-clone friendly handoff to the startup event
  return { install };
}

function reply(origin, message) {
  try {
    if (origin?.sourceEntity) origin.sourceEntity.sendMessage(message);
    else if (origin?.sourceBlock) console.warn('[realistic-water]', message);
    else console.warn('[realistic-water]', message);
  } catch {
    log('command reply failed');
  }
}

/** Handle /scriptevent rw:<op> [args] */
export function handleScriptEvent(event, api) {
  const id = String(event.id ?? '');
  if (!id.startsWith('rw:')) return false;
  const op = id.slice(3);
  const msg = String(event.message ?? '').trim();
  const args = msg.length ? msg.split(/\s+/) : [];
  const origin = { sourceEntity: event.sourceEntity };
  const sol = api.getSolver(origin);
  switch (op) {
    case 'stats':
      reply(origin, sol?.statsLine() ?? 'no simulation yet');
      return true;
    case 'pause':
      settings.paused = !settings.paused;
      api.world.setDynamicProperty('rw:settings', serializeSettings());
      reply(origin, settings.paused ? 'Simulation paused' : 'Simulation running');
      return true;
    case 'reload':
      api.reload(origin);
      reply(origin, 'Re-reading realistic water/sand around you');
      return true;
    case 'remove':
      reply(origin, api.removeAll(origin, args[0] ?? 'all'));
      return true;
    case 'set': {
      const res = setSetting(args[0], args.slice(1).join(' '));
      if (!res.ok) { reply(origin, res.error); return true; }
      api.world.setDynamicProperty('rw:settings', serializeSettings());
      reply(origin, `${args[0]} = ${res.value}`);
      return true;
    }
    case 'settings':
      reply(origin, settingNames().map(n => `${n}=${settings[n]}`).join('  '));
      return true;
    case 'quality': {
      const name = args[0] ?? 'high';
      if (!applyPreset(name)) { reply(origin, `unknown preset ${name}`); return true; }
      api.world.setDynamicProperty('rw:settings', serializeSettings());
      reply(origin, `quality = ${name}`);
      return true;
    }
    case 'physics': {
      const sim = api.physics;
      if (!sim) { reply(origin, 'physics subsystem did not load - run /rw:diag'); return true; }
      const mode = String(args[0] ?? 'status').toLowerCase();
      if (mode === 'on' || mode === 'off') {
        reply(origin, `physics auto-convert ${sim.setAuto(mode === 'on') ? 'on' : 'off'}`);
      } else if (mode === 'convert') {
        reply(origin, origin.sourceEntity ? sim.convertAhead(origin.sourceEntity) : 'Run this as a player');
      } else if (mode === 'clear') {
        reply(origin, `put ${sim.clear()} physics bodies back as blocks`);
      } else {
        reply(origin, sim.statsLine());
      }
      return true;
    }
    case 'diag':
      reply(origin, api.diag ? api.diag() : 'diagnostics unavailable');
      return true;
    case 'reset':
      applyPreset('high');
      Object.assign(settings, DEFAULTS_FROZEN);
      api.world.setDynamicProperty('rw:settings', serializeSettings());
      reply(origin, 'settings reset');
      return true;
    case 'help':
      reply(origin, COMMAND_HELP.join('\n'));
      return true;
    default:
      reply(origin, `unknown realistic water command '${op}' (try /rw:help)`);
      return true;
  }
}

export function subscribeScriptEvents(api) {
  const handler = (e) => { handleScriptEvent(e, api); };
  try {
    mc.system.afterEvents.scriptEventReceive.subscribe(handler, { namespaces: ['rw'] });
    return true;
  } catch {
    try {
      mc.system.afterEvents.scriptEventReceive.subscribe(handler);
      return true;
    } catch (e) {
      log('scriptevent subscribe failed', e?.message ?? e);
      return false;
    }
  }
}

export function subscribeStartup(api) {
  try {
    mc.system.beforeEvents.startup.subscribe((init) => {
      const reg = init.customCommandRegistry;
      if (!reg) { log('custom command registry unavailable; use /scriptevent rw:*'); return; }
      registerCommands(api).install(reg);
    });
    return true;
  } catch (e) {
    log('startup event unavailable', e?.message ?? e);
    return false;
  }
}
