/**
 * Work out what a caller meant, by rules: each intent lists the phrases that mean it.
 * - A phrase counts only as whole words ("no" is not inside "know").
 * - A match sitting inside a longer match of another intent is ignored, so "tidak boleh" (cannot) is not
 *   also read as "boleh" (can), and "can't" is not read as "can".
 * - Exactly one intent left is a match; none is "unknown"; several is "ambiguous" ("yes and no").
 * Deterministic and free, so a model is only needed where rules are not enough (later), per the model-tier rules.
 */
export type Intent = string;

interface Span { intent: string; start: number; end: number }

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function spansOf(reply: string, intent: string, phrase: string): Span[] {
  const p = phrase.trim();
  if (!p) return [];
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escape(p)}(?![\\p{L}\\p{N}])`, 'giu');
  return [...reply.matchAll(re)].map((m) => ({ intent, start: m.index!, end: m.index! + m[0].length }));
}

export function interpretReply(reply: string, intents: Record<string, string[]>): Intent {
  const spans = Object.entries(intents).flatMap(([intent, phrases]) => phrases.flatMap((p) => spansOf(reply, intent, p)));
  const kept = spans.filter((a) => !spans.some((b) => b.intent !== a.intent && b.start <= a.start && b.end >= a.end && (b.end - b.start) > (a.end - a.start)));
  const hits = [...new Set(kept.map((s) => s.intent))];
  return hits.length === 1 ? hits[0]! : hits.length === 0 ? 'unknown' : 'ambiguous';
}
