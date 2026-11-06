export { HealthResponse } from "./health.js";
export { parse, ValidationError } from "./validate.js";

/** Default address of the local server (R1.2: loopback only). */
export const DEFAULT_PORT = 7420;
export const DEFAULT_URL = `http://127.0.0.1:${DEFAULT_PORT}`;
