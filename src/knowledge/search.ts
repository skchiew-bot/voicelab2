/**
 * Finding what the bot should know: published articles ranked against a question by plain word overlap (no model, no
 * embeddings), and each given in the form that suits the channel. A phone call hears a short form with nothing that
 * cannot be said aloud; a message gets the full text.
 */
export interface Article { slug: string; language: string; title: string; body: string; voiceText: string | null; tags: string[] }
export interface Snippet { slug: string; title: string; text: string; derived: boolean; score: number }
export type Channel = 'voice' | 'text';

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'be', 'it', 'this', 'that', 'with', 'as', 'at', 'by', 'from', 'what', 'how', 'do', 'does', 'i', 'my', 'me', 'we', 'you', 'your', 'can', 'will', 'yang', 'dan', 'di', 'ke', 'untuk', 'saya', 'apa']);
export const words = (s: string): string[] => (s.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}']+/gu) ?? []).filter((w) => w.length > 1 && !STOP.has(w));

/** How well an article answers a question: title words count most, then tags, then the body. */
export function score(a: Article, q: string): number {
  const want = [...new Set(words(q))];
  if (want.length === 0) return 0;
  const title = new Set(words(a.title)); const tags = new Set(a.tags.flatMap(words)); const body = words(a.body);
  let s = 0;
  for (const w of want) {
    if (title.has(w)) s += 3;
    if (tags.has(w)) s += 2;
    const n = body.filter((x) => x === w).length;
    if (n > 0) s += 1 + Math.min(n - 1, 2) * 0.25;
  }
  return Math.round((s / want.length) * 1000) / 1000;
}

/** A form of the article that can be said aloud: its first sentences, with no web address or long run of digits. */
export function speakable(body: string, maxChars = 300): string {
  const clean = body.replace(/https?:\/\/\S+/g, '').replace(/\b\S+@\S+\b/g, '').replace(/\s+/g, ' ').trim();
  const sentences = clean.match(/[^.!?]+[.!?]*/g) ?? [clean];
  let out = '';
  for (const s of sentences) { if ((out + s).length > maxChars && out) break; out += s; }
  return out.trim().slice(0, maxChars);
}

/** The best matches for a question, in the language asked for (else English), in the form for the channel. */
export function rank(articles: Article[], q: string, o: { language?: string; channel: Channel; limit?: number; minScore?: number }): Snippet[] {
  const lang = o.language ?? 'en';
  const pool = articles.filter((a) => a.language === lang);
  const use = pool.length > 0 ? pool : articles.filter((a) => a.language === 'en');
  return use.map((a) => ({ a, s: score(a, q) })).filter((x) => x.s >= (o.minScore ?? 1)).sort((x, y) => y.s - x.s || x.a.slug.localeCompare(y.a.slug)).slice(0, o.limit ?? 3)
    .map(({ a, s }) => o.channel === 'voice'
      ? { slug: a.slug, title: a.title, text: a.voiceText ?? speakable(a.body), derived: a.voiceText === null, score: s }
      : { slug: a.slug, title: a.title, text: a.body.length > 1500 ? `${a.body.slice(0, 1500)}…` : a.body, derived: false, score: s });
}
