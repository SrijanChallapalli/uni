# Detour: campus errands with personal agents and escrow

**Get your errands done. Earn money from trips you're already taking.**

Detour is a hackathon MVP for Purdue students, starting with **prepaid store pickups**. Each student has a personal agent they **just tell what to do** ("get my Target order to Windsor by 7, up to $7", "I'm driving to Target at 5", "do it", "picked up", "got it"). The agents handle the rest. A requester's agent negotiates with the workers' agents, over several rounds, inside limits each person set. Both sides approve the same agreement version: the requester by saying yes, the worker by saying yes or through a standing auto-accept rule on their trip. Only the **delivery fee** goes into escrow (the order is already prepaid). It is released after a one-time handoff code is verified.

> ⚠️ **Hackathon rules not verified.** I could not find the official rules or build window for the event this targets: no Purdue hackathon page lists QuickNode / Arc / ElevenLabs / Grok as sponsors. Check the official rules before submitting, especially whether pre-event code is allowed.

## What works (verified)

| Flow step | Status | Evidence |
|---|---|---|
| Whole job driven by chat commands only (find → "do it" → "picked up" → code → "got it" → "5 stars") | ✅ | `tests/integration/autopilot.test.ts`, browser run |
| Agent-to-agent multi-round negotiation inside each side's private limits | ✅ | `tests/unit/negotiation.test.ts`, autopilot test |
| Request → agent matching → offers | ✅ | `tests/integration/flow.test.ts`, browser run |
| Requester approves → worker approves the **same version** → assignment | ✅ | flow + version tests, browser run |
| Escrow funding → pickup → handoff code → release → reviews | ✅ (simulated escrow) | flow test, browser run |
| Same flow with **real escrow transactions** (local anvil chain) | ✅ | `tests/integration/chain.test.ts` |
| Payment status driven by a **Streams-shaped signed webhook** | ✅ locally, ❌ not yet with live QuickNode | chain test (webhook route + HMAC + replay + dedupe) |
| Reconciliation recovers a missed stream event | ✅ | chain test |
| Cancellation (refund, request reopens) and dispute (freeze → resolver) | ✅ | flow test, browser (resolver refund) |
| Row-level security with real Supabase Auth sessions | ✅ | `tests/integration/rls.test.ts` |
| Arc Testnet deployment, live QuickNode Stream | ⛔ **blocked**: needs a funded test key and QuickNode credentials | see [Sponsor matrix](#sponsor-integration-matrix) |

## Stack and key decisions

- **Next.js 15 (App Router) + TypeScript + Tailwind v4**, mobile-first.
- **Supabase Auth + Postgres** with SQL migrations (`supabase/migrations`). All writes go through server actions on a server-only Postgres connection. RLS gives browser clients **read-only, row-scoped** access and no write policies.
- **LLM agents** (Anthropic Messages API, forced tool call, zod-validated). With no `ANTHROPIC_API_KEY` set, a **clearly labeled rules-based agent** produces the same structured outputs. That is what ran in the tests and the browser verification.
- **Chain: Arc Testnet**, not Solana. QuickNode's [supported-chains table](https://www.quicknode.com/docs/streams/supported-chains) lists **Arc Testnet** with every Streams dataset (including receipts and logs). Solana Devnet shows only Block and Program logs. I also checked the network itself (`cast` against `https://rpc.testnet.arc.network`): chain id **5042002**, USDC ERC-20 interface at `0x3600…0000` with **6 decimals**. USDC-native accounting matches the "show dollar amounts" requirement, and EVM/Solidity matches your existing stack (Hunch). Only Arc is implemented.
- **Money**: integer token units everywhere (`$1.00 = 1_000_000`), checked with `Number.isSafeInteger`.

## Run it

Prerequisites: Node 22+, Docker, Foundry (`forge`, `anvil`).

```bash
npm install
```

```bash
npm run db:start
```

```bash
cp .env.example .env.local
```

Fill `.env.local`: copy `ANON_KEY` from `npx supabase status` into `NEXT_PUBLIC_SUPABASE_ANON_KEY`, set random 32+ character values for `DEMO_COOKIE_SECRET`, `HANDOFF_SECRET` and `OPS_TOKEN`, and keep `DEMO_MODE=true` and `ESCROW_MODE=simulated`.

```bash
npm run seed
```

```bash
npm run dev
```

Open http://localhost:3000 and pick a demo persona. The local Supabase stack uses ports 55321 (API) and 55322 (DB) so it doesn't collide with other local Supabase projects.

### Checks

```bash
npm run typecheck && npm run lint && npm test && npm run test:contracts && npm run build
```

`npm test` needs the local Supabase stack running and `contracts/out` built (`npm run contracts:build`). The chain test starts its own `anvil` on port 8546.

## Demo walkthrough (about 3 minutes)

All personas are fictional and flagged `is_demo`. They only ever match each other. **Reset demo data** on the home page restores the scenario (it only works when `DEMO_MODE=true`). Switch personas from the menu in the yellow demo banner: you stay on the same page. Task, dashboard and jobs pages refresh every few seconds, so you can also run two browser windows side by side. The home page has the same script under *Demo script*.

Everything runs from the **Your agent** chat on the dashboard. The buttons on each task page still work if you prefer clicking.

1. **Riley (demo requester).** Her agent says the Target → Windsor request is posted ($5 opening, $7 max). Say **"find someone"**. Riley's agent negotiates with each feasible worker's agent. **Sam** is filtered (he gets to the store after the pickup window). **Maya** accepts $5. **Nia** privately wants at least $6.50, so the agents go back and forth: $5 → she asks $6.50 → Riley's agent offers $5.75 → she holds at $6.50 → Riley's agent accepts (still under the $7 max). The agent recommends Maya and explains why. Open the task page to see each negotiation transcript.
2. Say **"do it"**. That one yes approves the terms and authorizes exactly $5.00 for escrow. Maya's trip has a standing rule (auto-accept jobs ≥ her $3 minimum within her 30-minute detour limit), so her agent approves the same version. Feasibility is rechecked with the trip row locked, the job is assigned, and Riley's agent funds escrow. Riley's agent reports: "Done. Maya's agent accepted, and $5.00 is in escrow."
3. Switch to **Maya**. Her agent tells her what it accepted and that the fee is in escrow. Say **"picked up"**. Riley's agent now gives Riley the one-time handoff code.
4. **Maya:** say **"code 000000"** (rejected, attempts counted), then **"code <Riley's code>"**. Handoff verified.
5. **Riley:** say **"got it"**. The payment is released. Then say **"5 stars, super fast"**.
6. Variants: **"hire nia"** instead of "do it". Nia has no standing rule, so *her* agent asks her ("Say 'do it' to accept"). When she says yes, Riley's agent funds the $6.50 Riley authorized. Workers can post trips by chat ("I'm driving to Target at 5 from Cary, back by 7") and say **"ask me first"** to turn off auto-accept. **"status"** works for anyone at any time.
7. **Dispute example:** **Detour Ops (demo resolver)** → *Disputes* → Theo vs Sam ($6 frozen) → *Pay worker* or *Refund requester*. **Cancellation example:** Theo's CVS request (cancelled before assignment, no money moved). Live variant: as the worker after funding, *Cancel this job* refunds the requester, reopens the request, and counts against the worker's cancellations.

## How it fits together

```
src/lib/matching.ts        deterministic feasibility, effort estimate, fee bounds, ranking
src/lib/agents/            requester.ts (parse / recommend), worker.ts (accept / counter / reject), negotiation.ts,
                           assistant.ts (command → intent), llm.ts
src/lib/services/assistant.ts  executes chat instructions through the normal services
src/lib/services/autopilot.ts  worker auto-accept rule, capped auto-funding, hire
src/lib/agreement.ts       terms, canonical hash, material-change detection, dual-approval check
src/lib/escrow/state.ts    payment state machine (confirmed status ≠ pending submission)
src/lib/escrow/adapter.ts  simulated adapter + Arc/EVM adapter (viem, server-side keys)
src/lib/streams/           webhook HMAC verification, payload extraction, local relay builder
src/lib/services/          matching, agreements, payments (idempotent ingestion), lifecycle
contracts/src/TaskEscrow.sol  fund / release / refund / dispute / resolve / resolveByTimeout
streams/filter.js          QuickNode Streams filter (block_with_receipts → escrow logs only)
supabase/migrations/       schema, constraints, RLS
```

**What the LLM does and doesn't decide.** Deterministic code handles feasibility (store, window, deadline, capacity by size and transport, new-worker limit, max detour, schedule conflicts, one task per trip), money bounds, authorization and every state transition. The LLM only interprets free text into enum-constrained fields, picks accept/counter/reject **inside** computed fee bounds, and writes short explanations. Every output is validated. Anything invalid falls back to the rules agent. Task text is wrapped as untrusted data, and instruction-like text is flagged. Agents can't approve or move money.

**Personal agents take instructions, not open-ended authority.** A message is classified into one intent (rules, or a validated LLM tool call), and the matching service carries it out with all its usual checks. "Yes" only answers that person's *own* agent's latest suggestion, within 2 hours. Spending authority is explicit and capped: "do it" on a hire authorizes funding of exactly that fee (`tasks.fund_authorized_units`). If the terms change to more than that, the agent won't fund. A worker's auto-accept is a per-trip opt-in, limited to their own minimum fee and detour limit, and recorded as `via = 'mandate'` on the approval.

**Agent-to-agent negotiation is bounded** (`src/lib/agents/negotiation.ts`): the requester's agent opens below the max (the max stays private). The worker's agent accepts, counters (within computed bounds) or declines. The requester's agent accepts small gaps, meets in the middle on bigger ones, offers its max once, then walks away. There are at most 3 worker turns, a worker's ask can never rise, and the requester side can never exceed the max. Each side sees only offers, never the other's limits. The full transcript is stored on the offer and shown on the task page.

**Effort estimate:** added travel compared with the worker's existing route, plus a 4–10 min pickup wait, a 2–5 min handoff, 25% travel uncertainty and a buffer. It is shown as a range, with total trip time shown separately. Travel times are **fixture estimates** for seeded campus locations, labeled in the UI, and never presented as live traffic.

**Concurrency:** the task row is locked (`FOR UPDATE`) during selection and approval. Partial unique indexes enforce one live agreement per task, one active assignment per task, one active assignment per trip, and one live payment per task. Tests cover concurrent approvals of two tasks on one trip, duplicate approvals, and stale offers.

**Payment state machine** (`status` changes only on confirmed events, while `pending_action` tracks submissions):

| Event | From | To |
|---|---|---|
| Funded | awaiting_funding | funded |
| Released | funded | released |
| Refunded | funded, disputed | refunded |
| Disputed | funded | disputed |
| Resolved(toWorker) | disputed | released / refunded |

An event that's already applied counts as a **duplicate** (no-op). An impossible order is **invalid** and recorded but not applied. A reorged log (`removed`) is ignored. The dedupe key is `contract:txHash:logIndex`, shared by Streams, the relay and reconciliation. The contract rejects double funding, double release and double refund on-chain too (Foundry tests).

**Handoff code:** a 6-digit code derived as HMAC(server secret, task, salt) so the requester can view it again. The database stores only an HMAC of the code. Verification happens server-side: 5 attempts, then a 15-minute lock, and the code is single-use.

### Trust assumptions (also shown in the app)

- **Custodial demo signer.** In `arc_testnet` mode the app's platform key funds and releases escrow *on the requester's explicit in-app authorization*. Users don't hold wallets yet (see roadmap item 9). Keys are server-only env vars.
- **Centralized resolver.** "Detour Ops", operated by the app team, decides disputes and can refund the payer while funds are held. It can never pay anyone except the recorded worker or payer. If it misses the 72h deadline, **anyone** can call `resolveByTimeout` on-chain to refund the requester.
- **Auto-release.** If a handoff code is verified and the requester does nothing for 24h, the app releases the fee.
- **Disclosed limit of the handoff code.** It confirms receipt, not contents, and doesn't eliminate disputes.
- Exact addresses, order numbers, schedules, messages and dispute text stay off-chain. On-chain ids are opaque hashes.

## QuickNode Streams

The webhook is `POST /api/streams/quicknode`. Setup, the filter, and an example payload are in [`streams/README.md`](streams/README.md).

## Sponsor integration matrix

| Sponsor / track | Status | Notes |
|---|---|---|
| Consumer Apps | **Live (local)** | Full persisted flow, mobile-first UI, verified in browser |
| Arc (chain award) | **Built, live testnet blocked** | `TaskEscrow.sol` + adapter tested on anvil. Testnet deploy needs a funded test key (`forge script script/Deploy.s.sol`). The faucet wasn't used: it needs a person |
| QuickNode Streams | **Interface complete; simulated source live; QuickNode live blocked** | Auth, replay protection, filter, idempotent processing and reconciliation are tested with real chain logs. Needs a QuickNode account + Stream on Arc Testnet + a public webhook URL |
| Anthropic (agent LLM) | **Implemented, not exercised** | No API key in this environment. Rules agent used (labeled). Set `ANTHROPIC_API_KEY` to enable |
| ElevenLabs voice | **Planned (stretch)** | Not started. Core flow first, as instructed. The text flow is complete |
| Grok Bot | **Not implemented** | Bounty requirements unverified. A Grok model API alone may not qualify |
| Solana | **Not implemented (by design)** | One chain only |
| Gemini prediction markets | **Excluded** | Out of scope by instruction |

## Precise remaining limitations

- No live Arc Testnet transaction and no live QuickNode Stream yet (credentials and test funds). Live claims above are limited to what's in the table.
- The LLM agent path is untested against the real API (no key). The validation and fallback logic is unit-tested.
- Local email sign-in: Mailpit is excluded from the local stack to avoid a large image pull, so magic-link emails aren't viewable locally. Verified-badge logic is tested with real Supabase users created through the admin API. Hosted Supabase sends real emails.
- Matching runs when the requester asks ("find someone", or a new request by chat). A newly posted trip doesn't trigger matching against already-open requests, and there are no push alerts. Agents report through the in-app chat and notifications.
- The rules-based command parser understands common phrasings only (see `tests/unit/assistant.test.ts`). Unusual wording gets a help reply. With an `ANTHROPIC_API_KEY`, an LLM routes the message instead, still validated against a fixed intent list.
- With several active items at once, "cancel" asks you to open the item first, and other commands act on the most recent matching item.
- Timeouts (auto-release, resolver timeout) run lazily on task page loads and through `POST /api/ops/timeouts` (`Authorization: Bearer $OPS_TOKEN`). No cron is configured.
- Fixture travel times only. No routing API.
- One task per trip (bundling is roadmap item 1). One campus. Prepaid pickups only.
- Review reveal and reputation are computed in a SQL view, not cached.
- The hackathon rules and build-window check above is unresolved.

## Roadmap

See [`ROADMAP.md`](ROADMAP.md). Nothing in it is implemented.
