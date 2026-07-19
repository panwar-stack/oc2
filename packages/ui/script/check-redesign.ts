#!/usr/bin/env bun

import colorName from "color-name"

const uiRoot = `${import.meta.dir}/..`
const appRoot = `${import.meta.dir}/../../app`
const directories = [
  `${uiRoot}/src/v2`,
  `${uiRoot}/src/pierre`,
  `${appRoot}/src/components/settings-v2`,
  `${appRoot}/src/pages/session/composer`,
]
const direct = [
  `${uiRoot}/src/components/basic-tool.css`,
  `${uiRoot}/src/components/basic-tool.tsx`,
  `${uiRoot}/src/components/context-menu.css`,
  `${uiRoot}/src/components/dialog.css`,
  `${uiRoot}/src/components/dropdown-menu.css`,
  `${uiRoot}/src/components/markdown.css`,
  `${uiRoot}/src/components/message-part.css`,
  `${uiRoot}/src/components/message-part.tsx`,
  `${uiRoot}/src/components/select.css`,
  `${uiRoot}/src/components/toast.css`,
  `${uiRoot}/src/components/dock-prompt.tsx`,
  `${uiRoot}/src/components/tool-error-card.tsx`,
  `${appRoot}/src/components/dialog-connect-provider.tsx`,
  `${appRoot}/src/components/dialog-custom-provider.tsx`,
  `${appRoot}/src/components/dialog-select-file.tsx`,
  `${appRoot}/src/components/settings-keybinds.tsx`,
  `${appRoot}/src/components/prompt-input/context-items.tsx`,
  `${appRoot}/src/components/prompt-input/image-attachments.tsx`,
  `${appRoot}/src/components/terminal.tsx`,
  `${appRoot}/src/components/prompt-input.tsx`,
  `${appRoot}/src/index.css`,
  `${appRoot}/src/pages/home.tsx`,
  `${appRoot}/src/pages/error.tsx`,
  `${appRoot}/src/pages/layout.tsx`,
  `${appRoot}/src/pages/session/session-aggregate-chrome.tsx`,
  `${appRoot}/src/pages/session/team-board.tsx`,
]
const scanned = await Promise.all(
  directories.map(async (directory) =>
    (await Array.fromAsync(new Bun.Glob("**/*.{css,ts,tsx}").scan({ cwd: directory }))).map(
      (path) => `${directory}/${path}`,
    ),
  ),
)
const files = [...new Set([...direct, ...scanned.flat()])].filter((path) => !path.includes(".test.")).toSorted()
const contents = await Promise.all(files.map(async (path) => ({ path, text: await Bun.file(path).text() })))
const definitions = new Set<string>()
const namedColors = Object.keys(colorName).toSorted((first, second) => second.length - first.length)

for (const item of contents) {
  for (const match of item.text.matchAll(/--(v2-[\w-]+)\s*:/g)) definitions.add(match[1]!)
}
for (const path of [`${uiRoot}/src/v2/styles/colors.css`, `${uiRoot}/src/v2/styles/theme.css`]) {
  const text = await Bun.file(path).text()
  for (const match of text.matchAll(/--(v2-[\w-]+)\s*:/g)) definitions.add(match[1]!)
}

const colorExceptions = new Map<string, Set<string>>([
  [`${uiRoot}/src/v2/components/tab-state-indicator.tsx`, new Set(["#808080"])],
  [`${uiRoot}/src/v2/components/wordmark-v2.tsx`, new Set(['stop-color="white"'])],
  [`${appRoot}/src/components/prompt-input/image-attachments.tsx`, new Set(["bg-black/50", "text-white"])],
])
const errors: string[] = []
const attributeContract = [
  `${uiRoot}/src/components/basic-tool.tsx`,
  `${uiRoot}/src/components/dock-prompt.tsx`,
  `${uiRoot}/src/components/message-part.tsx`,
  `${uiRoot}/src/components/tool-error-card.tsx`,
  `${appRoot}/src/pages/session/message-timeline.tsx`,
]

for (const item of contents) {
  for (const match of item.text.matchAll(/var\(--(v2-[\w-]+)/g)) {
    if (match[1]!.endsWith("-")) continue
    if (!definitions.has(match[1]!)) errors.push(`${item.path}: missing declaration for --${match[1]}`)
  }

  if (item.path.endsWith("/v2/styles/colors.css") || item.path.endsWith("/v2/styles/theme.css")) continue
  const colorPatterns = [
    /#[\da-f]{3,8}\b|rgba?\(\s*[\d.][^)]*\)|hsla?\(\s*[\d.][^)]*\)/gi,
    /(?<![-\w])(?:bg|text|border|fill|stroke)-(?:black|white)(?:\/\d+)?/gi,
    /(?<![-\w])(?:bg|text|border|fill|stroke)-[a-z][a-z-]*-\d{2,3}(?:\/\d+)?/gi,
    new RegExp(`(?:fill|stroke|stop-color)=["'](?:${namedColors.join("|")})["']`, "gi"),
    ...(item.path.endsWith(".css")
      ? [new RegExp(`:\\s*[^;{}]*(?<![-\\w])(?:${namedColors.join("|")})(?![-\\w])[^;{}]*;`, "gi")]
      : []),
  ]
  for (const pattern of colorPatterns) {
    for (const match of item.text.matchAll(pattern)) {
      if (colorExceptions.get(item.path)?.has(match[0])) continue
      const line = item.text.slice(0, match.index).split("\n").length
      errors.push(`${item.path}:${line}: hardcoded color ${match[0]}`)
    }
  }
}

for (const path of attributeContract) {
  const text = await Bun.file(path).text()
  for (const attribute of ["data-redesigned", "data-kind"]) {
    if (!text.includes(attribute)) continue
    errors.push(`${path}: forbidden redesign attribute ${attribute}`)
  }
}

if (errors.length) {
  console.error(errors.join("\n"))
  process.exit(1)
}

console.log(`Checked ${files.length} redesign files for declared variables and hardcoded colors`)
