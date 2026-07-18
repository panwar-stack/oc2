import { DiffLineAnnotation, FileContents, FileDiffOptions, type SelectedLineRange } from "@pierre/diffs"
import { ComponentProps } from "solid-js"
import { lineCommentStyles } from "../components/line-comment-styles"

export type DiffProps<T = {}> = FileDiffOptions<T> & {
  before: FileContents
  after: FileContents
  annotations?: DiffLineAnnotation<T>[]
  selectedLines?: SelectedLineRange | null
  commentedLines?: SelectedLineRange[]
  onLineNumberSelectionEnd?: (selection: SelectedLineRange | null) => void
  onRendered?: () => void
  class?: string
  classList?: ComponentProps<"div">["classList"]
}

const unsafeCSS = `
[data-diff],
[data-file] {
  --diffs-bg: var(--v2-diff-context-bg);
  --diffs-bg-buffer: var(--diffs-bg-buffer-override, var(--v2-background-bg-layer-01));
  --diffs-bg-hover: var(--diffs-bg-hover-override, var(--v2-background-bg-layer-02));
  --diffs-bg-context: var(--diffs-bg-context-override, var(--v2-diff-context-bg));
  --diffs-bg-separator: var(--diffs-bg-separator-override, var(--v2-background-bg-layer-02));
  --diffs-fg: var(--v2-diff-context);
  --diffs-fg-number: var(--diffs-fg-number-override, var(--v2-diff-line-number));
  --diffs-deletion-base: var(--v2-diff-removed);
  --diffs-addition-base: var(--v2-diff-added);
  --diffs-modified-base: var(--v2-diff-hunk-header);
  --diffs-bg-deletion: var(--diffs-bg-deletion-override, var(--v2-diff-removed-bg));
  --diffs-bg-deletion-number: var(--diffs-bg-deletion-number-override, var(--v2-diff-removed-line-number-bg));
  --diffs-bg-deletion-hover: var(--diffs-bg-deletion-hover-override, var(--v2-diff-removed-line-number-bg));
  --diffs-bg-deletion-emphasis: var(--diffs-bg-deletion-emphasis-override, var(--v2-diff-highlight-removed));
  --diffs-bg-addition: var(--diffs-bg-addition-override, var(--v2-diff-added-bg));
  --diffs-bg-addition-number: var(--diffs-bg-addition-number-override, var(--v2-diff-added-line-number-bg));
  --diffs-bg-addition-hover: var(--diffs-bg-addition-hover-override, var(--v2-diff-added-line-number-bg));
  --diffs-bg-addition-emphasis: var(--diffs-bg-addition-emphasis-override, var(--v2-diff-highlight-added));
  --diffs-selection-base: var(--v2-state-bg-decision);
  --diffs-selection-border: var(--v2-state-border-decision);
  --diffs-selection-number-fg: var(--v2-text-text-base);
  --diffs-bg-selection: var(--diffs-bg-selection-override, var(--v2-state-bg-decision));
  --diffs-bg-selection-number: var(--diffs-bg-selection-number-override, var(--v2-state-border-decision));
  --diffs-bg-selection-text: var(--v2-state-bg-decision);
}

[data-diff] ::selection,
[data-file] ::selection {
  background-color: var(--diffs-bg-selection-text);
}

::highlight(opencode-find) {
  background-color: var(--v2-state-bg-thinking);
}

::highlight(opencode-find-current) {
  background-color: var(--v2-state-border-thinking);
}

[data-diff] [data-line][data-comment-selected]:not([data-selected-line]) {
  box-shadow: inset 0 0 0 9999px var(--diffs-bg-selection);
}

[data-file] [data-line][data-comment-selected]:not([data-selected-line]) {
  box-shadow: inset 0 0 0 9999px var(--diffs-bg-selection);
}

[data-diff] [data-column-number][data-comment-selected]:not([data-selected-line]) {
  box-shadow: inset 0 0 0 9999px var(--diffs-bg-selection-number);
  color: var(--diffs-selection-number-fg);
}

[data-file] [data-column-number][data-comment-selected]:not([data-selected-line]) {
  box-shadow: inset 0 0 0 9999px var(--diffs-bg-selection-number);
  color: var(--diffs-selection-number-fg);
}

[data-diff] [data-line-annotation][data-comment-selected]:not([data-selected-line]) [data-annotation-content] {
  box-shadow: inset 0 0 0 9999px var(--diffs-bg-selection);
}

[data-file] [data-line-annotation][data-comment-selected]:not([data-selected-line]) [data-annotation-content] {
  box-shadow: inset 0 0 0 9999px var(--diffs-bg-selection);
}

[data-diff] [data-line][data-selected-line] {
  background-color: var(--diffs-bg-selection);
  box-shadow: inset 2px 0 0 var(--diffs-selection-border);
}

[data-file] [data-line][data-selected-line] {
  background-color: var(--diffs-bg-selection);
  box-shadow: inset 2px 0 0 var(--diffs-selection-border);
}

[data-diff] [data-column-number][data-selected-line] {
  background-color: var(--diffs-bg-selection-number);
  color: var(--diffs-selection-number-fg);
}

[data-file] [data-column-number][data-selected-line] {
  background-color: var(--diffs-bg-selection-number);
  color: var(--diffs-selection-number-fg);
}

[data-diff] [data-column-number][data-line-type='context'][data-selected-line],
[data-diff] [data-column-number][data-line-type='context-expanded'][data-selected-line],
[data-diff] [data-column-number][data-line-type='change-addition'][data-selected-line],
[data-diff] [data-column-number][data-line-type='change-deletion'][data-selected-line] {
  color: var(--diffs-selection-number-fg);
}

/* The deletion word-diff emphasis is stronger than additions; soften it while selected so the selection highlight reads consistently. */
[data-diff] [data-line][data-line-type='change-deletion'][data-selected-line] {
  --diffs-bg-deletion-emphasis: var(--v2-diff-highlight-removed);
}

[data-diff-header],
[data-diff],
[data-file] {
  [data-separator] {
    height: 24px;
  }
  [data-column-number] {
    background-color: var(--v2-diff-context-bg);
    cursor: default !important;
  }

  &[data-interactive-line-numbers] [data-column-number] {
    cursor: default !important;
  }

  &[data-interactive-lines] [data-line] {
    cursor: auto !important;
  }
  [data-code] {
    overflow-x: auto !important;
    overflow-y: clip !important;
  }
}

${lineCommentStyles}

`

export function createDefaultOptions<T>(style: FileDiffOptions<T>["diffStyle"]) {
  return {
    theme: "OpenCode",
    themeType: "system",
    disableLineNumbers: false,
    overflow: "wrap",
    diffStyle: style ?? "unified",
    diffIndicators: "bars",
    lineHoverHighlight: "both",
    disableBackground: false,
    expansionLineCount: 20,
    hunkSeparators: "line-info-basic",
    lineDiffType: style === "split" ? "word-alt" : "none",
    maxLineDiffLength: 1000,
    maxLineLengthForHighlighting: 1000,
    disableFileHeader: true,
    unsafeCSS,
  } as const
}

export const styleVariables = {
  "--diffs-font-family": "var(--v2-font-family-mono)",
  "--diffs-font-size": "var(--v2-font-size-small)",
  "--diffs-line-height": "24px",
  "--diffs-tab-size": 2,
  "--diffs-font-features": "normal",
  "--diffs-header-font-family": "var(--v2-font-family-sans)",
  "--diffs-gap-block": 0,
  "--diffs-min-number-column-width": "4ch",
}
