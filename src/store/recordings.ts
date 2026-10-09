import { createHash } from 'node:crypto';
import type pg from 'pg';
import { AppError } from '../errors.js';
import { framesOf, normalizeSpoken, textHash, type RecordingIndex } from '../workflows/stitch.js';
import type { WorkflowDefinition } from '../workflows/definition.js';
import { audit } from './audit.js';

export const CONTENT_TYPES = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/basic'] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];
export const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

/** A file that is not what it says it is (a script, an image) is refused by its first bytes. */
function looksLike(type: ContentType, b: Buffer): boolean {
  switch (type) {
    case 'audio/wav': return b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE';
    case 'audio/ogg': return b.length > 4 && b.toString('latin1', 0, 4) === 'OggS';
    case 'audio/basic': return b.length > 4 && b.toString('latin1', 0, 4) === '.snd';
    case 'audio/mpeg': return b.length > 3 && (b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0));
  }
}

/** Save a recording of exact words. A new take of the same words is a new version; earlier ones stay. */
export async function addRecording(
  c: pg.PoolClient, actorId: string | null,
  e: { tenantId: string; language: string; text: string; label?: string; contentType: ContentType; audioBase64: string; durationMs: number },
) {
  if (/\{\{/.test(e.text)) throw new AppError(400, 'A recording is for fixed words. Record the words around a {{slot}}, not the slot.');
  if (normalizeSpoken(e.text) === '') throw new AppError(400, 'Say which words this recording speaks.');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(e.audioBase64)) throw new AppError(400, 'The audio must be base64 text.');
  const audio = Buffer.from(e.audioBase64, 'base64');
  if (audio.length === 0 || audio.length > MAX_AUDIO_BYTES) throw new AppError(400, `The audio must be between 1 byte and ${MAX_AUDIO_BYTES / 1024 / 1024} MB.`);
  if (!looksLike(e.contentType, audio)) throw new AppError(400, `That file does not look like ${e.contentType}.`);
  const hash = textHash(e.language, e.text);
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`rec:${e.tenantId}:${hash}`]);
  const version = ((await c.query('SELECT coalesce(max(version), 0) AS v FROM recordings WHERE tenant_id = $1 AND language = $2 AND text_hash = $3', [e.tenantId, e.language, hash])).rows[0].v as number) + 1;
  const row = (await c.query(
    `INSERT INTO recordings (tenant_id, language, text, text_hash, version, label, content_type, audio, sha256, duration_ms, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, tenant_id, language, text, version, label, content_type, duration_ms, created_at`,
    [e.tenantId, e.language, normalizeSpoken(e.text), hash, version, e.label ?? null, e.contentType, audio, createHash('sha256').update(audio).digest('hex'), e.durationMs, actorId],
  )).rows[0];
  await audit(c, actorId, 'recording.add', 'recording', row.id, { language: e.language, version, bytes: audio.length });
  return row;
}

export const listRecordings = async (c: pg.PoolClient, tenantId: string) =>
  (await c.query(
    `SELECT DISTINCT ON (language, text_hash) id, language, text, version, label, content_type, duration_ms, created_at
       FROM recordings WHERE tenant_id = $1 ORDER BY language, text_hash, version DESC`, [tenantId])).rows;

export async function recordingAudio(c: pg.PoolClient, id: string) {
  const r = (await c.query('SELECT audio, content_type, sha256 FROM recordings WHERE id = $1', [id])).rows[0];
  if (!r) throw new AppError(404, 'Recording not found.');
  return r as { audio: Buffer; content_type: string; sha256: string };
}

/** The newest take of every set of words a client has recorded, ready for a call to look up. */
export async function recordingIndex(c: pg.PoolClient, tenantId: string): Promise<RecordingIndex> {
  const rows = (await c.query(
    `SELECT DISTINCT ON (language, text_hash) id, language, text_hash, duration_ms FROM recordings
      WHERE tenant_id = $1 ORDER BY language, text_hash, version DESC`, [tenantId])).rows;
  const byKey = new Map(rows.map((r) => [`${r.language}:${r.text_hash}`, { id: r.id as string, durationMs: r.duration_ms as number }]));
  return { find: (language, text) => byKey.get(`${language}:${textHash(language, text)}`) };
}

/** The fixed words in a workflow that have no recording yet, with their size: what is still worth recording. */
export function recordingGaps(def: WorkflowDefinition, index: RecordingIndex) {
  const missing = framesOf(def as never).filter((f) => !index.find(f.language, f.text));
  const covered = framesOf(def as never).length - missing.length;
  return { covered, missing, missingCharacters: missing.reduce((s, f) => s + f.characters, 0) };
}
