import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 1;

export function parseKey(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) {
    throw new Error('VOICELAB_SECRET_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32).');
  }
  return key;
}

/**
 * AES-256-GCM. Layout: version(1) | iv(12) | tag(16) | ciphertext.
 * aad binds the blob to its owner (the provider id) so it cannot be swapped between rows.
 */
export function encryptSecrets(values: Record<string, string>, key: Buffer, aad: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(JSON.stringify(values), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

export function decryptSecrets(blob: Buffer, key: Buffer, aad: string): Record<string, string> {
  if (blob[0] !== VERSION) throw new Error('Unknown secret format version.');
  const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(1, 13));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(blob.subarray(13, 29));
  const plain = Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}
