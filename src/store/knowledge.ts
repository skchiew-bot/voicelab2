import type pg from 'pg';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { rank, type Article, type Channel } from '../knowledge/search.js';
import { audit } from './audit.js';
import { cleanNote } from './cases.js';

const noNumber = (text: string | undefined | null, label: string): string | undefined => cleanNote(text, label);

export const articleSchema = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9_-]{0,60}$/), language: z.string().regex(/^[a-z]{2,3}$/).default('en'),
  title: z.string().min(1).max(200), body: z.string().min(1).max(8000), voiceText: z.string().min(1).max(600).optional(), tags: z.array(z.string().min(1).max(40)).max(20).default([]),
}).strict();
export const versionSchema = articleSchema.omit({ slug: true, language: true });

const lock = (c: pg.PoolClient, key: string) => c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);

/**
 * What a client's bot may know is written for the people who read it and for those who hear it, so a customer's phone
 * number never goes in (a helpline is described in words, not dialled from an article).
 */
function check(e: { title: string; body: string; voiceText?: string; tags?: string[] }) {
  noNumber(e.title, 'title'); noNumber(e.body, 'text'); noNumber(e.voiceText, 'spoken form'); for (const t of e.tags ?? []) noNumber(t, 'tag');
}

export async function createArticle(c: pg.PoolClient, actorId: string | null, tenantId: string, e: z.infer<typeof articleSchema>) {
  check(e);
  const a = (await c.query('INSERT INTO knowledge_articles (tenant_id, slug, language) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, slug, language) DO NOTHING RETURNING id', [tenantId, e.slug, e.language])).rows[0];
  if (!a) throw new AppError(409, 'An article with that name already exists in that language.');
  await c.query('INSERT INTO knowledge_versions (article_id, version, title, body, voice_text, tags, created_by) VALUES ($1,1,$2,$3,$4,$5,$6)', [a.id, e.title, e.body, e.voiceText ?? null, e.tags, actorId]);
  await audit(c, actorId, 'knowledge.create', 'article', a.id, { slug: e.slug });
  return getArticle(c, a.id);
}

/** A new draft of an article. Only one draft at a time, so two writers cannot publish over each other. */
export async function addVersion(c: pg.PoolClient, actorId: string | null, articleId: string, e: z.infer<typeof versionSchema>) {
  check(e);
  await lock(c, `article:${articleId}`);
  const a = (await c.query('SELECT id, retired_at FROM knowledge_articles WHERE id = $1', [articleId])).rows[0];
  if (!a) throw new AppError(404, 'Article not found.');
  if (a.retired_at) throw new AppError(409, 'That article is retired.');
  if ((await c.query(`SELECT 1 FROM knowledge_versions WHERE article_id = $1 AND status = 'draft'`, [articleId])).rowCount) throw new AppError(409, 'There is already a draft waiting for review. Publish or reject it first.');
  const next = ((await c.query('SELECT coalesce(max(version), 0) AS v FROM knowledge_versions WHERE article_id = $1', [articleId])).rows[0].v as number) + 1;
  await c.query('INSERT INTO knowledge_versions (article_id, version, title, body, voice_text, tags, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [articleId, next, e.title, e.body, e.voiceText ?? null, e.tags, actorId]);
  await audit(c, actorId, 'knowledge.version', 'article', articleId, { version: next });
  return getArticle(c, articleId);
}

async function versionRow(c: pg.PoolClient, id: string) {
  const v = (await c.query('SELECT v.*, a.tenant_id, a.retired_at FROM knowledge_versions v JOIN knowledge_articles a ON a.id = v.article_id WHERE v.id = $1', [id])).rows[0];
  if (!v) throw new AppError(404, 'Version not found.');
  return v;
}

/** Publish a draft. A different person from its author does it; the version it replaces is retired in the same step. */
export async function publish(c: pg.PoolClient, actorId: string, versionId: string, note?: string) {
  const first = await versionRow(c, versionId);
  await lock(c, `article:${first.article_id}`);
  const v = await versionRow(c, versionId);
  if (v.status !== 'draft') throw new AppError(409, `That version is ${v.status}.`);
  if (v.retired_at) throw new AppError(409, 'That article is retired.');
  if (v.created_by === actorId) throw new AppError(403, 'You wrote this version, so someone else has to publish it.');
  await c.query(`UPDATE knowledge_versions SET status = 'retired' WHERE article_id = $1 AND status = 'published'`, [v.article_id]);
  await c.query(`UPDATE knowledge_versions SET status = 'published', reviewed_by = $2, reviewed_at = now(), review_note = $3 WHERE id = $1`, [versionId, actorId, noNumber(note, 'note') ?? null]);
  await audit(c, actorId, 'knowledge.publish', 'article', v.article_id, { version: v.version });
  return getArticle(c, v.article_id);
}

export async function reject(c: pg.PoolClient, actorId: string, versionId: string, note: string) {
  if (!note.trim()) throw new AppError(400, 'Say why you are turning this down.');
  noNumber(note, 'note');
  const first = await versionRow(c, versionId);
  await lock(c, `article:${first.article_id}`);
  const v = await versionRow(c, versionId);
  if (v.status !== 'draft') throw new AppError(409, `That version is ${v.status}.`);
  await c.query(`UPDATE knowledge_versions SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), review_note = $3 WHERE id = $1`, [versionId, actorId, note]);
  await audit(c, actorId, 'knowledge.reject', 'article', v.article_id, { version: v.version });
  return getArticle(c, v.article_id);
}

/** Take an article out of use. What it said is kept. */
export async function retireArticle(c: pg.PoolClient, actorId: string | null, articleId: string) {
  await lock(c, `article:${articleId}`);
  const r = (await c.query(`UPDATE knowledge_articles SET retired_at = now() WHERE id = $1 AND retired_at IS NULL RETURNING id`, [articleId])).rows[0];
  if (!r) throw new AppError(409, 'That article does not exist or is already retired.');
  await c.query(`UPDATE knowledge_versions SET status = 'retired' WHERE article_id = $1 AND status IN ('published', 'draft')`, [articleId]);
  await audit(c, actorId, 'knowledge.retire', 'article', articleId, {});
  return getArticle(c, articleId);
}

export async function getArticle(c: pg.PoolClient, id: string) {
  const a = (await c.query('SELECT * FROM knowledge_articles WHERE id = $1', [id])).rows[0];
  if (!a) throw new AppError(404, 'Article not found.');
  const versions = (await c.query('SELECT id, version, title, body, voice_text, tags, status, created_by, created_at, reviewed_by, reviewed_at, review_note FROM knowledge_versions WHERE article_id = $1 ORDER BY version', [id])).rows;
  return { id: a.id, tenantId: a.tenant_id, slug: a.slug, language: a.language, retiredAt: a.retired_at, versions };
}

export const listArticles = async (c: pg.PoolClient, tenantId: string) =>
  (await c.query(
    `SELECT a.id, a.slug, a.language, a.retired_at,
            (SELECT v.title FROM knowledge_versions v WHERE v.article_id = a.id ORDER BY v.version DESC LIMIT 1) AS title,
            (SELECT v.version FROM knowledge_versions v WHERE v.article_id = a.id AND v.status = 'published') AS published_version,
            (SELECT count(*)::int FROM knowledge_versions v WHERE v.article_id = a.id AND v.status = 'draft') AS drafts
       FROM knowledge_articles a WHERE a.tenant_id = $1 ORDER BY a.slug, a.language`, [tenantId])).rows;

/** Everything a client's bot may use right now: the published version of each article that is not retired. */
export async function publishedArticles(c: pg.PoolClient, tenantId: string): Promise<Article[]> {
  return (await c.query(
    `SELECT a.slug, a.language, v.title, v.body, v.voice_text, v.tags FROM knowledge_articles a JOIN knowledge_versions v ON v.article_id = a.id AND v.status = 'published'
      WHERE a.tenant_id = $1 AND a.retired_at IS NULL`, [tenantId])).rows.map((r) => ({ slug: r.slug, language: r.language, title: r.title, body: r.body, voiceText: r.voice_text, tags: r.tags }));
}

export async function searchKnowledge(c: pg.PoolClient, tenantId: string, e: { q: string; language?: string; channel: Channel; limit?: number }) {
  return rank(await publishedArticles(c, tenantId), e.q, { language: e.language, channel: e.channel, limit: Math.min(e.limit ?? 3, 10) });
}
