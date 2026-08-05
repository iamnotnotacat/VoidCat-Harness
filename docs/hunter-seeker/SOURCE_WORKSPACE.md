# Hunter-Seeker source workspace

Hunter-Seeker uses a three-part geospatial workspace: a resizable Source Explorer, the primary MapLibre canvas, and an optional intelligence panel.

## Source registry

`build/hunter-seeker/source-workspace.ts` is the UI-facing source definition registry. It joins the 41-source catalog to the original operational scheduler descriptors instead of presenting a second, disconnected catalog. Known aliases (including the grouped military/civil aviation controls and the combined NASA EONET layer) map to one definition, while original sources that are not part of the 41 remain available as extensions. The current built-in runtime resolves to 52 unique controls: 41 catalog integrations plus 11 original-only extensions. Every definition declares:

- a stable ID, provider, category, description, icon, documentation, license, and attribution;
- live, historical, viewport, alert, AI, credential, geometry, and render capabilities;
- the operational source IDs it controls;
- a settings schema and safe defaults;
- provider refresh floors and rate-limit guidance.

To add a source, add its provider adapter and catalog entry, map it to one of the declared categories, add any source-specific filters, and add fixture tests. Do not add JSX conditionals for ordinary provider fields; extend the schema instead. A provider must not be labeled live until its adapter and normalized observation output pass tests.

## Retrieval versus display

The retrieval checkbox controls provider activity. The eye control only changes whether already-loaded records or raster overlays are drawn on the map. Hiding a layer never starts or stops provider traffic. Disabling a source retains its latest bounded in-memory result, so re-enabling it can restore data without another provider request.

Scheduled feeds activate immediately through their existing adapter. A bounded-query feed opens its viewport, point, time-window, resource, or search form the first time it is enabled. The source is not marked enabled until that query succeeds. Observation results enter the common map and active-UNIT paths; catalog/reference results open in an inspectable evidence dialog. Once a bounded query succeeds, its validated scope is retained only in volatile service memory and can be manually or automatically refreshed. Automatic query refresh runs one due source at a time, applies the user-selected lower traffic budget, and cannot bypass the provider adapter's hard request guard.

The floating Layer Manager lists enabled map-capable sources. It controls visibility, opacity, source order, refresh, settings, and zoom-to-data. Manual refresh bypasses the selected automatic cadence but still respects provider rate limits, retry instructions, shared request budgets, and in-flight request protection.

## Settings and credentials

The settings dialog is generated from each source definition. Common sections cover connection, enforced refresh cadence, map display, filters, active-UNIT analysis, privacy and policy, and advanced cache controls. Source-specific fields are added only when the current adapter can enforce them; unsupported switches are not shown.

Secrets never enter workspace settings. Credential configuration, testing, replacement, and removal are delegated to the existing Electron main-process broker. The renderer receives only masked state or a fingerprint. Do not add credentials, headers, or tokens to saved views, logs, source query URLs, exports, or reports.

## Saved views and migration

Workspace preferences are stored as the versioned `hunterWorkspace` settings object. Startup migration imports the previous `hunterSourceSettings` enabled values, creates safe defaults for new sources, rejects malformed preset fields, clamps sizes and numeric settings, and preserves up to 30 custom views.

Built-in views include severe weather, natural disasters, global conflict, aviation, maritime, infrastructure, cyber activity, environmental conditions, public cameras, all sources, and a minimal map. Custom views contain source IDs, visible layer IDs, source filters and display settings, exact map center and zoom, and the time window. They never contain credentials.

## Keyboard and responsive behavior

- `/` focuses Source Explorer search when focus is not already in an input.
- `Alt+E` collapses or opens the Source Explorer.
- `Alt+D` hides every map layer without stopping source retrieval.
- `Alt+R` refreshes enabled sources.
- `Alt+S` opens settings for the first enabled source.
- `Escape` closes the source settings dialog.

At narrower widths the explorer becomes a drawer. The optional intelligence pane collapses into the available center column and becomes a bottom sheet on small screens. All rendered text remains at or above the 10px product floor, native controls retain visible focus states, and reduced-motion behavior follows the shared application contract.

## Safety and performance

- Source rows use `content-visibility` and a bounded scrolling region.
- Map records remain capped by the existing renderer budgets; DeFlock keeps lightweight regional hubs and only expands an operator-selected region.
- Source settings cannot raise provider request ceilings.
- Search, source queries, and history operations remain bounded and explicit.
- All 41 catalog entries have installed provider adapters. Sources that require protected credentials or an initial bounded scope are visibly marked and cannot pretend to be live before setup succeeds.

Run `npm run typecheck`, `npm run test:unit`, and `npm run build` after registry, workspace, or map changes.
