import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../cn.js";

// No rehype-raw: react-markdown skips raw HTML, so agent text cannot inject markup.
// The default URL transform stays on, so javascript: URLs are dropped.
const COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  // A Markdown image would make the browser fetch its URL as soon as the page shows it.
  // Show a plain link instead, so nothing loads on open (ADR 0061).
  img: ({ src, alt }) => {
    const url = typeof src === "string" ? src : "";
    return (
      <a href={url} target="_blank" rel="noreferrer">
        {alt || url || "image"}
      </a>
    );
  },
};

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("md", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
