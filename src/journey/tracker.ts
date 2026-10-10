/**
 * Reading a caller's turn: what kind of moment it is (inquiry, complaint, request), what it is about, and how they
 * feel. By rules over word lists, so it is free, instant and the same every time; a model can sit behind the same
 * interface where the rules are not enough, per the model-tier rules (the smallest model that does the job).
 */
export type Kind = 'inquiry' | 'complaint' | 'request' | 'other';
export const KINDS: readonly Kind[] = ['inquiry', 'complaint', 'request', 'other'];

export interface Lexicon {
  complaint: string[]; request: string[]; inquiry: string[];
  positive: string[]; negative: string[];
  /** Words that on their own mean the caller is very upset. */
  severe: string[];
  negators: string[];
  topics: Record<string, string[]>;
}

export interface TurnAnalysis { kind: Kind; topic: string | null; sentiment: number; severe: boolean; signals: string[] }

/** English and Bahasa Malaysia. A client adds to these; it cannot take them away. */
export const DEFAULT_LEXICON: Lexicon = {
  complaint: ['complain', 'complaint', 'unacceptable', 'ridiculous', 'cheating', 'cheated', 'scam', 'unfair', 'not fair', 'aduan', 'tak puas hati', 'tidak puas hati', 'penipuan'],
  request: ['please send', 'please call', 'i want', 'i need', 'i would like', 'can you', 'could you', 'tolong', 'minta', 'saya nak', 'saya mahu', 'hantar'],
  inquiry: ['how much', 'how many', 'what', 'when', 'why', 'who', 'where', 'which', 'berapa', 'bila', 'kenapa', 'siapa', 'di mana', 'bagaimana', 'apa'],
  positive: ['thanks', 'thank you', 'great', 'good', 'happy', 'okay', 'ok', 'fine', 'sure', 'terima kasih', 'baik', 'bagus', 'okey', 'boleh'],
  negative: ['bad', 'angry', 'annoyed', 'upset', 'frustrated', 'disappointed', 'waste', 'useless', 'stop calling', 'marah', 'kecewa', 'menyampah', 'tak boleh', 'tidak boleh', 'jangan'],
  severe: ['lawyer', 'sue', 'police', 'report you', 'harass', 'harassment', 'terrible', 'furious', 'hate', 'peguam', 'polis', 'saman', 'ganggu', 'bodoh', 'kurang ajar'],
  negators: ['not', 'never', 'no', 'tidak', 'tak', 'bukan', 'belum'],
  topics: {
    payment: ['pay', 'payment', 'paid', 'balance', 'owe', 'bayar', 'pembayaran', 'baki', 'hutang'],
    plan: ['instalment', 'installment', 'plan', 'ansuran', 'extension', 'tangguh'],
    identity: ['identity', 'who are you', 'wrong person', 'wrong number', 'bukan saya', 'salah nombor'],
    schedule: ['callback', 'call back', 'later', 'tomorrow', 'next week', 'nanti', 'esok', 'minggu depan'],
    dispute: ['dispute', 'not mine', 'never borrowed', 'bukan hutang saya'],
  },
};

const norm = (s: string) => s.toLowerCase().normalize('NFKC');
const tokens = (s: string) => norm(s).match(/[\p{L}\p{N}']+/gu) ?? [];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whole-word (or whole-phrase) occurrences of a phrase, with where each starts in the text. */
function find(text: string, phrase: string): [number, number][] {
  const p = norm(phrase).trim();
  if (!p) return [];
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escape(p)}(?![\\p{L}\\p{N}])`, 'giu');
  return [...norm(text).matchAll(re)].map((m) => [m.index!, m.index! + m[0].length] as [number, number]);
}

/** Merge a client's additions into the defaults. Limits keep a configuration from becoming a way to slow every turn. */
export function mergeLexicon(extra: Partial<Lexicon> | undefined): Lexicon {
  if (!extra) return DEFAULT_LEXICON;
  const add = (a: string[], b?: string[]) => [...new Set([...a, ...(b ?? [])])];
  const topics: Record<string, string[]> = Object.assign(Object.create(null), DEFAULT_LEXICON.topics);
  for (const [k, v] of Object.entries(extra.topics ?? {})) topics[k] = add(Object.hasOwn(topics, k) ? topics[k]! : [], v);
  return {
    complaint: add(DEFAULT_LEXICON.complaint, extra.complaint), request: add(DEFAULT_LEXICON.request, extra.request), inquiry: add(DEFAULT_LEXICON.inquiry, extra.inquiry),
    positive: add(DEFAULT_LEXICON.positive, extra.positive), negative: add(DEFAULT_LEXICON.negative, extra.negative), severe: add(DEFAULT_LEXICON.severe, extra.severe),
    negators: add(DEFAULT_LEXICON.negators, extra.negators), topics,
  };
}

export const SEVERE_BELOW = -0.75;

export function analyseTurn(text: string, lex: Lexicon = DEFAULT_LEXICON, severeBelow = SEVERE_BELOW): TurnAnalysis {
  const signals: string[] = [];
  const negatedAt = (index: number) => {
    // A negator in the two words before a phrase turns it round ("not happy"), but not across a pause ("no, thank you").
    const clause = norm(text).slice(0, index).split(/[,.;:!?]/).pop() ?? '';
    const before = tokens(clause).slice(-2);
    return before.some((t) => lex.negators.includes(t));
  };

  let pos = 0; let neg = 0; let sev = 0;
  // Longer phrases first, and a word already inside a counted phrase is not counted again ("tidak boleh" is not also "boleh").
  const taken: [number, number][] = [];
  const free = ([a, b]: [number, number]) => !taken.some(([c, d]) => a < d && c < b);
  for (const phrase of [...lex.severe].sort((a, b) => b.length - a.length)) for (const r of find(text, phrase)) if (free(r)) { taken.push(r); sev++; signals.push(`severe: ${phrase}`); }
  for (const phrase of [...lex.negative].sort((a, b) => b.length - a.length)) for (const r of find(text, phrase)) if (free(r)) { taken.push(r); neg++; signals.push(`negative: ${phrase}`); }
  for (const phrase of [...lex.positive].sort((a, b) => b.length - a.length)) {
    for (const r of find(text, phrase)) {
      if (!free(r)) continue;
      taken.push(r);
      if (negatedAt(r[0])) { neg++; signals.push(`negated: ${phrase}`); } else { pos++; signals.push(`positive: ${phrase}`); }
    }
  }
  const raw = pos - neg - 2 * sev;
  const sentiment = Math.round((raw / (Math.abs(raw) + 1)) * 100) / 100;

  const has = (list: string[]) => list.some((p) => find(text, p).length > 0);
  const kind: Kind = has(lex.complaint) || sev > 0 ? 'complaint' : has(lex.request) ? 'request' : text.includes('?') || has(lex.inquiry) ? 'inquiry' : 'other';

  let topic: string | null = null; let best = 0;
  for (const [name, phrases] of Object.entries(lex.topics)) {
    const n = phrases.reduce((s, p) => s + (find(text, p).length > 0 ? 1 : 0), 0);
    if (n > best) { best = n; topic = name; }
  }
  return { kind, topic, sentiment, severe: sev > 0 || sentiment <= severeBelow, signals };
}

export interface JourneyState {
  turns: { node: string; kind: Kind; topic: string | null; sentiment: number; severe: boolean }[];
  /** Turns where the call failed to understand the caller, or the caller was upset, without having recovered since. */
  recoveries: number;
}

export interface JourneyConfig { maxRecoveries: number; negativeBelow: number; severeBelow: number; lexicon: Lexicon }
export const DEFAULT_JOURNEY: JourneyConfig = { maxRecoveries: 2, negativeBelow: -0.3, severeBelow: SEVERE_BELOW, lexicon: DEFAULT_LEXICON };

export type Decision =
  | { escalate: false }
  | { escalate: true; trigger: 'severe_sentiment' | 'failed_recoveries'; detail: string };

/**
 * One more turn. A turn the call did not understand, or in which the caller is upset, is a failed recovery; a turn
 * that is understood and not upset clears the count. Severe sentiment escalates at once; otherwise the call escalates
 * once it has failed to recover `maxRecoveries` times (about two), whichever comes first.
 */
export function observeTurn(
  state: JourneyState, turn: { node: string; analysis: TurnAnalysis; understood: boolean }, cfg: JourneyConfig,
): Decision {
  const a = turn.analysis;
  state.turns.push({ node: turn.node, kind: a.kind, topic: a.topic, sentiment: a.sentiment, severe: a.severe });
  const bad = !turn.understood || a.sentiment <= cfg.negativeBelow;
  state.recoveries = bad ? state.recoveries + 1 : 0;
  if (a.severe) return { escalate: true, trigger: 'severe_sentiment', detail: `The caller's sentiment was severe (${a.sentiment}).` };
  if (state.recoveries >= cfg.maxRecoveries) {
    return { escalate: true, trigger: 'failed_recoveries', detail: `${state.recoveries} turns in a row were not understood or left the caller upset.` };
  }
  return { escalate: false };
}

/** The kind or topic differs from the turn before: the caller's intent has changed. */
export function intentChanged(state: JourneyState): boolean {
  const n = state.turns.length;
  if (n < 2) return false;
  const a = state.turns[n - 2]!; const b = state.turns[n - 1]!;
  return a.kind !== b.kind || a.topic !== b.topic;
}
