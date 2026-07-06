<p align="center">
  <a href="https://oc2.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OC2 logo">
    </picture>
  </a>
</p>
<p align="center">Den open source AI-kodeagent.</p>
<p align="center">
  <a href="https://oc2.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/oc2"><img alt="npm" src="https://img.shields.io/npm/v/oc2?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/opencode/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/opencode/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

[![OC2 Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://oc2.ai)

---

### Installation

```bash
# YOLO
curl -fsSL https://oc2.ai/install | bash

# Pakkehåndteringer
npm i -g oc2@latest        # eller bun/pnpm/yarn
scoop install oc2             # Windows
choco install oc2             # Windows
brew install anomalyco/tap/oc2 # macOS og Linux (anbefalet, altid up to date)
brew install oc2              # macOS og Linux (officiel brew formula, opdateres sjældnere)
sudo pacman -S oc2            # Arch Linux (Stable)
paru -S oc2-bin               # Arch Linux (Latest from AUR)
mise use -g oc2               # alle OS
nix run nixpkgs#oc2           # eller github:anomalyco/opencode for nyeste dev-branch
```

> [!TIP]
> Fjern versioner ældre end 0.1.x før installation.

### Desktop-app (BETA)

OC2 findes også som desktop-app. Download direkte fra [releases-siden](https://github.com/anomalyco/opencode/releases) eller [oc2.ai/download](https://oc2.ai/download).

| Platform              | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `oc2-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `oc2-desktop-mac-x64.dmg`     |
| Windows               | `oc2-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, eller AppImage     |

```bash
# macOS (Homebrew)
brew install --cask oc2-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/oc2-desktop
```

#### Installationsmappe

Installationsscriptet bruger følgende prioriteringsrækkefølge for installationsstien:

1. `$OC2_INSTALL_DIR` - Tilpasset installationsmappe
2. `$XDG_BIN_DIR` - Sti der følger XDG Base Directory Specification
3. `$HOME/bin` - Standard bruger-bin-mappe (hvis den findes eller kan oprettes)
4. `$HOME/.oc2/bin` - Standard fallback

```bash
# Eksempler
OC2_INSTALL_DIR=/usr/local/bin curl -fsSL https://oc2.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://oc2.ai/install | bash
```

### Agents

OC2 har to indbyggede agents, som du kan skifte mellem med `Tab`-tasten.

- **build** - Standard, agent med fuld adgang til udviklingsarbejde
- **plan** - Skrivebeskyttet agent til analyse og kodeudforskning
  - Afviser filredigering som standard
  - Spørger om tilladelse før bash-kommandoer
  - Ideel til at udforske ukendte kodebaser eller planlægge ændringer

Derudover findes der en **general**-subagent til komplekse søgninger og flertrinsopgaver.
Den bruges internt og kan kaldes via `@general` i beskeder.

Subagents er specialiserede agenttyper, som en primær agent kan kalde til en opgave. Teammates er noget andet: de er baggrunds-child sessions i et agent team, hver med sit eget navn, agenttype, rolleprompt, afhængigheder, mailbox-beskeder og valgfri plangodkendelse. En teammate kan køre en subagenttype, men "teammate" er teamets koordineringsrolle, ikke en agenttilstand.

Læs mere om [agents](https://oc2.ai/docs/agents).

### Dokumentation

For mere info om konfiguration af OC2, [**se vores docs**](https://oc2.ai/docs).

### Bidrag

Hvis du vil bidrage til OC2, så læs vores [contributing docs](./CONTRIBUTING.md) før du sender en pull request.

### Bygget på OC2

Hvis du arbejder på et projekt der er relateret til OC2 og bruger "oc2" som en del af navnet; f.eks. "oc2-dashboard" eller "oc2-mobile", så tilføj en note i din README, der tydeliggør at projektet ikke er bygget af OC2-teamet og ikke er tilknyttet os på nogen måde.

---

**Bliv en del af vores community** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
