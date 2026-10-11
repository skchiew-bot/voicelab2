/**
 * When every provider has failed, a call still gets an answer. The ladder is: say the holding message, then a person
 * if one is on hand, else a callback offer, else voicemail. Whatever is configured, a callback request is recorded
 * unless the call went to a person, so the client can always follow up. The ladder never ends in silence.
 */
/** `waitMessage` is the short line a reconnected caller hears while the call waits to carry on; null means the default. */
export interface FallbackPlan { holdingMessage: string; offerCallback: boolean; humanTransfer: boolean; voicemail: boolean; waitMessage?: string | null }
export type FallbackStep =
  | { kind: 'holding_message'; text: string }
  | { kind: 'transfer_human' }
  | { kind: 'offer_callback' }
  | { kind: 'voicemail' }
  | { kind: 'record_callback_request' };

export function fallbackLadder(plan: FallbackPlan, ctx: { humanAvailable: boolean }): FallbackStep[] {
  const steps: FallbackStep[] = [{ kind: 'holding_message', text: plan.holdingMessage }];
  if (plan.humanTransfer && ctx.humanAvailable) { steps.push({ kind: 'transfer_human' }); return steps; }
  if (plan.offerCallback) steps.push({ kind: 'offer_callback' });
  else if (plan.voicemail) steps.push({ kind: 'voicemail' });
  steps.push({ kind: 'record_callback_request' });
  return steps;
}

/** What a client with no plan gets: a plain holding message and a recorded callback request. */
export const DEFAULT_FALLBACK: FallbackPlan = {
  holdingMessage: 'We are sorry, we are having technical difficulties. We will call you back shortly.',
  offerCallback: true, humanTransfer: false, voicemail: false,
};
