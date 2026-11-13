import "dotenv/config";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "node:crypto";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required setting: ${name}`);
  return value;
}

async function main() {
  const bucket = required("HOSTING_OBJECT_STORAGE_BUCKET");
  const region = required("HOSTING_OBJECT_STORAGE_REGION");
  const accessKeyId = required("HOSTING_OBJECT_STORAGE_ACCESS_KEY_ID");
  const secretAccessKey = required("HOSTING_OBJECT_STORAGE_SECRET_ACCESS_KEY");
  const endpoint = process.env.HOSTING_OBJECT_STORAGE_ENDPOINT?.trim();
  if (endpoint) {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("Provider endpoint must be a clean HTTPS URL.");
    }
  }

  const ownerId = randomUUID();
  const projectId = randomUUID();
  const websiteId = randomUUID();
  const objectId = randomUUID();
  const key = `owners/${ownerId}/projects/${projectId}/websites/${websiteId}/${objectId}`;
  const body = Buffer.from(`DSquare object-storage acceptance ${randomUUID()}\n`);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const client = new S3Client({
    region,
    endpoint: endpoint || undefined,
    forcePathStyle: Boolean(endpoint),
    credentials: { accessKeyId, secretAccessKey },
  });

  let uploaded = false;
  try {
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentLength: body.byteLength,
      ContentType: "text/plain",
      Metadata: { owner: ownerId, project: projectId, website: websiteId, sha256, acceptance: "true" },
      ServerSideEncryption: "AES256",
    }));
    uploaded = true;

    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    if (Number(head.ContentLength) !== body.byteLength ||
        head.Metadata?.sha256 !== sha256 ||
        head.ServerSideEncryption !== "AES256") {
      throw new Error("Provider did not confirm object size, checksum metadata, and AES256 server-side encryption.");
    }

    const downloaded = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!downloaded.Body) throw new Error("Provider returned an empty object body.");
    const actual = Buffer.from(await downloaded.Body.transformToByteArray());
    if (actual.byteLength !== body.byteLength ||
        createHash("sha256").update(actual).digest("hex") !== sha256) {
      throw new Error("Downloaded object did not match the uploaded bytes.");
    }

    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    uploaded = false;
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      throw new Error("Provider still returns the object after deletion.");
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      const name = (error as { name?: string }).name;
      if (status !== 404 && name !== "NotFound" && name !== "NoSuchKey") throw error;
    }

    console.log("Object-storage provider acceptance passed: scoped upload, AES256 confirmation, checksum-verified download, and delete.");
  } finally {
    if (uploaded) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => undefined);
    }
    client.destroy();
  }
}

main().catch(() => {
  console.error("Object-storage provider acceptance failed. Check provider compatibility, bucket permissions, and encryption configuration; credentials were not printed.");
  process.exitCode = 1;
});
