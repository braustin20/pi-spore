import { useViewportDebug } from "@pi-spore/ui";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Spike for card "Phone resume offset 2": live viewport numbers for one screenshot on iOS. Remove with that card.

const MAX_EVENTS = 8;

// Each line stays under about 40 characters: at 9px monospace that is all that fits in 60vw of a phone.

function round(n: number | undefined): string {
  return n === undefined ? "?" : String(Math.round(n * 10) / 10);
}

function clockTime(): string {
  const now = new Date();
  return `${now.toTimeString().slice(0, 8)}.${String(now.getMilliseconds()).padStart(3, "0")}`;
}

function rootTop(): string {
  return round(document.getElementById("root")?.getBoundingClientRect().top);
}

function eventLines(name: string): string {
  const vv = window.visualViewport;
  return `${name} ${clockTime()}\n  vv ${round(vv?.height)}/${round(vv?.offsetTop)} sY ${round(window.scrollY)} root ${rootTop()}`;
}

function numbers(): string {
  const vv = window.visualViewport;
  const html = document.documentElement;
  const root = document.getElementById("root");
  const rootRect = root?.getBoundingClientRect();
  const header = document.querySelector("#root header");
  const headerRect = header?.getBoundingClientRect();
  const scrolled = root
    ? [...root.querySelectorAll("*")]
        .filter((el) => el.scrollTop > 0)
        .map(
          (el) => `  ${el.tagName.toLowerCase()}.${el.classList[0] ?? ""}=${round(el.scrollTop)}`,
        )
    : [];
  return [
    vv ? `vv h ${round(vv.height)} scale ${round(vv.scale)}` : "vv: none",
    vv ? `vv offTop ${round(vv.offsetTop)} pageTop ${round(vv.pageTop)}` : "",
    `innerH ${window.innerHeight} clientH ${html.clientHeight}`,
    `screenH ${screen.height}`,
    `scrollY ${round(window.scrollY)} scrollEl ${round(document.scrollingElement?.scrollTop)}`,
    `body.scrollTop ${round(document.body.scrollTop)}`,
    root ? `#root top ${round(rootRect?.top)} h ${round(rootRect?.height)}` : "#root: none",
    root ? `#root scrollTop ${round(root.scrollTop)}` : "",
    header ? `header top ${round(headerRect?.top)} h ${round(headerRect?.height)}` : "header: none",
    header ? `header display ${getComputedStyle(header).display}` : "",
    `--app-top ${html.style.getPropertyValue("--app-top") || "-"}`,
    `--app-height ${html.style.getPropertyValue("--app-height") || "-"}`,
    `keyboard-open ${html.hasAttribute("data-keyboard-open") ? "yes" : "no"}`,
    `active: ${document.activeElement?.tagName.toLowerCase() ?? "none"}`,
    `scrolled:${scrolled.length > 0 ? `\n${scrolled.join("\n")}` : " none"}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function ViewportDebug() {
  const on = useViewportDebug();
  const events = useRef<string[]>([]);
  const [text, setText] = useState("");

  useEffect(() => {
    if (!on) return;
    const read = (name: string) => {
      events.current = [eventLines(name), ...events.current].slice(0, MAX_EVENTS);
      setText(
        `${numbers()}\nevents: vv h/offTop, scrollY, #root top\n${events.current.join("\n")}`,
      );
    };
    const onResize = () => read("vv.resize");
    const onScroll = () => read("vv.scroll");
    const onVisibility = () => read(`visibilitychange:${document.visibilityState}`);
    const onFocusIn = () => read("focusin");
    const onFocusOut = () => read("focusout");
    const onPageShow = () => read("pageshow");
    const vv = window.visualViewport;
    vv?.addEventListener("resize", onResize);
    vv?.addEventListener("scroll", onScroll);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    window.addEventListener("pageshow", onPageShow);
    read("mount");
    return () => {
      vv?.removeEventListener("resize", onResize);
      vv?.removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [on]);

  if (!on) return null;
  // Outside #root, so the overlay cannot move or resize the app it measures.
  return createPortal(
    <pre
      data-viewport-debug
      className="font-mono"
      style={{
        position: "fixed",
        top: "env(safe-area-inset-top)",
        right: 0,
        zIndex: 2147483647,
        pointerEvents: "none",
        margin: 0,
        padding: 4,
        fontSize: 9,
        lineHeight: 1.25,
        background: "rgba(0, 0, 0, 0.7)",
        color: "#f0f0f0",
        whiteSpace: "pre",
        maxWidth: "60vw",
        overflow: "hidden",
      }}
    >
      {text}
    </pre>,
    document.body,
  );
}
