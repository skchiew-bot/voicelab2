import type { WorkflowDefinition } from './definition.js';

export interface TemplateWorkflow { key: string; description: string; definition: WorkflowDefinition }
export interface Template { key: string; title: string; description: string; entry: string; workflows: TemplateWorkflow[] }

const VARIABLES = ['customer_name', 'company', 'balance', 'account_name', 'due_date', 'payment_channel', 'expected_nric_last4'];

/**
 * A starting point for collecting an overdue balance by phone in Malaysia: English and Bahasa Malaysia, amounts in RM,
 * identity checked before any debt is mentioned, and a person available whenever the caller disputes or is unclear.
 * The wording is a draft. It needs review by whoever is responsible for compliance, and the Bahasa Malaysia needs
 * review by a native speaker, before it is used with real customers.
 */
const debtCollectionMy: Template = {
  key: 'debt_collection_my',
  title: 'Debt collection (Malaysia)',
  entry: 'collections',
  description: 'Greets the customer, checks their identity, states the balance, and then takes a promise to pay, hands over to a partial-payment plan, or passes to a person. English and Bahasa Malaysia. A draft: review the wording with compliance and a native Bahasa Malaysia speaker before real use.',
  workflows: [
    {
      key: 'collections',
      description: 'The main call.',
      definition: {
        start: 'greet', variables: VARIABLES, sensitiveVariables: ['expected_nric_last4'], languages: ['en', 'ms'],
        nodes: {
          greet: {
            type: 'speak', speech: 'hybrid', label: 'Greeting',
            text: {
              en: 'Hello, this is {{company}} calling for {{customer_name}}. Am I speaking with {{customer_name}}?',
              ms: 'Helo, ini {{company}} menghubungi {{customer_name}}. Adakah saya bercakap dengan {{customer_name}}?',
            },
            listen: { captureAs: 'is_customer', intents: {
              yes: ['yes', 'yeah', 'speaking', 'ya', 'betul', 'ya betul', 'ya saya'],
              no: ['no', 'nope', 'wrong number', 'wrong person', 'tidak', 'bukan', 'bukan saya', 'salah nombor', 'salah orang'],
            } },
            transitions: [
              { when: { var: 'is_customer_intent', op: 'eq', value: 'yes' }, to: 'verify' },
              { when: { var: 'is_customer_intent', op: 'eq', value: 'no' }, to: 'wrong_person' },
              { to: 'greet_again' },
            ],
          },
          greet_again: {
            type: 'speak', speech: 'hybrid', label: 'Greeting, second try',
            text: {
              en: 'Sorry, I did not catch that. Am I speaking with {{customer_name}}?',
              ms: 'Maaf, saya tidak dengar dengan jelas. Adakah saya bercakap dengan {{customer_name}}?',
            },
            listen: { captureAs: 'is_customer', intents: {
              yes: ['yes', 'yeah', 'speaking', 'ya', 'betul', 'ya betul', 'ya saya'],
              no: ['no', 'nope', 'wrong number', 'wrong person', 'tidak', 'bukan', 'bukan saya', 'salah nombor', 'salah orang'],
            } },
            transitions: [
              { when: { var: 'is_customer_intent', op: 'eq', value: 'yes' }, to: 'verify' },
              { when: { var: 'is_customer_intent', op: 'eq', value: 'no' }, to: 'wrong_person' },
              { to: 'no_clear_answer' },
            ],
          },
          no_clear_answer: {
            type: 'speak', speech: 'fixed',
            text: { en: 'Sorry to have troubled you. We will try again another time. Goodbye.', ms: 'Maaf kerana mengganggu. Kami akan cuba lagi pada masa lain. Selamat tinggal.' },
            transitions: [{ to: 'end_unclear' }],
          },
          end_unclear: { type: 'end', outcome: 'no_clear_answer' },
          wrong_person: {
            type: 'speak', speech: 'fixed',
            text: { en: 'I am sorry to have troubled you. Goodbye.', ms: 'Maaf kerana mengganggu. Selamat tinggal.' },
            transitions: [{ to: 'end_wrong' }],
          },
          end_wrong: { type: 'end', outcome: 'wrong_person' },
          verify: {
            type: 'subflow', workflow: 'verify_identity', label: 'Check identity',
            transitions: [{ when: { var: 'verify_outcome', op: 'eq', value: 'verified' }, to: 'disclose' }, { to: 'verify_failed' }],
          },
          verify_failed: {
            type: 'speak', speech: 'fixed',
            text: { en: 'I am sorry, I cannot continue without confirming your identity. Goodbye.', ms: 'Maaf, saya tidak dapat meneruskan tanpa mengesahkan identiti anda. Selamat tinggal.' },
            transitions: [{ to: 'end_unverified' }],
          },
          end_unverified: { type: 'end', outcome: 'verification_failed' },
          disclose: {
            type: 'speak', speech: 'hybrid', label: 'State the balance',
            text: {
              en: 'Thank you. Our records show an outstanding balance of RM {{balance}} on your {{account_name}} account, which was due on {{due_date}}. Are you able to pay this today?',
              ms: 'Terima kasih. Rekod kami menunjukkan baki tertunggak sebanyak RM {{balance}} bagi akaun {{account_name}} anda, yang telah tamat tempoh pada {{due_date}}. Adakah anda boleh membayar hari ini?',
            },
            listen: { captureAs: 'pay_answer', intents: {
              pay_full: ['yes', 'ya', 'boleh', 'sanggup', 'pay in full', 'pay it all', 'bayar penuh'],
              partial: ['partial', 'some of it', 'part of it', 'instalment', 'installment', 'bayar separa', 'ansuran', 'sebahagian'],
              cannot: ['cannot', "can't", 'no money', 'tidak boleh', 'tak boleh', 'tidak mampu', 'tak mampu'],
              dispute: ['dispute', 'not mine', 'wrong amount', 'incorrect', 'bukan hutang saya', 'pertikai', 'tidak betul'],
            } },
            transitions: [
              { when: { var: 'pay_answer_intent', op: 'eq', value: 'pay_full' }, to: 'promise' },
              { when: { var: 'pay_answer_intent', op: 'in', value: ['partial', 'cannot'] }, to: 'to_partial' },
              { to: 'to_human' },
            ],
          },
          promise: {
            type: 'speak', speech: 'hybrid',
            text: {
              en: 'Thank you. You can pay through {{payment_channel}}. We have noted your promise to pay today. Goodbye.',
              ms: 'Terima kasih. Anda boleh membayar melalui {{payment_channel}}. Kami telah mencatat janji anda untuk membayar hari ini. Selamat tinggal.',
            },
            transitions: [{ to: 'end_promise' }],
          },
          end_promise: { type: 'end', outcome: 'promise_to_pay', contact: 'contacted' },
          to_partial: { type: 'handoff', target: { workflow: 'partial_payment' }, label: 'Offer a payment plan' },
          to_human: { type: 'handoff', target: { workflow: 'human_transfer' }, label: 'Pass to a person' },
        },
      },
    },
    {
      key: 'verify_identity',
      description: 'Asks for the last four digits of the identity card number, with one retry. The answer is never recorded.',
      definition: {
        start: 'ask', variables: ['expected_nric_last4'], sensitiveVariables: ['expected_nric_last4'], languages: ['en', 'ms'],
        nodes: {
          ask: {
            type: 'speak', speech: 'fixed',
            text: { en: 'For your security, please tell me the last four digits of your identity card number.', ms: 'Untuk keselamatan anda, sila beritahu empat digit terakhir nombor kad pengenalan anda.' },
            listen: { captureAs: 'nric_last4', sensitive: true },
            transitions: [{ when: { var: 'nric_last4', op: 'eq', valueVar: 'expected_nric_last4' }, to: 'ok' }, { to: 'ask_again' }],
          },
          ask_again: {
            type: 'speak', speech: 'fixed',
            text: { en: 'That does not match our records. Please try once more: the last four digits of your identity card number.', ms: 'Itu tidak sepadan dengan rekod kami. Sila cuba sekali lagi: empat digit terakhir nombor kad pengenalan anda.' },
            listen: { captureAs: 'nric_last4', sensitive: true },
            transitions: [{ when: { var: 'nric_last4', op: 'eq', valueVar: 'expected_nric_last4' }, to: 'ok' }, { to: 'failed' }],
          },
          ok: { type: 'end', outcome: 'verified' },
          failed: { type: 'end', outcome: 'failed' },
        },
      },
    },
    {
      key: 'partial_payment',
      description: 'Asks how much the customer can pay each month and notes it for follow-up.',
      definition: {
        start: 'ask_amount', variables: ['customer_name', 'balance'], languages: ['en', 'ms'],
        nodes: {
          ask_amount: {
            type: 'speak', speech: 'hybrid',
            text: {
              en: 'I understand, {{customer_name}}. Your balance is RM {{balance}}. How much can you pay each month?',
              ms: 'Saya faham, {{customer_name}}. Baki anda ialah RM {{balance}}. Berapa banyak yang boleh anda bayar setiap bulan?',
            },
            listen: { captureAs: 'monthly_amount' },
            transitions: [{ when: { var: 'monthly_amount', op: 'gt', value: 0 }, to: 'confirm' }, { to: 'to_human' }],
          },
          confirm: {
            type: 'speak', speech: 'hybrid',
            text: {
              en: 'Thank you. I have noted that you can pay about RM {{monthly_amount}} each month. Someone from our team will follow up to confirm. Goodbye.',
              ms: 'Terima kasih. Saya telah mencatat bahawa anda boleh membayar kira-kira RM {{monthly_amount}} sebulan. Seseorang daripada pasukan kami akan menghubungi anda untuk mengesahkan. Selamat tinggal.',
            },
            transitions: [{ to: 'end_agreed' }],
          },
          end_agreed: { type: 'end', outcome: 'partial_agreed', contact: 'contacted' },
          to_human: { type: 'handoff', target: { human: { reason: 'The customer\'s monthly amount was not understood' } } },
        },
      },
    },
    {
      key: 'human_transfer',
      description: 'Tells the customer a colleague will take over, and passes the call to a person.',
      definition: {
        start: 'say', languages: ['en', 'ms'],
        nodes: {
          say: {
            type: 'speak', speech: 'fixed',
            text: { en: 'Let me pass you to a colleague who can help. Please hold.', ms: 'Biar saya sambungkan anda kepada rakan sekerja yang boleh membantu. Sila tunggu.' },
            transitions: [{ to: 'pass' }],
          },
          pass: { type: 'handoff', target: { human: { reason: 'The customer disputes the balance, or their answer was not understood' } } },
        },
      },
    },
  ],
};

export const TEMPLATES: Template[] = [debtCollectionMy];
export const templateFor = (key: string) => TEMPLATES.find((t) => t.key === key);

/** The template's workflows with names a tenant can use: `prefix` is put in front of each, and references are updated to match. */
export function instantiate(t: Template, prefix = ''): { name: string; description: string; definition: WorkflowDefinition }[] {
  const rename = (key: string) => `${prefix}${key}`;
  const known = new Set(t.workflows.map((w) => w.key));
  return t.workflows.map((w) => {
    const def = structuredClone(w.definition);
    for (const n of Object.values(def.nodes)) {
      if (n.type === 'subflow' && known.has(n.workflow)) n.workflow = rename(n.workflow);
      if (n.type === 'handoff' && 'workflow' in n.target && known.has(n.target.workflow)) n.target = { workflow: rename(n.target.workflow) };
    }
    return { name: rename(w.key), description: w.description, definition: def };
  });
}
