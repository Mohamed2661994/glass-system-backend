const crypto = require("crypto");
const path = require("path");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} = require("@aws-sdk/client-s3");

let cachedClient = null;
let cachedConfigSignature = "";

function readR2Config() {
  const accountId = String(process.env.R2_ACCOUNT_ID || "").trim();
  const explicitEndpoint = String(process.env.R2_ENDPOINT || "").trim();
  const endpoint =
    explicitEndpoint ||
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "");
  const accessKeyId = String(process.env.R2_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY || "").trim();
  const bucket = String(process.env.R2_BUCKET_NAME || "").trim();
  const prefix = String(process.env.R2_KEY_PREFIX || "purchase-invoices")
    .trim()
    .replace(/^\/+|\/+$/g, "");

  return {
    accountId,
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucket,
    prefix: prefix || "purchase-invoices",
  };
}

function isR2Configured() {
  const cfg = readR2Config();
  return Boolean(cfg.endpoint && cfg.accessKeyId && cfg.secretAccessKey && cfg.bucket);
}

function createR2NotConfiguredError() {
  const err = new Error(
    "خدمة التخزين السحابي (Cloudflare R2) غير مُعدّة بعد — يرجى إضافة مفاتيح R2 في إعدادات السيرفر",
  );
  err.statusCode = 503;
  return err;
}

function getR2Client() {
  const cfg = readR2Config();
  if (!cfg.endpoint || !cfg.accessKeyId || !cfg.secretAccessKey || !cfg.bucket) {
    throw createR2NotConfiguredError();
  }

  const signature = `${cfg.endpoint}|${cfg.accessKeyId}|${cfg.secretAccessKey}|${cfg.bucket}`;
  if (!cachedClient || cachedConfigSignature !== signature) {
    cachedClient = new S3Client({
      region: "auto",
      endpoint: cfg.endpoint,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
    cachedConfigSignature = signature;
  }

  return { client: cachedClient, bucket: cfg.bucket, prefix: cfg.prefix };
}

/**
 * Inspect actual binary magic bytes — never trust client filename/Content-Type.
 * Supports only JPEG, PNG, and WebP. Rejects SVG, HTML, PDF, scripts, etc.
 */
function detectRealImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 32) {
    return null;
  }

  // Reject HTML / XML / SVG signatures anywhere in the leading bytes
  const headText = buffer.subarray(0, 64).toString("utf8").trimStart().toLowerCase();
  if (
    headText.startsWith("<svg") ||
    headText.startsWith("<?xml") ||
    headText.startsWith("<html") ||
    headText.startsWith("<!doctype") ||
    headText.startsWith("%pdf-")
  ) {
    return null;
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: "image/jpeg", ext: "jpg" };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { mimeType: "image/png", ext: "png" };
  }

  // WebP: RIFF....WEBP
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { mimeType: "image/webp", ext: "webp" };
  }

  return null;
}

function sanitizeOriginalFilename(filename) {
  const base = path
    .basename(String(filename || "invoice.webp"))
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, "_")
    .trim();
  return (base || "invoice.webp").slice(0, 180);
}

function buildPurchaseAttachmentKey(invoiceId, ext, date = new Date()) {
  const cfg = readR2Config();
  const safeId = Number(invoiceId);
  const safeExt = String(ext || "webp")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const uuid = crypto.randomUUID();
  return `${cfg.prefix}/${year}/${month}/inv_${safeId}_${uuid}.${safeExt || "webp"}`;
}

function computeSha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function verifyR2BucketConnection() {
  const { client, bucket } = getR2Client();
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
  return { ok: true, bucket };
}

async function uploadAttachmentToR2({ objectKey, buffer, contentType, metadata = {} }) {
  const { client, bucket } = getR2Client();
  const safeMetadata = {};
  for (const [k, v] of Object.entries(metadata || {})) {
    if (v !== undefined && v !== null) {
      safeMetadata[String(k).toLowerCase().replace(/[^a-z0-9_-]/g, "_")] =
        String(v).slice(0, 256);
    }
  }

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: buffer,
      ContentType: contentType,
      ContentLength: buffer.length,
      Metadata: safeMetadata,
    }),
  );

  return { bucket, objectKey };
}

async function getAttachmentFromR2(objectKey) {
  const { client, bucket } = getR2Client();
  const out = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: objectKey,
    }),
  );
  return out;
}

async function deleteAttachmentFromR2(objectKey) {
  if (!objectKey) return;
  const { client, bucket } = getR2Client();
  await client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: objectKey,
    }),
  );
}

async function deleteAttachmentsFromR2BestEffort(objectKeys) {
  if (!Array.isArray(objectKeys) || objectKeys.length === 0) return;
  if (!isR2Configured()) return;
  await Promise.allSettled(
    objectKeys.filter(Boolean).map((k) => deleteAttachmentFromR2(k)),
  );
}

module.exports = {
  isR2Configured,
  readR2Config,
  detectRealImageType,
  sanitizeOriginalFilename,
  buildPurchaseAttachmentKey,
  computeSha256,
  verifyR2BucketConnection,
  uploadAttachmentToR2,
  getAttachmentFromR2,
  deleteAttachmentFromR2,
  deleteAttachmentsFromR2BestEffort,
};

