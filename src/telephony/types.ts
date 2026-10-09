import type { Fetch } from '../adapters/types.js';

export type { Fetch };

/** What a provider's webhook means, in Voice Lab's terms. */
export interface NormalizedEvent {
  /** Unique per delivered event, so retries are recognised and skipped. */
  key: string;
  providerCallId: string;
  kind: 'initiated' | 'ringing' | 'answered' | 'ended' | 'speak_ended';
  direction?: 'inbound' | 'outbound';
  occurredAt: Date;
  /** Billed-relevant call length, when the provider reports it (Twilio does; Telnyx we derive). */
  durationSeconds?: number;
  endReason?: 'completed' | 'busy' | 'no_answer' | 'canceled' | 'rejected' | 'failed';
  /** Our own call id, echoed back by the provider, so an event can never be matched to the wrong call. */
  callIdHint?: string;
  /**
   * Customer-side and our-side numbers. They live in memory only: used to route an inbound call,
   * then dropped. They are never stored, logged or audited.
   */
  transient?: { from?: string; to?: string };
}

export type Action =
  | { type: 'reject' }
  | { type: 'telnyx'; action: 'answer' | 'speak' | 'hangup' | 'reject'; callControlId: string; body?: Record<string, unknown> };

/** Said on a test call until the workflow engine and voice providers take over (Phase 2). */
export const TEST_CALL_MESSAGE = 'This is a Voice Lab test call. Goodbye.';

/** Provider error text can quote the numbers involved. Strip anything that looks like one. */
export const redactNumbers = (text: string): string => text.replace(/\+?\d[\d\s().-]{6,}\d/g, '[number]');
