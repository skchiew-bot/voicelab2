/**
 * Who ended a call, and whether the system dropped it by mistake. The telephone provider does not say who hung up
 * (and what it might say has not been checked against the live services), so this is decided from our own side: where
 * the workflow was when the call ended.
 *
 *  - The workflow had finished (including a hand-over to a person) and then the call ended: the system ended it, on purpose.
 *  - The workflow was waiting for the caller and the call ended: the customer hung up.
 *  - The workflow had failed, or was still working, or the provider reported a failure: the system dropped the call.
 *    That is a fault, flagged loudly.
 */
export interface EndInput {
  endReason?: string;
  answered: boolean;
  run?: { status: string; outcome?: string | null; error?: string | null; node?: string | null };
}
export interface EndClassification { endedBy: 'customer' | 'system' | null; node: string | null; fault: boolean; reason: string }

const FAULT_OUTCOMES = new Set(['error', 'integration_failed']);

export function classifyEnd(i: EndInput): EndClassification {
  const node = i.run?.node ?? null;
  if (i.endReason === 'failed' && i.answered) return { endedBy: 'system', node, fault: true, reason: 'The provider reported the call as failed after it was answered.' };
  if (!i.answered) return { endedBy: null, node: null, fault: false, reason: 'The call was never answered, so nobody hung up and the workflow did not drop it.' };
  if (!i.run) return { endedBy: null, node: null, fault: false, reason: 'No workflow was running on this call, so who ended it is not known.' };
  const r = i.run;
  if (r.status === 'ended') {
    if (r.outcome && FAULT_OUTCOMES.has(r.outcome)) return { endedBy: 'system', node, fault: true, reason: `The workflow failed (${r.error ?? r.outcome}) and the call ended.` };
    return { endedBy: 'system', node, fault: false, reason: `The workflow finished (${r.outcome ?? 'completed'}).` };
  }
  if (r.status === 'awaiting_reply') return { endedBy: 'customer', node, fault: false, reason: 'The caller hung up while the workflow was waiting for them.' };
  return { endedBy: 'system', node, fault: true, reason: 'The call ended while the workflow was still working, so the system dropped it.' };
}
