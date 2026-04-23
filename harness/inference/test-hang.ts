/**
 * Test-only adapter. Every `invoke()` hangs until aborted (never
 * resolves or rejects on its own). Used by VALIDATION.md PAS5 to
 * exercise the orchestrator's hang-detection path: if no cycle
 * completes within `hang_timeout_seconds`, the run should fail with
 * status="failed" and failure_reason containing "hang".
 *
 * Not a production adapter. Register only for validation runs.
 */

import type { InferenceAdapter, InferenceInvokeParams, InferenceResult } from "../types";

export class TestHangAdapter implements InferenceAdapter {
  readonly name = "test-hang";

  async invoke(params: InferenceInvokeParams): Promise<InferenceResult> {
    return new Promise<InferenceResult>((_resolve, reject) => {
      const abortHandler = () => {
        reject(new Error("test-hang: aborted"));
      };
      params.signal?.addEventListener("abort", abortHandler);
      // Never resolves on its own. Relies on the caller's timeout /
      // AbortController to unstick it.
    });
  }
}
