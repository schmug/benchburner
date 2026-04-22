/**
 * Ollama adapter. Talks to a local Ollama daemon's native
 * `/api/generate` endpoint (not the OpenAI-compatible shim; that's the
 * HTTPAdapter's job).
 *
 * Default endpoint in `config/models.yaml` is `http://localhost:11434`.
 */

import type {
  InferenceAdapter,
  InferenceInvokeParams,
  InferenceResult,
} from "../types";
import { AdapterError } from "./adapter";

interface OllamaGenerateResponse {
  response?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  done_reason?: string;
}

export class OllamaAdapter implements InferenceAdapter {
  readonly name = "ollama";
  private readonly endpoint: string;

  constructor(opts: { endpoint: string }) {
    // Trim a trailing slash so `${endpoint}/api/generate` is always
    // well-formed.
    this.endpoint = opts.endpoint.replace(/\/+$/, "");
  }

  async invoke(params: InferenceInvokeParams): Promise<InferenceResult> {
    const body: Record<string, unknown> = {
      model: params.model,
      prompt: params.prompt,
      stream: false,
      options: {
        num_predict: params.max_tokens,
        ...(params.stop && params.stop.length > 0
          ? { stop: params.stop }
          : {}),
      },
    };
    if (params.system !== undefined) {
      body.system = params.system;
    }

    let res: Response;
    try {
      res = await fetch(`${this.endpoint}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: params.signal,
      });
    } catch (err) {
      throw new AdapterError(
        `Ollama request failed: ${(err as Error).message}`,
        err,
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "<unreadable body>");
      throw new AdapterError(
        `Ollama HTTP ${res.status}: ${text}`,
        { status: res.status, body: text },
      );
    }

    let data: OllamaGenerateResponse;
    try {
      data = (await res.json()) as OllamaGenerateResponse;
    } catch (err) {
      throw new AdapterError(
        `Ollama returned non-JSON response: ${(err as Error).message}`,
        err,
      );
    }

    const finish_reason: InferenceResult["finish_reason"] =
      data.done_reason === "length"
        ? "length"
        : data.done_reason === "stop"
          ? "stop"
          : "error";

    return {
      text: data.response ?? "",
      tokens_used: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
      finish_reason,
    };
  }
}
