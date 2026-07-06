<p align="center">
  <a href="https://oc2.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OC2 logo">
    </picture>
  </a>
</p>
<p align="center">OC2 je open source AI agent za programiranje.</p>
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

### Instalacija

```bash
# YOLO
curl -fsSL https://oc2.ai/install | bash

# Package manageri
npm i -g oc2@latest        # ili bun/pnpm/yarn
scoop install oc2             # Windows
choco install oc2             # Windows
brew install anomalyco/tap/oc2 # macOS i Linux (preporučeno, uvijek ažurno)
brew install oc2              # macOS i Linux (zvanična brew formula, rjeđe se ažurira)
sudo pacman -S oc2            # Arch Linux (Stable)
paru -S oc2-bin               # Arch Linux (Latest from AUR)
mise use -g oc2               # Bilo koji OS
nix run nixpkgs#oc2           # ili github:anomalyco/opencode za najnoviji dev branch
```

> [!TIP]
> Ukloni verzije starije od 0.1.x prije instalacije.

### Desktop aplikacija (BETA)

OC2 je dostupan i kao desktop aplikacija. Preuzmi je direktno sa [stranice izdanja](https://github.com/anomalyco/opencode/releases) ili sa [oc2.ai/download](https://oc2.ai/download).

| Platforma             | Preuzimanje                        |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `oc2-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `oc2-desktop-mac-x64.dmg`     |
| Windows               | `oc2-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, ili AppImage       |

```bash
# macOS (Homebrew)
brew install --cask oc2-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/oc2-desktop
```

#### Instalacijski direktorij

Instalacijska skripta koristi sljedeći redoslijed prioriteta za putanju instalacije:

1. `$OC2_INSTALL_DIR` - Prilagođeni instalacijski direktorij
2. `$XDG_BIN_DIR` - Putanja usklađena sa XDG Base Directory specifikacijom
3. `$HOME/bin` - Standardni korisnički bin direktorij (ako postoji ili se može kreirati)
4. `$HOME/.oc2/bin` - Podrazumijevana rezervna lokacija

```bash
# Primjeri
OC2_INSTALL_DIR=/usr/local/bin curl -fsSL https://oc2.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://oc2.ai/install | bash
```

### Agenti

OC2 uključuje dva ugrađena agenta između kojih možeš prebacivati tasterom `Tab`.

- **build** - Podrazumijevani agent sa punim pristupom za razvoj
- **plan** - Agent samo za čitanje za analizu i istraživanje koda
  - Podrazumijevano zabranjuje izmjene datoteka
  - Traži dozvolu prije pokretanja bash komandi
  - Idealan za istraživanje nepoznatih codebase-ova ili planiranje izmjena

Uključen je i **general** pod-agent za složene pretrage i višekoračne zadatke.
Koristi se interno i može se pozvati pomoću `@general` u porukama.

Pod-agenti su specijalizovani tipovi agenata koje primarni agent može pozvati za određeni zadatak. Teammates su drugačiji: to su pozadinske child sesije u agent team-u, svaka sa svojim imenom, tipom agenta, role promptom, zavisnostima, mailbox porukama i opcionalnim odobravanjem plana. Teammate može pokretati tip pod-agenta, ali "teammate" je koordinaciona uloga u timu, nije mod agenta.

Saznaj više o [agentima](https://oc2.ai/docs/agents).

### Dokumentacija

Za više informacija o konfiguraciji OC2-a, [**pogledaj dokumentaciju**](https://oc2.ai/docs).

### Doprinosi

Ako želiš doprinositi OC2-u, pročitaj [upute za doprinošenje](./CONTRIBUTING.md) prije slanja pull requesta.

### Gradnja na OC2-u

Ako radiš na projektu koji je povezan s OC2-om i koristi "oc2" kao dio naziva, npr. "oc2-dashboard" ili "oc2-mobile", dodaj napomenu u svoj README da projekat nije napravio OC2 tim i da nije povezan s nama.

---

**Pridruži se našoj zajednici** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
