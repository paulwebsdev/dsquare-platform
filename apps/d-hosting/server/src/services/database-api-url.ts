export function getDatabaseApiUrl(environment: NodeJS.ProcessEnv = process.env): URL {
  const value = environment.D_DATABASE_API_URL?.trim() || "http://127.0.0.1:5001";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("D_DATABASE_API_URL must be a valid URL.");
  }

  const isLoopbackHttp =
    parsed.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (environment.NODE_ENV === "production"
      ? parsed.protocol !== "https:"
      : parsed.protocol !== "https:" && !isLoopbackHttp)
  ) {
    throw new Error("D_DATABASE_API_URL must use HTTPS (HTTP loopback is allowed only in development).");
  }

  return parsed;
}
