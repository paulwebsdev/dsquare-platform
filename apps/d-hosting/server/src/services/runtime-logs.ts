import type { RuntimeLogEntry } from "./runtime-provider.js";

const MAX_LOG_LINES = 500;
const MAX_MESSAGE_LENGTH = 4000;
const SECRET_PATTERNS = [
  /(\b[A-Z0-9_]*(?:PASSWORD|PASSWD|TOKEN|SECRETS?|API[_-]?KEY|DATABASE_URL|PRIVATE_KEY)[A-Z0-9_]*\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
  /(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi,
  /(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s]+(@)/gi,
];

export function redactRuntimeLogMessage(message: string): string {
  let safe = message.slice(0, MAX_MESSAGE_LENGTH);
  for (const pattern of SECRET_PATTERNS) {
    safe = safe.replace(pattern, (_match, prefix: string, suffix?: string) =>
      suffix === undefined ? \`${prefix}[REDACTED]\` : \`${prefix}[REDACTED]${suffix}\`,
    );
  }
  return safe;
}

/** Applies strict response bounds and redacts common credential formats. */
export function sanitizeRuntimeLogs(
  entries: RuntimeLogEntry[],
  requestedLimit = 100,
): RuntimeLogEntry[] {
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(MAX_LOG_LINES, Math.max(1, Math.floor(requestedLimit)))
    : 100;

  return entries.slice(-limit).map((entry) => ({
    timestamp: entry.timestamp,
    stream: entry.stream,
    message: redactRuntimeLogMessage(entry.message),
  }));
}
