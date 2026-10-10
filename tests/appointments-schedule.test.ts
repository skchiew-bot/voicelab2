import { describe, expect, it } from 'vitest';
import { redactNumbers } from '../src/telephony/types.js';
import { cascade, feeFor, freeStarts, messageFor, occupied, whenText } from '../src/appointments/schedule.js';

const KL = 'Asia/Kuala_Lumpur';           // UTC+8
const at = (iso: string) => new Date(iso);
const day = { date: '2026-10-12', starts: '09:00', ends: '12:00', timeZone: KL };   // 01:00 to 04:00 UTC
const NOW = at('2026-10-10T00:00:00Z');

describe('free start times', () => {
  it('offers every step that fits the hours and clashes with nothing, with the journey counted', () => {
    const busy = [occupied({ startsAt: at('2026-10-12T02:00:00Z'), endsAt: at('2026-10-12T03:00:00Z'), travelMinutes: 30 })];    // 10:00 to 11:00 local, officer travelling from 09:30
    const starts = freeStarts({ day, durationMinutes: 30, travelMinutes: 0, busy, now: NOW }).map((d) => d.toISOString());
    expect(starts).toEqual(['2026-10-12T01:00:00.000Z', '2026-10-12T03:00:00.000Z', '2026-10-12T03:15:00.000Z', '2026-10-12T03:30:00.000Z']);
    // 09:15 would run into the journey that starts at 09:30; with 15 minutes of its own travel the third slot after the busy time is also gone
    const withTravel = freeStarts({ day, durationMinutes: 30, travelMinutes: 15, busy, now: NOW }).map((d) => d.toISOString());
    expect(withTravel).toEqual(['2026-10-12T01:00:00.000Z', '2026-10-12T03:15:00.000Z', '2026-10-12T03:30:00.000Z']);       // 11:00 would need the journey to start inside the busy hour
  });
  it('never offers a time that is past, or one that runs beyond closing', () => {
    expect(freeStarts({ day, durationMinutes: 60, travelMinutes: 0, busy: [], now: at('2026-10-12T02:10:00Z') }).map((d) => d.toISOString())).toEqual(
      ['2026-10-12T02:15:00.000Z', '2026-10-12T02:30:00.000Z', '2026-10-12T02:45:00.000Z', '2026-10-12T03:00:00.000Z']);
  });
});

describe('a delay moves what follows', () => {
  const a = (id: string, from: string, to: string, travel = 15) => ({ id, startsAt: at(from), endsAt: at(to), travelMinutes: travel });
  const dayOf = [a('a', '2026-10-12T01:00:00Z', '2026-10-12T01:45:00Z', 0), a('b', '2026-10-12T02:00:00Z', '2026-10-12T02:45:00Z'), a('c', '2026-10-12T03:00:00Z', '2026-10-12T03:45:00Z')];
  const close = at('2026-10-12T09:00:00Z');
  it('pushes each later appointment only as far as it must, and stops where the slack absorbs it', () => {
    // a starts 20 minutes late: ends 02:05; b needs 15 minutes to travel, so starts 02:20; ends 03:05; c needs until 03:20
    const moves = cascade(dayOf, 'a', 20, close);
    expect(moves.map((m) => [m.id, m.startsAt.toISOString(), m.shiftedMinutes, m.overflow])).toEqual([
      ['a', '2026-10-12T01:20:00.000Z', 20, false], ['b', '2026-10-12T02:20:00.000Z', 20, false], ['c', '2026-10-12T03:20:00.000Z', 20, false]]);
    // a 5-minute delay is absorbed by the gap and the journey: a ends 01:50, b can leave for 02:05 but was booked for 02:00 so it is moved to 02:05 only
    expect(cascade(dayOf, 'a', 5, close).map((m) => [m.id, m.shiftedMinutes])).toEqual([['a', 5], ['b', 5], ['c', 5]]);
    // a tiny gap case: if b is already later than the earliest the officer could arrive, nothing after the delayed one moves
    const slack = [a('a', '2026-10-12T01:00:00Z', '2026-10-12T01:30:00Z', 0), a('b', '2026-10-12T03:00:00Z', '2026-10-12T03:30:00Z')];
    expect(cascade(slack, 'a', 20, close).map((m) => m.id)).toEqual(['a']);
  });
  it('flags, rather than pushes, an appointment that would end after closing and everything after it', () => {
    const moves = cascade(dayOf, 'a', 20, at('2026-10-12T03:30:00Z'));
    expect(moves.map((m) => [m.id, m.overflow])).toEqual([['a', false], ['b', false], ['c', true]]);   // c would start at 03:20 and end 04:05
  });
  it('flags only the appointments the delay actually pushes out, not the ones after that still fit', () => {
    const two = [a('x', '2026-10-12T01:00:00Z', '2026-10-12T01:30:00Z', 0), a('y', '2026-10-12T08:00:00Z', '2026-10-12T08:30:00Z')];   // 09:00 and 16:00 local
    // a delay of 8 hours sends the first past closing (17:00 local = 09:00Z), but the 16:00 is untouched
    expect(cascade(two, 'x', 480, at('2026-10-12T09:00:00Z')).map((m) => [m.id, m.overflow])).toEqual([['x', true]]);
    // with the second one now squeezed by the first's removal from the chain, it is judged on its own
    const three = [a('p', '2026-10-12T07:00:00Z', '2026-10-12T07:45:00Z', 0), a('q', '2026-10-12T08:00:00Z', '2026-10-12T08:45:00Z'), a('r', '2026-10-12T08:50:00Z', '2026-10-12T09:00:00Z', 0)];
    const moves = cascade(three, 'p', 60, at('2026-10-12T09:00:00Z'));
    expect(moves.map((m) => [m.id, m.overflow])).toEqual([['p', false], ['q', true]]);                       // q cannot fit after p; r, with no journey, is untouched and not mentioned
  });
  it('treats time off like closing: an appointment a delay would push into it is flagged, not moved', () => {
    const one = [a('t', '2026-10-12T03:00:00Z', '2026-10-12T03:30:00Z', 0)];                                // 11:00 to 11:30 local
    const off = [{ from: at('2026-10-12T04:00:00Z'), to: at('2026-10-12T05:00:00Z') }];                      // 12:00 to 13:00 local
    expect(cascade(one, 't', 45, close, off).map((m) => [m.id, m.overflow])).toEqual([['t', true]]);        // 11:45 to 12:15 would overlap
    expect(cascade(one, 't', 20, close, off).map((m) => [m.id, m.overflow])).toEqual([['t', false]]);       // 11:20 to 11:50 is clear
  });
  it('does nothing for a delay of nothing or an appointment that is not in the day', () => {
    expect(cascade(dayOf, 'a', 0, close)).toEqual([]);
    expect(cascade(dayOf, 'zzz', 30, close)).toEqual([]);
  });
});

describe('what cancelling costs', () => {
  const policy = { freeUntilHours: 24, lateFee: '25.50', noShowFee: '40' };
  const starts = at('2026-10-12T02:00:00Z');
  it('charges only a customer who cancels inside the free window, and a no-show, in exact money', () => {
    expect(feeFor(policy, { event: 'cancel', by: 'customer', startsAt: starts, now: at('2026-10-11T04:00:00Z') })).toEqual({ fee: '25.50000000', reason: 'Cancelled less than 24 hours before the appointment.' });
    expect(feeFor(policy, { event: 'cancel', by: 'customer', startsAt: starts, now: at('2026-10-10T01:00:00Z') }).fee).toBe('0.00000000');
    expect(feeFor(policy, { event: 'cancel', by: 'officer', startsAt: starts, now: at('2026-10-12T01:00:00Z') }).fee).toBe('0.00000000');
    expect(feeFor(policy, { event: 'no_show', by: 'officer', startsAt: starts, now: starts }).fee).toBe('40.00000000');
    expect(feeFor({ ...policy, lateFee: '0' }, { event: 'cancel', by: 'customer', startsAt: starts, now: at('2026-10-12T01:30:00Z') }).fee).toBe('0.00000000');
  });
});

describe('words for people', () => {
  it('writes a time in the person\'s zone without anything a phone-number filter would take for a number', () => {
    expect(whenText(at('2026-10-15T06:35:00Z'), KL)).toBe('Thu 15 Oct, 14:35');
    const all = (['booked', 'moved', 'delayed', 'cancelled', 'reminder', 'needs_new_time', 'fee'] as const).flatMap((k) => (['customer', 'officer'] as const).map((f) => messageFor(k, { when: 'Thu 15 Oct, 14:35', was: 'Thu 15 Oct, 14:00', where: 'at the Cheras branch', minutes: 35, fee: '25.5', currency: 'MYR', for: f })));
    for (const m of all) expect(redactNumbers(m)).toBe(m);
    expect(messageFor('delayed', { when: 'Thu 15 Oct, 14:35', was: 'Thu 15 Oct, 14:00', where: 'at the Cheras branch', minutes: 35, for: 'customer' })).toContain('delayed by 35 minutes');
  });
});
