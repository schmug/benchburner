/**
 * Clean module surface for the inference adapter contract. Mirrors
 * SPEC §6. Keeps the rest of the codebase from reaching into
 * `../types.ts` directly for inference-only concerns.
 */

export type {
  InferenceAdapter,
  InferenceInvokeParams,
  InferenceResult,
  ModelConfig,
} from "../types";

/**
 * Error thrown by adapters on non-2xx responses, malformed payloads, or
 * transport failures. `cause` preserves the upstream error / response
 * body so callers can log it — adapters do not retry (SPEC §6 default),
 * so the error surfaces to the subagent worker which turns it into a
 * `Result` with `status: "error"`.
 */
export class AdapterError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "AdapterError";
    this.cause = cause;
  }
}
