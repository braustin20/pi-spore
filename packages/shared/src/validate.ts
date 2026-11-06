import type { Static, TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

export class ValidationError extends Error {
  override name = "ValidationError";
}

/** Checks a value from outside the process (HTTP, files, child output) and throws a readable error if it is wrong. */
export function parse<const S extends TSchema>(schema: S, value: unknown, what: string): Static<S> {
  if (Check(schema, value)) return value;
  const details = Errors(schema, value)
    .slice(0, 5)
    .map((error) => `${error.instancePath || "/"}: ${error.message}`)
    .join("; ");
  throw new ValidationError(`Invalid ${what}: ${details}`);
}
