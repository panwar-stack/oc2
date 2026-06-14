# Dependency Review Notes

`oc2` intentionally keeps the dependency set small for a local-first runtime.

## Runtime Dependencies

- `jsonc-parser`: parses user and project JSONC configuration while preserving support for comments and trailing commas.
- `zod`: validates configuration shapes and reports structured diagnostics for invalid config values.

## Development Dependencies

- `@tsconfig/bun`: provides Bun-oriented TypeScript defaults for strict compilation.
- `@types/bun`: supplies Bun runtime types used by source and tests.
- `oxlint`: provides fast lint checks for TypeScript source and tests.
- `prettier`: keeps repository formatting deterministic.
- `typescript`: runs strict `tsc --noEmit` type checks.

## Circular Dependencies

No dedicated circular dependency package is currently installed. PR 16 adds `bun run check` as the final non-mutating quality gate without expanding the dependency graph just to inspect the dependency graph. A circular import checker should be added later if the project accepts another development dependency or builds a small internal analyzer.
