import type { CouncilConfig } from "./config.js";

/**
 * Проверка эндпоинта: GET {baseUrl}/models. Это единственный прямой вызов провайдера из
 * council-mcp; модели вызываются только агентами-участниками.
 */

export interface EndpointModel {
  id: string;
  /** Контекстное окно, если провайдер его сообщает (поля различаются у vLLM, OpenRouter и др.). */
  context?: number;
}

export type EndpointProbe =
  { ok: true; models: EndpointModel[]; missing: string[] } | { ok: false; error: string };

const CONTEXT_FIELDS = ["context_length", "max_model_len", "context_window", "max_context_length"];

export async function probeEndpoint(
  config: CouncilConfig,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<EndpointProbe> {
  const url = `${config.endpoint.baseUrl.replace(/\/+$/, "")}/models`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${config.endpoint.apiKey.reveal()}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, error: `эндпоинт недоступен: ${(e as Error).message}` };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: `ключ не принят (HTTP ${String(res.status)})` };
  }
  if (!res.ok) return { ok: false, error: `GET /models вернул HTTP ${String(res.status)}` };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: "GET /models вернул не JSON" };
  }
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return { ok: false, error: "GET /models: нет поля data[]" };

  const models: EndpointModel[] = data.flatMap((m: unknown) => {
    if (m === null || typeof m !== "object") return [];
    const record = m as Record<string, unknown>;
    if (typeof record.id !== "string") return [];
    const context = CONTEXT_FIELDS.map((f) => record[f]).find((v) => typeof v === "number");
    return [{ id: record.id, ...(typeof context === "number" && { context }) }];
  });
  const ids = new Set(models.map((m) => m.id));
  return { ok: true, models, missing: config.models.map((m) => m.id).filter((id) => !ids.has(id)) };
}
