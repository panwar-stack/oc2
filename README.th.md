<p align="center">
  <a href="https://oc2.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OC2 logo">
    </picture>
  </a>
</p>
<p align="center">เอเจนต์การเขียนโค้ดด้วย AI แบบโอเพนซอร์ส</p>
<p align="center">
  <a href="https://oc2.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/oc2-ai"><img alt="npm" src="https://img.shields.io/npm/v/oc2-ai?style=flat-square" /></a>
  <a href="https://github.com/panwar-stack/oc2/actions/workflows/publish.yml"><img alt="สถานะการสร้าง" src="https://img.shields.io/github/actions/workflow/status/anomalyco/opencode/publish.yml?style=flat-square&branch=dev" /></a>
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

### การติดตั้ง

```bash
# YOLO
curl -fsSL https://oc2.ai/install | bash

# ตัวจัดการแพ็กเกจ
npm i -g oc2-ai@latest        # หรือ bun/pnpm/yarn
scoop install oc2             # Windows
choco install oc2             # Windows
brew install anomalyco/tap/oc2 # macOS และ Linux (แนะนำ อัปเดตเสมอ)
brew install oc2              # macOS และ Linux (brew formula อย่างเป็นทางการ อัปเดตน้อยกว่า)
sudo pacman -S oc2            # Arch Linux (Stable)
paru -S oc2-bin               # Arch Linux (Latest from AUR)
mise use -g oc2               # ระบบปฏิบัติการใดก็ได้
nix run nixpkgs#oc2           # หรือ github:anomalyco/opencode สำหรับสาขาพัฒนาล่าสุด
```

> [!TIP]
> ลบเวอร์ชันที่เก่ากว่า 0.1.x ก่อนติดตั้ง

### แอปพลิเคชันเดสก์ท็อป (เบต้า)

OC2 มีให้ใช้งานเป็นแอปพลิเคชันเดสก์ท็อป ดาวน์โหลดโดยตรงจาก [หน้ารุ่น](https://github.com/panwar-stack/oc2/releases) หรือ [oc2.ai/download](https://oc2.ai/download)

| แพลตฟอร์ม             | ดาวน์โหลด                          |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `oc2-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `oc2-desktop-mac-x64.dmg`     |
| Windows               | `oc2-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, หรือ AppImage      |

```bash
# macOS (Homebrew)
brew install --cask oc2-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/oc2-desktop
```

#### ไดเรกทอรีการติดตั้ง

สคริปต์การติดตั้งจะใช้ลำดับความสำคัญตามเส้นทางการติดตั้ง:

1. `$OC2_INSTALL_DIR` - ไดเรกทอรีการติดตั้งที่กำหนดเอง
2. `$XDG_BIN_DIR` - เส้นทางที่สอดคล้องกับ XDG Base Directory Specification
3. `$HOME/bin` - ไดเรกทอรีไบนารีผู้ใช้มาตรฐาน (หากมีอยู่หรือสามารถสร้างได้)
4. `$HOME/.oc2/bin` - ค่าสำรองเริ่มต้น

```bash
# ตัวอย่าง
OC2_INSTALL_DIR=/usr/local/bin curl -fsSL https://oc2.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://oc2.ai/install | bash
```

### เอเจนต์

OC2 รวมเอเจนต์ในตัวสองตัวที่คุณสามารถสลับได้ด้วยปุ่ม `Tab`

- **build** - เอเจนต์เริ่มต้น มีสิทธิ์เข้าถึงแบบเต็มสำหรับงานพัฒนา
- **plan** - เอเจนต์อ่านอย่างเดียวสำหรับการวิเคราะห์และการสำรวจโค้ด
  - ปฏิเสธการแก้ไขไฟล์โดยค่าเริ่มต้น
  - ขอสิทธิ์ก่อนเรียกใช้คำสั่ง bash
  - เหมาะสำหรับสำรวจโค้ดเบสที่ไม่คุ้นเคยหรือวางแผนการเปลี่ยนแปลง

นอกจากนี้ยังมีเอเจนต์ย่อย **general** สำหรับการค้นหาที่ซับซ้อนและงานหลายขั้นตอน
ใช้ภายในและสามารถเรียกใช้ได้โดยใช้ `@general` ในข้อความ

เอเจนต์ย่อยคือประเภทเอเจนต์เฉพาะทางที่เอเจนต์หลักสามารถเรียกใช้สำหรับงานหนึ่งๆ ส่วน teammates แตกต่างออกไป: เป็นเซสชันลูกที่ทำงานเบื้องหลังใน agent team โดยแต่ละ teammate มีชื่อ ประเภทเอเจนต์ role prompt การพึ่งพา ข้อความ mailbox และการอนุมัติแผนแบบเลือกได้ของตัวเอง Teammate สามารถรันประเภทเอเจนต์ย่อยได้ แต่ "teammate" คือบทบาทประสานงานของทีม ไม่ใช่โหมดของเอเจนต์

เรียนรู้เพิ่มเติมเกี่ยวกับ [เอเจนต์](https://oc2.ai/docs/agents)

### เอกสารประกอบ

สำหรับข้อมูลเพิ่มเติมเกี่ยวกับวิธีกำหนดค่า OC2 [**ไปที่เอกสารของเรา**](https://oc2.ai/docs)

### การมีส่วนร่วม

หากคุณสนใจที่จะมีส่วนร่วมใน OC2 โปรดอ่าน [เอกสารการมีส่วนร่วม](./CONTRIBUTING.md) ก่อนส่ง Pull Request

### การสร้างบน OC2

หากคุณทำงานในโปรเจกต์ที่เกี่ยวข้องกับ OC2 และใช้ "oc2" เป็นส่วนหนึ่งของชื่อ เช่น "oc2-dashboard" หรือ "oc2-mobile" โปรดเพิ่มหมายเหตุใน README ของคุณเพื่อชี้แจงว่าไม่ได้สร้างโดยทีม OC2 และไม่ได้เกี่ยวข้องกับเราในทางใด

---

**ร่วมชุมชนของเรา** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
