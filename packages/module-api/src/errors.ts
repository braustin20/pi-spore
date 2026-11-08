/**
 * An error a server module throws to answer a request with a specific status. The server turns it into
 * `{ "error": { "code", "message" } }`. Any other thrown error becomes a 500.
 */
export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 500 | 502 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** What the web API client throws for a non-2xx answer. */
export class ApiRequestError extends Error {
  override name = "ApiRequestError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
