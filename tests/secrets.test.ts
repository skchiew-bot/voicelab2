import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecrets, encryptSecrets, parseKey } from '../src/secrets.js';

const key = randomBytes(32);

describe('secrets', () => {
  it('round-trips and does not contain the plaintext', () => {
    const blob = encryptSecrets({ apiKey: 'sk-very-secret' }, key, 'provider-1');
    expect(blob.includes(Buffer.from('sk-very-secret'))).toBe(false);
    expect(decryptSecrets(blob, key, 'provider-1')).toEqual({ apiKey: 'sk-very-secret' });
  });

  it('refuses a blob moved to a different owner', () => {
    const blob = encryptSecrets({ apiKey: 'x' }, key, 'provider-1');
    expect(() => decryptSecrets(blob, key, 'provider-2')).toThrow();
  });

  it('refuses the wrong key or a tampered blob', () => {
    const blob = encryptSecrets({ apiKey: 'x' }, key, 'p');
    expect(() => decryptSecrets(blob, randomBytes(32), 'p')).toThrow();
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 1;
    expect(() => decryptSecrets(blob, key, 'p')).toThrow();
  });

  it('rejects a key of the wrong length', () => {
    expect(() => parseKey(Buffer.from('short').toString('base64'))).toThrow(/32 bytes/);
  });
});
