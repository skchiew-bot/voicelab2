/**
 * An adapter declares its own parameter set. The admin UI renders its form from
 * this declaration, so adding a provider means writing a new adapter, not
 * changing the UI or the API.
 */
export type ParamType = 'string' | 'secret' | 'url' | 'number' | 'boolean';

export interface ParamDef {
  key: string;
  label: string;
  type: ParamType;
  required: boolean;
  help?: string;
}

export type Support = 'native' | 'composable' | 'unsupported';

/** The shared vocabulary for the Puppet-Master classification. */
export const CAPABILITIES = [
  'inbound_calls',
  'outbound_calls',
  'call_transfer',
  'call_recording',
  'stt',
  'llm',
  'tts',
  'realtime_conversation',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export type Fetch = typeof fetch;

/**
 * Result of asking the provider whether credentials work.
 * rejected: the provider refused them. unreachable/unavailable: we could not tell.
 */
export type ValidationResult =
  | { ok: true; info?: Record<string, string> }
  | { ok: false; kind: 'rejected' | 'unreachable' | 'unavailable'; reason: string };

export interface Adapter {
  key: string;
  kind: 'telephony' | 'voice';
  displayName: string;
  docsUrl: string;
  params: ParamDef[];
  /** Starting classification. Operators can edit it per provider; verify in Phase 1. */
  defaultCapabilities: Record<Capability, Support>;
  /** Rules that span several parameters, e.g. "either an auth token or an API key pair". */
  crossValidate?(values: Record<string, string | number | boolean>): string | null;
  /** Live, read-only check of the credentials against the provider. Receives secrets merged with plain values. */
  validate?(values: Record<string, string | number | boolean>, http: Fetch): Promise<ValidationResult>;
}

export type ParamValues = Record<string, string | number | boolean>;
