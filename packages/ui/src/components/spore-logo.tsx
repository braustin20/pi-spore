import type { CSSProperties } from "react";
import { cn } from "../cn.js";
import { useReducedMotion } from "../reduced-motion.js";

// From the designer's sporelogo.svg. The matrices are kept as drawn, nested groups as a transform list (outer
// first), so the shapes stay true to the source and each one can be animated on its own.
const ROOT_STYLE =
  "fill-rule:evenodd;clip-rule:evenodd;stroke-linecap:round;stroke-linejoin:round;stroke-miterlimit:1.5";
const OUTER = "matrix(1.13285,0,0,1.13285,-1315.33,-269.509) matrix(1,0,0,1,-177.652,160.295)";
const ARM_D = "M1418.84,1267.26L1686.2,1005.95";
const ARM_STROKE = 101.52;
const CIRCLE = { cx: 1836.2, cy: 1065.04, r: 283.347 };
const ARMS = "matrix(0.746585,0,0,0.746585,462.669,-75.957)";

/**
 * `origin` is the circle's center in viewBox units, where it squashes or pops while working. `spore` is a spore's
 * place in the pop stagger; the core has none.
 */
type Shape =
  | { kind: "arm"; transform: string }
  | { kind: "circle"; transform: string; stroke: number; origin: string; spore?: number };

const SHAPES: readonly Shape[] = [
  { kind: "arm", transform: ARMS },
  { kind: "arm", transform: `${ARMS} matrix(1,0,0,1,476.192,-476.854)` },
  {
    kind: "arm",
    transform: `${ARMS} matrix(-0.298347,0.954458,-0.954458,-0.298347,3503.93,57.3769)`,
  },
  { kind: "arm", transform: `${ARMS} matrix(0.592718,0.80541,-0.80541,0.592718,2125.53,-931.631)` },
  {
    kind: "circle",
    transform: "matrix(0.797378,0,0,0.797378,330.325,-264.094)",
    stroke: 1.11,
    origin: "516px 575px",
  },
  { kind: "arm", transform: "matrix(-0.16227,0.728737,-0.728737,-0.16227,2752.7,-543.313)" },
  {
    kind: "circle",
    transform: "matrix(0.458721,0.0510288,-0.0510288,0.458721,763.081,-364.023)",
    stroke: 1.91,
    origin: "241px 159px",
    spore: 0,
  },
  {
    kind: "circle",
    transform: "matrix(0.409901,0,0,0.409901,736.28,457.648)",
    stroke: 2.15,
    origin: "170px 925px",
    spore: 4,
  },
  {
    kind: "circle",
    transform: "matrix(0.350242,0,0,0.350242,1455.27,-82.0893)",
    stroke: 2.52,
    origin: "861px 242px",
    spore: 1,
  },
  {
    kind: "circle",
    transform: "matrix(0.261126,0,0,0.261126,1722.35,409.988)",
    stroke: 3.38,
    origin: "978px 692px",
    spore: 2,
  },
  {
    kind: "circle",
    transform: "matrix(0.261126,0,0,0.261126,1515.79,669.074)",
    stroke: 3.38,
    origin: "744px 985px",
    spore: 3,
  },
];

/**
 * The pi-spore logo, drawn in the text color. `working` turns it and pops its spores (the `spore-logo-*` rules in
 * styles.css), unless the user asks for reduced motion. Each circle sits in its own group, so the CSS scale goes on
 * the group and the circle keeps its matrix. The groups work in viewBox units, so `OUTER` moves into each shape.
 */
export function SporeLogo({ className, working }: { className?: string; working?: boolean }) {
  const reducedMotion = useReducedMotion();
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 1080 1080"
      className={cn("shrink-0", working && !reducedMotion && "spore-logo-working", className)}
      style={{
        fillRule: "evenodd",
        clipRule: "evenodd",
        strokeLinecap: "round",
        strokeLinejoin: "round",
        strokeMiterlimit: 1.5,
      }}
    >
      <g className="spore-logo-all">
        {SHAPES.map((shape) =>
          shape.kind === "arm" ? (
            <path
              key={shape.transform}
              transform={`${OUTER} ${shape.transform}`}
              d={ARM_D}
              fill="none"
              stroke="currentColor"
              strokeWidth={ARM_STROKE}
            />
          ) : (
            <g
              key={shape.transform}
              className={shape.spore === undefined ? "spore-logo-core" : "spore-logo-spore"}
              style={{ transformOrigin: shape.origin, "--i": shape.spore } as CSSProperties}
            >
              <circle
                transform={`${OUTER} ${shape.transform}`}
                {...CIRCLE}
                fill="currentColor"
                stroke="currentColor"
                strokeWidth={shape.stroke}
              />
            </g>
          ),
        )}
      </g>
    </svg>
  );
}

/** The logo as a standalone SVG file in `color`, for places outside React such as the favicon. */
export function sporeLogoSvg(color: string): string {
  const shapes = SHAPES.map((shape) =>
    shape.kind === "arm"
      ? `<path transform="${shape.transform}" d="${ARM_D}" fill="none" stroke="currentColor" stroke-width="${ARM_STROKE}"/>`
      : `<circle transform="${shape.transform}" cx="${CIRCLE.cx}" cy="${CIRCLE.cy}" r="${CIRCLE.r}" fill="currentColor" stroke="currentColor" stroke-width="${shape.stroke}"/>`,
  ).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080" color="${color}" style="${ROOT_STYLE}"><g transform="${OUTER}">${shapes}</g></svg>`;
}
