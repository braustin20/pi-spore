import { common, createLowlight } from "lowlight";

const lowlight = createLowlight(common);

type Tree = ReturnType<typeof lowlight.highlight>;
type Node = Tree["children"][number];

/** A run of text in one color. `className` is a Tailwind class, or empty for plain text. */
export interface Token {
  text: string;
  className: string;
}

/**
 * Highlight.js scopes to role-token colors (docs/design.md), so code follows the theme menu. Every token here passes
 * the theme contrast test as text.
 */
const COLORS: Record<string, string> = {
  keyword: "text-accent-strong",
  "selector-tag": "text-accent-strong",
  doctag: "text-accent-strong",
  string: "text-ok",
  regexp: "text-ok",
  char: "text-ok",
  "template-string": "text-ok",
  number: "text-warn",
  literal: "text-warn",
  symbol: "text-warn",
  bullet: "text-warn",
  type: "text-warn",
  built_in: "text-warn",
  title: "text-run",
  section: "text-run",
  name: "text-run",
  "selector-class": "text-run",
  "selector-id": "text-run",
  attr: "text-fail",
  attribute: "text-fail",
  property: "text-fail",
  variable: "text-fail",
  "template-variable": "text-fail",
  params: "text-fg",
  comment: "text-muted italic",
  quote: "text-muted italic",
  meta: "text-muted",
  deletion: "text-diff-del",
  addition: "text-diff-add",
};

/** File extensions to highlight.js languages in lowlight's common set. Unity asset files are YAML. */
const LANGUAGES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  csproj: "xml",
  uxml: "xml",
  uss: "css",
  md: "markdown",
  py: "python",
  cs: "csharp",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  shader: "cpp",
  hlsl: "cpp",
  glsl: "cpp",
  cginc: "cpp",
  compute: "cpp",
  go: "go",
  rs: "rust",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  unity: "yaml",
  prefab: "yaml",
  asset: "yaml",
  meta: "yaml",
  mat: "yaml",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  sql: "sql",
  lua: "lua",
  php: "php",
};

/** The language of a path, or undefined for plain text. */
export function languageOf(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name === "Makefile") return "makefile";
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? undefined : LANGUAGES[name.slice(dot + 1).toLowerCase()];
}

function colorOf(classNames: unknown): string {
  if (!Array.isArray(classNames)) return "";
  for (const name of classNames) {
    const scope =
      String(name)
        .replace(/^hljs-/, "")
        .split(".")[0] ?? "";
    const color = COLORS[scope];
    if (color) return color;
  }
  return "";
}

/**
 * Colors `lines` as one block, so a comment or string over several lines keeps its color, and splits the result back
 * into one token list per line. Without a language every line is one plain token.
 */
export function highlightLines(lines: readonly string[], language: string | undefined): Token[][] {
  if (!language || lines.length === 0) {
    return lines.map((text) => [{ text, className: "" }]);
  }
  const result: Token[][] = [[]];
  const walk = (nodes: readonly Node[], inherited: string) => {
    for (const node of nodes) {
      if (node.type === "text") {
        const parts = node.value.split("\n");
        parts.forEach((part, index) => {
          if (index > 0) result.push([]);
          if (part !== "") result.at(-1)?.push({ text: part, className: inherited });
        });
      } else if (node.type === "element") {
        walk(node.children, colorOf(node.properties.className) || inherited);
      }
    }
  };
  walk(lowlight.highlight(language, lines.join("\n")).children, "");
  // A line with nothing on it still needs its slot.
  while (result.length < lines.length) result.push([]);
  return result;
}
