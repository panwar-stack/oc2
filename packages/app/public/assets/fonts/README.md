# Bundled Product Fonts

The app bundles fixed, self-hosted font files so the product typography works without a network request.

## Standard Families

Both standard product fonts came from fixed Fontsource npm packages. The package archives were fetched from the npm
registry, their selected members were copied without modification, and the packages' SIL OFL 1.1 notices are retained
beside the fonts.

| App asset                           | Source package member                                                                                                     | Source URL                                                                                  | SHA-256                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `InterVariable-Latin.woff2`         | `@fontsource-variable/inter@5.2.8` `files/inter-latin-standard-normal.woff2` (Inter 4.001, `opsz`/`wght`)                 | <https://registry.npmjs.org/@fontsource-variable/inter/-/inter-5.2.8.tgz>                   | `2c295d99e26dcf357d4d01bcf270fd6924b600c9a13dd8c363ef114f4c6976fa` |
| `JetBrainsMonoVariable-Latin.woff2` | `@fontsource-variable/jetbrains-mono@5.2.8` `files/jetbrains-mono-latin-wght-normal.woff2` (JetBrains Mono 2.211, `wght`) | <https://registry.npmjs.org/@fontsource-variable/jetbrains-mono/-/jetbrains-mono-5.2.8.tgz> | `18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e` |

For archive-level verification, the Inter package SHA-256 is
`de400e4154a9cbd8ecdaf99183b39a1277a217d967472bfa8b33af1dafc324a7` and the JetBrains Mono package SHA-256 is
`24f31f8a47cd8dbba3f056a339170a1b24a28405558b10165b9c83b011a6e48d`.
The corresponding `Inter-OFL-1.1.txt` and `JetBrainsMono-OFL-1.1.txt` notice SHA-256 values are
`3b0a5fca3d17942cde889069889dedbbbd075e9b599968c82a95f4d944e9b345` and
`403581b69dac5cff4079205e01c6b467e56af449ecbd7247693ddb1baafa005b`, respectively.

Authoritative family references: <https://rsms.me/inter/> and <https://www.jetbrains.com/lp/mono/>.

## Glyph Fallback

These are Fontsource's Latin web subsets, not full-family fonts. Their declared Unicode range matches the package CSS.
The redesign status glyphs (`○ ◐ ◑ ◓ ✓ ✕ ▲ ▸ ▾ ● ✉ ⌗ ▤ ▰ ▱ ↳ ⏎`) and platform key symbols are intentionally
rendered by the following `ui-sans-serif`/`system-ui` or `ui-monospace`/system fallback in the design-system stacks.
This is a documented system fallback and does not claim bundled cmap coverage. Arbitrary user text and scripts outside
the subset likewise fall through to the platform fonts.

## Legacy Migration Face

`../JetBrainsMonoNerdFontMono-Regular.woff2` remains only for persisted settings that explicitly select
`JetBrainsMono Nerd Font Mono`. It must never back the plain `JetBrains Mono` family. Its embedded metadata identifies
JetBrains Mono 2.304 patched by Nerd Fonts 3.4.0 under SIL OFL 1.1. It entered this repository in commit
`10bd044c55600408f2bca606bb6ce37c88b459f9`; its SHA-256 is
`587236ebb19a2da874c459d14bbe7785a5eb7e1d87969db9574454d09ea50d1c`. The corresponding pinned upstream release is
<https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.4.0>. The original repository asset was already WOFF2, so this
record does not claim byte identity with Nerd Fonts' published TTF.

The pinned upstream
[`patched-fonts/JetBrainsMono/Ligatures/Regular/OFL.txt`](https://raw.githubusercontent.com/ryanoasis/nerd-fonts/v3.4.0/patched-fonts/JetBrainsMono/Ligatures/Regular/OFL.txt)
is retained as `JetBrainsMonoNerdFontMono-OFL-1.1.txt`; the
[release-level notice](https://raw.githubusercontent.com/ryanoasis/nerd-fonts/v3.4.0/LICENSE) is retained as
`NerdFonts-3.4.0-LICENSE.txt`. Trailing whitespace was normalized without changing the notice text. Their SHA-256
values are `60d55f23c6ce05a81099a762cb67ca2c9b6ea251c7912720998b4c89ebfd4faa` and
`bede0739eb2bf948765623a7a134360a6320240f4a9e29a5a68f31e191b0f8d0`, respectively.
