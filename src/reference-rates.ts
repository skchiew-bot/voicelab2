/**
 * Starting rates from the blueprint's research. They are approximate and must be checked against
 * each provider's current pricing page, so they are always saved unconfirmed. The blueprint gives no
 * billing increment, so the caller must choose one: it is not guessed here.
 */
export interface ReferenceComponent {
  component: string; unit: string; rate: string; currency: string; billingLine: string; direction: 'any' | 'inbound' | 'outbound';
}
export interface ReferenceRate {
  adapterKey: string; summary: string; components: ReferenceComponent[]; burstPremiumMultiplier?: number;
}

const NOTE = 'Reference rate from the blueprint research. Approximate and unconfirmed: check it against the provider\'s current pricing page.';

export const REFERENCE_RATES: ReferenceRate[] = [
  { adapterKey: 'twilio', summary: 'About $0.014 per outbound minute and $0.0085 per inbound minute.', components: [
    { component: 'telephony_leg', unit: 'per_minute', rate: '0.0140', currency: 'USD', billingLine: 'main', direction: 'outbound' },
    { component: 'telephony_leg', unit: 'per_minute', rate: '0.0085', currency: 'USD', billingLine: 'main', direction: 'inbound' },
  ] },
  { adapterKey: 'telnyx', summary: 'About $0.007 per outbound minute including the SIP trunk. No inbound figure in the blueprint.', components: [
    { component: 'telephony_leg', unit: 'per_minute', rate: '0.0070', currency: 'USD', billingLine: 'main', direction: 'outbound' },
  ] },
  { adapterKey: 'openai', summary: 'Realtime is about $0.06 to $0.10 per minute all-in; this uses the midpoint, $0.08.', components: [
    { component: 'platform', unit: 'per_minute', rate: '0.0800', currency: 'USD', billingLine: 'main', direction: 'any' },
  ] },
  { adapterKey: 'elevenlabs', summary: 'Conversational is about $0.08 per minute and doubles on overburst.', burstPremiumMultiplier: 2, components: [
    { component: 'platform', unit: 'per_minute', rate: '0.0800', currency: 'USD', billingLine: 'main', direction: 'any' },
  ] },
];

export const referenceRateFor = (adapterKey: string) => REFERENCE_RATES.find((r) => r.adapterKey === adapterKey);
export const REFERENCE_NOTE = NOTE;
