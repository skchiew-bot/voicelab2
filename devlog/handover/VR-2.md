# Handover: VR-2, voice link hardening (branch `claude/phase-1-voice-relay-hardening`)

The previous session stopped at its cost budget (stop-loss). The branch is pushed, with 809 tests passing and the typecheck clean.
It fixes the re-check findings on PR #31: standby re-check timer, no run after a fallback, stuck reply ended at once,
and the standby's first answer. Its independent review then found these issues. Verify each one against the code, fix
the real ones, re-run the review, then open the PR to `main` with findings and outcomes. The owner merges.

1. **High.**
   - A (starting the call) drops and Twilio reconnects as B. B stands by, and `relay_owner` stays A.
   - A's start finishes and writes the run, then A's `closeRelay` abandons it.
   - B adopts an abandoned run and sends a plain `end`: silence, no holding line, no callback.
   - The same thing happens when B resumes an already abandoned run (`openRelay` resume, ended branch).
   - Fix: adopting or resuming a run this session never served that ended `abandoned` (or with an error) while the call is open goes to `failed()`. Or: register the standby under the calls lock, so `closeRelay` does not abandon while a standby exists.
   - Test: two real WebSockets, A closes during a slow start (injected integration delay).
2. **Medium.** `app.ts` standby timer `.catch(() => undefined)` swallows errors. Fall back as the message path does.
3. **Medium.** The standby timer can be re-armed after the socket closes (leak), and a closed connection could `adopt`. Add a `closed` flag checked before `standbyCheck`, before re-arming, and in `adopt`.
4. **Medium.** The standby waits about 61 s before taking over. Poll every 2–5 s, and keep the 60 s grace only for the "died" verdict.
5. **Medium.**
   - On a standby, the caller's words said before they heard the question (it went to the dead socket) are applied as the answer. "Yes" could become consent to a question never heard.
   - Fix: on adoption from a prompt, repeat the last line instead of applying the words. Update the "answer" branch of the takeover test.
6. **Medium (suspicion).** A standby adopting a run that ended with an error sends a plain end. Select `error` and route it to `failed()`, as `afterTurn` does.
7. **Low.** The standby's "over" verdict sends only `end`. Send the holding line first, since it probably went to a dead socket.
8. **Low.**
   - The repeated last line is sent as plain text, skipping recordings.
   - Only one `say` is repeated.
   - The line and the status are read in two separate transactions.
   - Fix: rebuild from `payload.segments`/`lang` through `say()`, in one transaction.
9. **Low.** When `failed()` abandons a `processing` run, mark the abandon step `{ interrupted: 'reply_in_flight' }` (an L-002 visibility issue).
10. **Missing tests.**
    - The `askedAt` change in `app.ts` (`session?.runId ? … : undefined`).
    - Standby wiring over a real WebSocket, timer cleared on close, and the timer error path.
    - `failed()` cutting off a real in-flight reply.
    - Standby adopting a run that was abandoned or ended with an error.

The reviewer found no lock-order deadlock: `calls` is locked before `workflow_runs` everywhere.
