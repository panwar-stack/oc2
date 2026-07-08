<p align="center">
  <a href="https://oc2.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="Logo OC2">
    </picture>
  </a>
</p>
<p align="center">L’agente di coding AI open source.</p>
<p align="center">
  <a href="https://oc2.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/oc2-ai"><img alt="npm" src="https://img.shields.io/npm/v/oc2-ai?style=flat-square" /></a>
  <a href="https://github.com/panwar-stack/oc2/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/opencode/publish.yml?style=flat-square&branch=dev" /></a>
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

### Installazione

```bash
# YOLO
curl -fsSL https://oc2.ai/install | bash

# Package manager
npm i -g oc2-ai@latest        # oppure bun/pnpm/yarn
scoop install oc2             # Windows
choco install oc2             # Windows
brew install anomalyco/tap/oc2 # macOS e Linux (consigliato, sempre aggiornato)
brew install oc2              # macOS e Linux (formula brew ufficiale, aggiornata meno spesso)
sudo pacman -S oc2            # Arch Linux (Stable)
paru -S oc2-bin               # Arch Linux (Latest from AUR)
mise use -g oc2               # Qualsiasi OS
nix run nixpkgs#oc2           # oppure github:anomalyco/opencode per l’ultima branch di sviluppo
```

> [!TIP]
> Rimuovi le versioni precedenti alla 0.1.x prima di installare.

### App Desktop (BETA)

OC2 è disponibile anche come applicazione desktop. Puoi scaricarla direttamente dalla [pagina delle release](https://github.com/panwar-stack/oc2/releases) oppure da [oc2.ai/download](https://oc2.ai/download).

| Piattaforma           | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `oc2-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `oc2-desktop-mac-x64.dmg`     |
| Windows               | `oc2-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, oppure AppImage    |

```bash
# macOS (Homebrew)
brew install --cask oc2-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/oc2-desktop
```

#### Directory di installazione

Lo script di installazione rispetta il seguente ordine di priorità per il percorso di installazione:

1. `$OC2_INSTALL_DIR` – Directory di installazione personalizzata
2. `$XDG_BIN_DIR` – Percorso conforme alla XDG Base Directory Specification
3. `$HOME/bin` – Directory binaria standard dell’utente (se esiste o può essere creata)
4. `$HOME/.oc2/bin` – Fallback predefinito

```bash
# Esempi
OC2_INSTALL_DIR=/usr/local/bin curl -fsSL https://oc2.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://oc2.ai/install | bash
```

### Agenti

OC2 include due agenti integrati tra cui puoi passare usando il tasto `Tab`.

- **build** – Predefinito, agente con accesso completo per il lavoro di sviluppo
- **plan** – Agente in sola lettura per analisi ed esplorazione del codice
  - Nega le modifiche ai file per impostazione predefinita
  - Chiede il permesso prima di eseguire comandi bash
  - Ideale per esplorare codebase sconosciute o pianificare modifiche

È inoltre incluso un sotto-agente **general** per ricerche complesse e attività multi-step.
Viene utilizzato internamente e può essere invocato usando `@general` nei messaggi.

I sotto-agenti sono tipi di agente specializzati che un agente primario può invocare per un'attività. I teammate sono diversi: sono sessioni figlie in background dentro un agent team, ciascuna con nome, tipo di agente, prompt di ruolo, dipendenze, messaggi mailbox e approvazione opzionale del piano. Un teammate può eseguire un tipo di sotto-agente, ma "teammate" è il ruolo di coordinamento del team, non una modalità agente.

Scopri di più sugli [agenti](https://oc2.ai/docs/agents).

### Documentazione

Per maggiori informazioni su come configurare OC2, [**consulta la nostra documentazione**](https://oc2.ai/docs).

### Contribuire

Se sei interessato a contribuire a OC2, leggi la nostra [guida alla contribuzione](./CONTRIBUTING.md) prima di inviare una pull request.

### Costruire su OC2

Se stai lavorando a un progetto correlato a OC2 e che utilizza “oc2” come parte del nome (ad esempio “oc2-dashboard” o “oc2-mobile”), aggiungi una nota nel tuo README per chiarire che non è sviluppato dal team OC2 e che non è affiliato in alcun modo con noi.

---

**Unisciti alla nostra community** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
