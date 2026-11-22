import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

/** Each rule whose selector list is exactly `selector`, with its body and the at-rules around it, outermost first. */
function findRules(css: string, selector: string) {
  const found: { outer: string[]; body: string }[] = [];
  const outer: string[] = [];
  let start = 0;
  for (let at = 0; at < css.length; at++) {
    const char = css[at];
    if (char === "{") {
      const prelude = css.slice(start, at).trim().replace(/\s+/g, " ");
      if (prelude === selector)
        found.push({ outer: [...outer], body: css.slice(at + 1, css.indexOf("}", at)) });
      outer.push(prelude);
    } else if (char === "}") outer.pop();
    if (char === "{" || char === "}" || char === ";") start = at + 1;
  }
  return found;
}

it("gives phone fields 16px text over the Tailwind text utilities, so iOS does not zoom", () => {
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const rules = findRules(css, "input, select, textarea").filter((rule) =>
    rule.body.includes("font-size: 16px"),
  );
  // Inside any @layer, the rule would lose to `text-sm` and `text-[15px]` in the utilities layer (ADR 0159).
  expect(rules.map((rule) => rule.outer)).toEqual([["@media (width < 48rem)"]]);
});
