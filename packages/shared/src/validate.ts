import type { Static, TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

export class ValidationError extends Error {
  override name = "ValidationError";
}

/**
 * Parses a JSON request body and checks it. An empty body counts as `{}`, so requests whose fields are all optional
 * may send nothing. Broken JSON throws a ValidationError, which the server answers with a 400.
 */
export function parseJsonBody<const S extends TSchema>(
  schema: S,
  text: string,
  what: string,
): Static<S> {
  let value: unknown;
  try {
    value = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    throw new ValidationError(`Invalid ${what}: the body is not valid JSON`);
  }
  return parse(schema, value, what);
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
