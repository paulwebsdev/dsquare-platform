export type DatabaseRevocationFetcher = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function requestDatabaseResourceRevocation(
  resourceId: string,
  apiUrl: URL,
  clientId: string,
  clientSecret: string,
  fetcher: DatabaseRevocationFetcher = fetch,
): Promise<boolean> {
  if (!clientSecret) return false;

  const response = await fetcher(
    new URL("/api/v1/integrations/hosting/revoke", apiUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId, clientSecret, resourceId }),
      signal: AbortSignal.timeout(10000),
    },
  );

  const payload = await response.json().catch(() => null) as {
    success?: boolean;
  } | null;

  return response.ok && payload?.success === true;
}
