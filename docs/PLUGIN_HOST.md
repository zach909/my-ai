# Plugin host

`plugin_manager/host.ts` is the one small thing that is not a plugin. Everything else is meant to be a
`KernelPlugin`: a named unit with a lifecycle, the plugins it needs, the services it offers and the HTTP routes it
owns. The host starts them in dependency order, stops them in reverse, passes services between them, hands the server
the routes of the plugins that are running, and remembers which are turned off.

This is separate from `PluginRegistry` (`plugin_manager/registry.ts`), which runs the agent's chat-command plugins
(location, camera, file system and so on). That registry is unchanged.

## What is a plugin today

| Plugin id | Owns | Guarded |
| --- | --- | --- |
| `plugin-host-routes` | `/api/plugin-host` (the list, turn off, turn on) | yes |
| `platform-routes` | settings, app info, updates, AI OS, install files | no |
| `accounts-routes` | accounts and logging in (and the login paths that skip the password gate) | yes |
| `hosted-routes` | hosted mode (needs `accounts-routes`) | no |
| `corona-routes` | apps, compute sharing, data donor, the token-checked `/api/corona/v1` API | no |
| `memory-topics-routes` | the folder-tree memory | no |
| `safety-routes` | risky tools, approvals, complete access, auto-continue | yes |
| `weights-routes` | net maker, net skill maker, weight editor, compiler | no |
| `agent-routes` | sandbox, danger level, alignment protocol | yes |
| `commons-routes` | points, projects, the hive | no |

The route handlers themselves did not change. `interface/server-plugins.ts` maps the server's per-request context onto
the context each handler already took, and `interface/web-server.ts` makes one dispatch call where nine hand-written
blocks stood.

## Guarded plugins

A plugin marked `guarded` can be turned off only by the owner (`actor: "owner"`). A request from the agent acting on its
own, or from the system, is refused before anything is stopped, and so is turning off a plugin that a guarded one
depends on. Without this, anything the agent can call could switch off what watches the agent, which the danger protocol
already treats as the worst thing it can do.

## Turning plugins off and on

- `GET /api/plugin-host` lists every plugin: state, whether it is on, what it needs and offers, any error.
- `POST /api/plugin-host/<id>/disable` and `/enable` (owner or admin only). Turning one off stops everything that needs
  it; turning it back on restarts what was stopped only for that reason.
- The choice is kept in `plugins.json` beside the other config files (`interface/platform/app-paths.ts`).
- A plugin that is turned off answers nothing, and the paths it kept open past the password gate close with it.
- `plugin-host-routes` cannot be turned off over HTTP: it is how plugins are turned back on.

## Not yet plugins

The agent's brain, mesh, Zip Loop, the ~170 modules in `models && skills/core/` (including the alignment veto, danger
protocol and tool gate, which other modules import directly), the interface pages, and the platform layer are still
fixed wiring. Moving each behind the host needs a decision per module about what "turned off" means (see the
discussion on the pull request that added this).
