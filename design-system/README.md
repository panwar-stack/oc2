# Design System Token Source

`tokens.json` is an exact, build-time-only copy of
`oc2-redesign/deisgn-system/tokens/tokens.json` version 1.0.0, dated 2026-07-17.
Its SHA-256 is `f60bbd59341dd64e19d16a1bf867891eb4788cc0acc719787bbbbd95f4585db9`.

Run `bun run check:tokens` to compare ten shared semantic tokens in both modes
against the web `--v2-*` layer and the TUI `oc2` theme. The check normalizes
hex and RGBA colors, including byte-equivalent alpha values.

The pre-existing `--v2-elevation-*` variables are excluded. The master has no
semantic values for those names, and web consumers require box-shadow recipes,
not colors. The canonical `shadow.*` values remain represented by their
separate `--v2-shadow-*` mapping rather than this cross-platform color check.
