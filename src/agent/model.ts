import type { HollowConfig } from "../config/schema.js";

/**
 * The model, whichever one the developer configured. Two small adapters behind one interface:
 * the OpenAI-compatible Chat Completions API (most hosted providers, plus local servers such as
 * Ollama, vLLM or LM Studio) and Anthropic's Messages API. There is no default model.
 */
export interface ModelRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
}

export interface ModelReply {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ModelClient {
  /** For messages: provider, model and endpoint host, never the key. */
  label: string;
  complete(request: ModelRequest): Promise<ModelReply>;
}

export class ModelError extends Error {}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const ANTHROPIC_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";
const TIMEOUT_MS = 180_000;

/** A rough token count for text a provider did not count for us. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export type ClientResult =
  | { status: "ok"; client: ModelClient }
  | { status: "off"; reason: string };

/** Build the configured client, or say why there is none. Never reads the key into a message. */
export function modelClient(
  agent: HollowConfig["agent"],
  env: NodeJS.ProcessEnv,
  fetcher: Fetch,
  noAi: boolean,
): ClientResult {
  if (noAi || !agent.ai)
    return { status: "off", reason: "AI is turned off (--no-ai or agent.ai: false)." };
  if (agent.provider === undefined || agent.model === undefined) {
    return {
      status: "off",
      reason:
        "No model is configured. Set agent.provider, agent.model and agent.baseUrl in hollow.yml, and put your API key in the HOLLOW_AI_API_KEY environment variable, to let The Hollow repair the pipeline.",
    };
  }
  const base = (agent.baseUrl ?? ANTHROPIC_URL).replace(/\/+$/, "");
  const host = new URL(base).hostname;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(host);
  const key = env[agent.apiKeyEnv]?.trim() ?? "";
  if (key === "" && !local) {
    return {
      status: "off",
      reason: `The ${agent.apiKeyEnv} environment variable is empty, so there is no API key for ${host}. Set it in your shell (never in hollow.yml).`,
    };
  }
  const label = `${agent.model} (${agent.provider}, ${host})`;
  const model = agent.model;
  if (agent.provider === "anthropic") {
    return {
      status: "ok",
      client: {
        label,
        complete: async (request) => {
          const data = await post(fetcher, `${base}/messages`, {
            headers: {
              ...(key === "" ? {} : { "x-api-key": key }),
              "anthropic-version": ANTHROPIC_VERSION,
            },
            body: {
              model,
              system: request.system,
              messages: [{ role: "user", content: request.user }],
              max_tokens: request.maxOutputTokens,
              temperature: 0,
            },
          });
          const content = Array.isArray(data.content) ? data.content : [];
          const text = content
            .map((part: unknown) =>
              typeof part === "object" &&
              part !== null &&
              (part as { type?: unknown }).type === "text"
                ? String((part as { text?: unknown }).text ?? "")
                : "",
            )
            .join("");
          const usage = (data.usage ?? {}) as Record<string, unknown>;
          return reply(text, request, usage.input_tokens, usage.output_tokens);
        },
      },
    };
  }
  return {
    status: "ok",
    client: {
      label,
      complete: async (request) => {
        const data = await post(fetcher, `${base}/chat/completions`, {
          headers: key === "" ? {} : { authorization: `Bearer ${key}` },
          body: {
            model,
            messages: [
              { role: "system", content: request.system },
              { role: "user", content: request.user },
            ],
            max_tokens: request.maxOutputTokens,
            temperature: 0,
          },
        });
        const choices = Array.isArray(data.choices) ? data.choices : [];
        const message = (choices[0] as { message?: { content?: unknown } } | undefined)?.message;
        const usage = (data.usage ?? {}) as Record<string, unknown>;
        return reply(
          typeof message?.content === "string" ? message.content : "",
          request,
          usage.prompt_tokens,
          usage.completion_tokens,
        );
      },
    },
  };
}

/** Use the provider's own counts; estimate when it gives none (some local servers do not). */
function reply(text: string, request: ModelRequest, input: unknown, output: unknown): ModelReply {
  return {
    text,
    inputTokens: typeof input === "number" ? input : estimateTokens(request.system + request.user),
    outputTokens: typeof output === "number" ? output : estimateTokens(text),
  };
}

async function post(
  fetcher: Fetch,
  url: string,
  options: { headers: Record<string, string>; body: unknown },
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...options.headers },
      body: JSON.stringify(options.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new ModelError(`Could not reach ${new URL(url).host}: ${(error as Error).message}`);
  }
  const text = await response.text();
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (!response.ok) {
    const detail =
      typeof data === "object" && data !== null && "error" in data
        ? JSON.stringify((data as { error: unknown }).error).slice(0, 300)
        : text.slice(0, 300);
    throw new ModelError(`${new URL(url).host} answered ${response.status}: ${detail}`);
  }
  if (typeof data !== "object" || data === null) {
    throw new ModelError(`${new URL(url).host} did not answer with JSON.`);
  }
  return data as Record<string, unknown>;
}
