'use strict';
/**
 * Pluggable file storage for attachments.
 *
 * Default driver is `local` (filesystem under data/uploads, preserving the
 * previous behaviour). Set STORAGE_DRIVER=s3 (or any S3-compatible service:
 * AWS S3, Cloudflare R2, MinIO, ...) plus the S3_* env vars to move bytes
 * off the application server. The database keeps metadata only in both cases.
 *
 * The interface is intentionally small so routes never touch the filesystem
 * or the SDK directly:
 *   save(clinicId, storedName, buffer) -> Promise<void>
 *   readStream(clinicId, storedName)    -> Readable stream
 *   exists(clinicId, storedName)        -> boolean (sync-ish; S3 uses HEAD)
 *   remove(clinicId, storedName)        -> Promise<void> (best-effort)
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');

const DRIVER = (process.env.STORAGE_DRIVER || 'local').toLowerCase();

function localBase() {
  return path.join(path.dirname(path.resolve(config.sqlitePath)), 'uploads');
}
function localDir(clinicId) {
  const dir = path.join(localBase(), `clinic_${Number(clinicId)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function localPath(clinicId, storedName) {
  return path.join(localDir(clinicId), storedName);
}

let s3Client = null;
function getS3() {
  if (s3Client) return s3Client;
  const { S3Client } = require('@aws-sdk/client-s3');
  const region = process.env.S3_REGION || 'us-east-1';
  const endpoint = process.env.S3_ENDPOINT || undefined;
  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === 'true';
  const credentials = (process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY)
    ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY }
    : undefined;
  s3Client = new S3Client({ region, endpoint, forcePathStyle, credentials });
  return s3Client;
}
function s3Key(clinicId, storedName) {
  return `clinic_${Number(clinicId)}/${storedName}`;
}
function s3Bucket() {
  const b = process.env.S3_BUCKET;
  if (!b) throw new Error('S3_BUCKET must be set when STORAGE_DRIVER=s3');
  return b;
}

async function save(clinicId, storedName, buf) {
  if (DRIVER === 's3') {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await getS3().send(new PutObjectCommand({
      Bucket: s3Bucket(), Key: s3Key(clinicId, storedName),
      Body: buf, ContentType: undefined,
    }));
    return;
  }
  fs.writeFileSync(localPath(clinicId, storedName), buf);
}

function readStream(clinicId, storedName) {
  if (DRIVER === 's3') {
    // Returns a promise resolving to a Readable stream; callers await it.
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    return (async () => {
      const out = await getS3().send(new GetObjectCommand({
        Bucket: s3Bucket(), Key: s3Key(clinicId, storedName),
      }));
      return out.Body; // Readable in Node
    })();
  }
  return fs.createReadStream(localPath(clinicId, storedName));
}

async function exists(clinicId, storedName) {
  if (DRIVER === 's3') {
    try {
      const { HeadObjectCommand } = require('@aws-sdk/client-s3');
      await getS3().send(new HeadObjectCommand({ Bucket: s3Bucket(), Key: s3Key(clinicId, storedName) }));
      return true;
    } catch {
      return false;
    }
  }
  return fs.existsSync(localPath(clinicId, storedName));
}

async function remove(clinicId, storedName) {
  if (DRIVER === 's3') {
    try {
      const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
      await getS3().send(new DeleteObjectCommand({ Bucket: s3Bucket(), Key: s3Key(clinicId, storedName) }));
    } catch { /* best-effort */ }
    return;
  }
  try { fs.unlinkSync(localPath(clinicId, storedName)); } catch { /* ignore */ }
}

module.exports = { DRIVER, save, readStream, exists, remove, localDir, localPath };
