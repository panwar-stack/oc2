<p align="center">
  <a href="https://oc2.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OC2 logo">
    </picture>
  </a>
</p>
<p align="center">AI-kodeagent med åpen kildekode.</p>
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

### Installasjon

```bash
# YOLO
curl -fsSL https://oc2.ai/install | bash

# Pakkehåndterere
npm i -g oc2@latest        # eller bun/pnpm/yarn
scoop install oc2             # Windows
choco install oc2             # Windows
brew install anomalyco/tap/oc2 # macOS og Linux (anbefalt, alltid oppdatert)
brew install oc2              # macOS og Linux (offisiell brew-formel, oppdateres sjeldnere)
sudo pacman -S oc2            # Arch Linux (Stable)
paru -S oc2-bin               # Arch Linux (Latest from AUR)
mise use -g oc2               # alle OS
nix run nixpkgs#oc2           # eller github:anomalyco/opencode for nyeste dev-branch
```

> [!TIP]
> Fjern versjoner eldre enn 0.1.x før du installerer.

### Desktop-app (BETA)

OC2 er også tilgjengelig som en desktop-app. Last ned direkte fra [releases-siden](https://github.com/anomalyco/opencode/releases) eller [oc2.ai/download](https://oc2.ai/download).

| Plattform             | Nedlasting                         |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `oc2-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `oc2-desktop-mac-x64.dmg`     |
| Windows               | `oc2-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm` eller AppImage      |

```bash
# macOS (Homebrew)
brew install --cask oc2-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/oc2-desktop
```

#### Installasjonsmappe

Installasjonsskriptet bruker følgende prioritet for installasjonsstien:

1. `$OC2_INSTALL_DIR` - Egendefinert installasjonsmappe
2. `$XDG_BIN_DIR` - Sti som følger XDG Base Directory Specification
3. `$HOME/bin` - Standard brukerbinar-mappe (hvis den finnes eller kan opprettes)
4. `$HOME/.oc2/bin` - Standard fallback

```bash
# Eksempler
OC2_INSTALL_DIR=/usr/local/bin curl -fsSL https://oc2.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://oc2.ai/install | bash
```

### Agents

OC2 har to innebygde agents du kan bytte mellom med `Tab`-tasten.

- **build** - Standard, agent med full tilgang for utviklingsarbeid
- **plan** - Skrivebeskyttet agent for analyse og kodeutforsking
  - Nekter filendringer som standard
  - Spør om tillatelse før bash-kommandoer
  - Ideell for å utforske ukjente kodebaser eller planlegge endringer

Det finnes også en **general**-subagent for komplekse søk og flertrinnsoppgaver.
Den brukes internt og kan kalles via `@general` i meldinger.

Subagenter er spesialiserte agenttyper som en primær agent kan kalle for en oppgave. Teammates er annerledes: de er bakgrunns-child sessions i et agent team, hver med eget navn, agenttype, rolleprompt, avhengigheter, mailbox-meldinger og valgfri plangodkjenning. En teammate kan kjøre en subagenttype, men "teammate" er teamets koordineringsrolle, ikke en agentmodus.

Les mer om [agents](https://oc2.ai/docs/agents).

### Dokumentasjon

For mer info om hvordan du konfigurerer OC2, [**se dokumentasjonen**](https://oc2.ai/docs).

### Bidra

Hvis du vil bidra til OC2, les [contributing docs](./CONTRIBUTING.md) før du sender en pull request.

### Bygge på OC2

Hvis du jobber med et prosjekt som er relatert til OC2 og bruker "oc2" som en del av navnet; for eksempel "oc2-dashboard" eller "oc2-mobile", legg inn en merknad i README som presiserer at det ikke er bygget av OC2-teamet og ikke er tilknyttet oss på noen måte.

---

**Bli med i fellesskapet** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
