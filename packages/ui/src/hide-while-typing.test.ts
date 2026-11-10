import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

/** The block of the first rule whose selector holds `marker`, and the at-rules around it, outermost first. */
function findRule(css: string, marker: string) {
  const outer: string[] = [];
  let start = 0;
  for (let at = 0; at < css.length; at++) {
    const char = css[at];
    if (char === "{") {
      const prelude = css.slice(start, at).trim();
      if (prelude.includes(marker)) return { outer, body: css.slice(at + 1, css.indexOf("}", at)) };
      outer.push(prelude);
    } else if (char === "}") outer.pop();
    if (char === "{" || char === "}" || char === ";") start = at + 1;
  }
  throw new Error(`no rule names ${marker}`);
}

it("hides the marked rows on phones, over the Tailwind display utilities", () => {
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const rule = findRule(css, "[data-hide-while-typing]");
  // Inside any @layer, the rule would lose to `.flex` in the utilities layer, so it must be unlayered.
  expect(rule.outer).toEqual(["@media (width < 48rem)"]);
  expect(rule.body).toContain("display: none");
});
