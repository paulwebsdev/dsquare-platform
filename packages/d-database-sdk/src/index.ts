export type DDatabaseClientOptions = {
  baseUrl: string;
  apiKey: string;
  projectId: string;
  resourceId: string;
};

export type DDatabasePage<T = Record<string, unknown>> = {
  success: true;
  table: string;
  limit: number;
  offset: number;
  total: string;
  rows: T[];
};

export type DDatabaseClient = {
  listTables(): Promise<string[]>;
  select<T = Record<string, unknown>>(
    table: string,
    options?: { limit?: number; offset?: number },
  ): Promise<DDatabasePage<T>>;
  insert<T = Record<string, unknown>>(
    table: string,
    values: Record<string, unknown>,
  ): Promise<T>;
};

type ApiResponse<T> = T & { success?: boolean; message?: string };

export function createDDatabaseClient(options: DDatabaseClientOptions): DDatabaseClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  if (!/^https:\/\//i.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(baseUrl)) {
    throw new Error("D Database baseUrl must use HTTPS (HTTP is allowed only for localhost development).");
  }
  if (!options.apiKey.startsWith("dsq_live_")) throw new Error("A D Database API key is required.");

  const endpoint = `${baseUrl}/api/v1/data/${encodeURIComponent(options.projectId)}/${encodeURIComponent(options.resourceId)}`;

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${endpoint}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        Authorization: `Bearer ${options.apiKey}`,
        ...init?.headers,
      },
    });
    const payload = await response.json() as ApiResponse<T>;
    if (!response.ok || payload.success === false) {
      throw new Error(payload.message || `D Database request failed with status ${response.status}.`);
    }
    return payload;
  }

  return {
    async listTables() {
      const result = await request<{ tables: string[] }>("/tables");
      return result.tables;
    },
    select<T = Record<string, unknown>>(table: string, query: { limit?: number; offset?: number } = {}) {
      const params = new URLSearchParams();
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      if (query.offset !== undefined) params.set("offset", String(query.offset));
      const suffix = params.size ? `?${params.toString()}` : "";
      return request<DDatabasePage<T>>(`/tables/${encodeURIComponent(table)}/rows${suffix}`);
    },
    async insert<T = Record<string, unknown>>(table: string, values: Record<string, unknown>) {
      const result = await request<{ row: T }>(`/tables/${encodeURIComponent(table)}/rows`, {
        method: "POST",
        body: JSON.stringify({ values }),
      });
      return result.row;
    },
  };
}
