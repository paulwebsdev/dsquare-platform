export type WebsiteFileQuotaQueryable = {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
};

export type WebsiteFileQuotaResult = {
  usedBytes: number;
  quotaBytes: number;
  remainingBytes: number;
};

/**
 * Must be called inside a transaction after the owning website row has been
 * locked FOR UPDATE. This serializes concurrent uploads for the same site.
 */
export async function checkWebsiteFileQuota(input: {
  queryable: WebsiteFileQuotaQueryable;
  projectId: string;
  resourceId: string;
  uploadBytes: number;
}): Promise<WebsiteFileQuotaResult> {
  if (!Number.isSafeInteger(input.uploadBytes) || input.uploadBytes < 1) {
    throw new Error("Upload size must be a positive safe integer.");
  }
  const website = await input.queryable.query(
    `SELECT file_storage_quota_bytes
     FROM hosting_resources
     WHERE id = $1 AND project_id = $2
     FOR UPDATE`,
    [input.resourceId, input.projectId],
  );
  if (website.rowCount !== 1) throw new Error("Website resource not found.");
  const quotaBytes = Number(website.rows[0].file_storage_quota_bytes);
  if (!Number.isSafeInteger(quotaBytes) || quotaBytes < 1) {
    throw new Error("Website storage quota configuration is invalid.");
  }
  const usage = await input.queryable.query(
    `SELECT COALESCE(SUM(size_bytes), 0)::bigint AS used_bytes
     FROM hosting_files
     WHERE project_id = $1 AND resource_id = $2`,
    [input.projectId, input.resourceId],
  );
  const usedBytes = Number(usage.rows[0]?.used_bytes ?? 0);
  if (!Number.isSafeInteger(usedBytes) || usedBytes < 0) {
    throw new Error("Website storage usage is invalid.");
  }
  if (input.uploadBytes > quotaBytes - usedBytes) {
    const error = new Error("This upload would exceed the website's storage quota.");
    Object.assign(error, { code: "HOSTING_STORAGE_QUOTA_EXCEEDED" });
    throw error;
  }
  return { usedBytes, quotaBytes, remainingBytes: quotaBytes - usedBytes };
}
