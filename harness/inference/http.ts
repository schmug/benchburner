/**
 * Generic OpenAI-compatible HTTP adapter. Endpoint is the server root;
 * this adapter appends `/v1/chat/completions`. Works against vLLM,
 * Together, HF TGI, the OpenAI API proper, and anything else that
 * matches the schema.
 */

import type {
  InferenceAdapter,
  InferenceInvokeParams,
  InferenceResult,
} from "../types";
import { AdapterError } from "./adapter";

interface ChatChoice {
  message?: { content?: string };
  finish_reason?: string;
}

interface ChatResponse {
  choices?: ChatChoice[];
  usage?: { total_tokens?: number };
}

function mapFinishReason(
  raw: string | undefined,
): InferenceResult["finish_reason"] {
  switch (raw) {
    case "stop":
    case "end_turn":
    case "eos":
      return "stop";
    case "length":
    case "max_tokens":
      return "length";
    default:
      return "error";
  }
}

export class HTTPAdapter implements InferenceAdapter {
  readonly name = "http";
  private readonly endpoint: string;
  private readonly apiKey?: string;

  constructor(opts: {
    endpoint: string;
    apiKey?: string;
    /** Extra HTTP headers sent on every request. Used for OpenRouter's
     *  optional HTTP-Referer / X-Title (shows up in the dashboard) and
     *  can carry Anthropic's `anthropic-version` header on direct
     *  anthropic.com targets. */
    extraHeaders?: Record<string, string>;
  }) {
    this.endpoint = opts.endpoint.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    const defaults: Record<string, string> = {};
    if (this.endpoint.includes("openrouter.ai")) {
      // Auto-set OpenRouter's optional identification headers so runs
      // show up tagged on the dashboard. Neither is required; they
      // just make usage easier to audit.
      defaults["http-referer"] = "https://github.com/thebreakawayguy/benchburner";
      defaults["x-title"] = "Benchburner";
    }
    this.extraHeaders = { ...defaults, ...(opts.extraHeaders ?? {}) };
  }

  private readonly extraHeaders: Record<string, string>;

  async invoke(params: InferenceInvokeParams): Promise<InferenceResult> {
    const messages: Array<{ role: "system" | "user"; content: string }> = [];
    if (params.system !== undefined) {
      messages.push({ role: "system", content: params.system });
    }
    messages.push({ role: "user", content: params.prompt });

    const body: Record<string, unknown> = {
      model: params.model,
      messages,
      max_tokens: params.max_tokens,
      ...(params.stop && params.stop.length > 0 ? { stop: params.stop } : {}),
    };

    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...this.extraHeaders,
    };
    if (this.apiKey) {
      headers["authorization"] = `Bearer ${this.apiKey}`;
    }

    let res: Response;
    try {
      res = await fetch(`${this.endpoint}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: params.signal,
      });
    } catch (err) {
      throw new AdapterError(
        `HTTP inference request failed: ${(err as Error).message}`,
        err,
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "<unreadable body>");
      throw new AdapterError(
        `HTTP inference HTTP ${res.status}: ${text}`,
        { status: res.status, body: text },
      );
    }

    let data: ChatResponse;
    try {
      data = (await res.json()) as ChatResponse;
    } catch (err) {
      throw new AdapterError(
        `HTTP inference returned non-JSON response: ${(err as Error).message}`,
        err,
      );
    }

    const choice = data.choices?.[0];
    const text = choice?.message?.content ?? "";
    const tokens_used = data.usage?.total_tokens ?? 0;
    const finish_reason = mapFinishReason(choice?.finish_reason);

    return { text, tokens_used, finish_reason };
  }
}
