# V2 Catalog Transform Decision

V2 uses replayable, Location-scoped Catalog transforms. This is the selected and implemented alternative to allowing plugins to mutate the aggregate configuration object and forcing all config-derived services to reload together.

## Decision

The Catalog owns provider/model materialization. Each source acquires a scoped transform and supplies mutations through `Catalog.Editor` operations for providers, models, and the configured default model.

Active transforms are replayed in registration order whenever Catalog state is rebuilt. Replacing one transform contribution recomputes visible state from all active contributors. Closing its Scope unregisters only that contribution and rematerializes the remainder.

## Sources

Built-in Plugin Boot activates Location-scoped contributors including:

- provider metadata from models.dev;
- environment and account availability;
- built-in provider-specific behavior;
- the virtual Fugu model;
- authored provider/model configuration.

Plugin activation is serialized by the Location plugin registry. Catalog observes plugin additions for the same Location and applies the new plugin's Catalog hook without rebuilding unrelated Locations.

## Finalization

After source transforms run, Catalog finalization applies plugin `catalog.transform` hooks and provider policy. Denied providers are removed only after all sources have contributed, so a later transform cannot accidentally recreate a provider after enforcement.

Catalog reads distinguish stored records from availability:

- `all()` returns materialized records;
- `available()` requires enabled provider and model state;
- explicit configured default selection is used only while available;
- provider request and API defaults are resolved into model reads.

## Boundaries

- Config remains one Catalog source, not mutable plugin-owned global state.
- Catalog transforms cannot mutate agents, MCP, permissions, or unrelated configuration.
- Transform Scope defines contribution lifetime and rollback.
- Catalog and its plugin registry are Location-scoped even though the event bus is process-scoped.
- Config and policy are snapshots for the Location lifetime; file watching and live Location reload are not part of this decision.
