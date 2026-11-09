import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { one, q } from "@/lib/db";
import { deriveCode } from "@/lib/handoff";
import { handleAgentMessage } from "@/lib/services/assistant";
import { createTask } from "@/lib/services/lifecycle";
import type { Offer, Payment, Profile, Task } from "@/lib/types";
import { cleanup, clock, endPool, mkProfile, mkTrip, taskInput } from "./helpers";

const at = clock();
const $ = (d: number) => Math.round(d * 100) * 10_000;
const profile = async (id: string) => (await one<Profile>("select * from profiles where id = $1", [id]))!;
const say = async (id: string, text: string, taskId: string | null = null) => handleAgentMessage(await profile(id), text, taskId);
const lastReply = async (id: string) => (await one<{ body: string; data: { proposal?: { kind: string } } }>(
  "select body, data from agent_messages where profile_id = $1 and role = 'agent' order by id desc limit 1", [id]))!;
const thread = async (id: string) => (await q<{ body: string }>("select body from agent_messages where profile_id = $1 and role = 'agent' order by id", [id])).map((m) => m.body).join("\n");
const task = async (id: string) => (await one<Task>("select * from tasks where id = $1", [id]))!;
const payment = async (id: string) => one<Payment>("select * from payments where task_id = $1 order by created_at desc limit 1", [id]);

beforeEach(cleanup);
afterAll(async () => { await cleanup(); await endPool(); });

async function scenario() {
  const riley = await mkProfile("riley", { transport: "walk", capacity: "small" });
  const maya = await mkProfile("maya", { minFee: $(3) });
  const nia = await mkProfile("nia", { minFee: $(6.5), detour: 60, transport: "bus", capacity: "medium" });
  const mayaTrip = await mkTrip(maya, at);
  await mkTrip(nia, at, { transport: "bus", capacity: "medium" });
  await q("update trips set auto_accept = true where id = $1", [mayaTrip]);
  const taskId = await createTask(riley, taskInput(at)); // $5 opening, $7 max
  return { riley, maya, nia, taskId };
}

describe("people only give instructions; agents do the rest", () => {
  it("runs the whole job from a few short commands", async () => {
    const { riley, maya, nia, taskId } = await scenario();

    await say(riley, "find someone");
    const rec = await lastReply(riley);
    expect(rec.body).toMatch(/Best fit: test:maya at \$5\.00/i);
    expect(rec.data.proposal?.kind).toBe("hire");

    // Nia's agent negotiated with Riley's agent over several rounds, inside Riley's max.
    const niaOffer = (await one<Offer>("select * from offers where task_id = $1 and worker_id = $2 order by created_at desc limit 1", [taskId, nia]))!;
    expect(niaOffer.transcript.length).toBeGreaterThan(3);
    expect(Number(niaOffer.fee_units)).toBe($(6.5));
    expect(niaOffer.transcript.every((t) => t.feeUnits <= $(7) || t.from === "worker_agent")).toBe(true);
    expect(JSON.stringify(niaOffer.transcript)).not.toMatch(/minimum/i); // worker's private floor never shown to the other side

    // One "do it": Riley's approval + Maya's standing instruction + authorized funding.
    await say(riley, "do it");
    expect((await task(taskId)).status).toBe("agreed");
    expect((await payment(taskId))?.status).toBe("funded");
    const via = await one<{ via: string }>("select via from agreement_approvals ap join agreements a on a.id = ap.agreement_id where a.task_id = $1 and ap.profile_id = $2", [taskId, maya]);
    expect(via?.via).toBe("mandate");
    expect(await thread(maya)).toMatch(/I accepted .* \$5\.00/);

    await say(maya, "picked up");
    expect((await task(taskId)).status).toBe("picked_up");
    const salt = (await one<{ salt: string }>("select salt from handoff_codes where task_id = $1", [taskId]))!.salt;
    const code = deriveCode(taskId, salt);
    expect(await thread(riley)).toContain(code); // Riley's agent handed Riley the code

    await say(maya, "code 000000");
    expect((await task(taskId)).status).toBe("picked_up");
    await say(maya, `code ${code}`);
    expect((await task(taskId)).status).toBe("handed_off");

    await say(riley, "got it");
    expect((await task(taskId)).status).toBe("completed");
    expect((await payment(taskId))?.status).toBe("released");

    await say(riley, "5 stars, super fast");
    await say(maya, "5 stars");
    expect((await q("select 1 from reviews where task_id = $1", [taskId])).length).toBe(2);
  });

  it("asks the worker when there is no standing instruction, then funds what the requester authorized", async () => {
    const { riley, nia, taskId } = await scenario();
    await say(riley, "find someone");
    await say(riley, "hire nia");
    expect((await task(taskId)).status).toBe("negotiating");
    expect((await lastReply(nia)).data.proposal?.kind).toBe("approve");
    expect(await payment(taskId)).toBeNull();

    await say(nia, "do it");
    expect((await task(taskId)).status).toBe("agreed");
    const pay = await payment(taskId);
    expect(pay?.status).toBe("funded");
    expect(Number(pay?.amount_units)).toBe($(6.5));
  });

  it("a yes only ever answers that person's own agent, and only its latest suggestion", async () => {
    const { riley, maya, nia, taskId } = await scenario();
    await say(riley, "find someone");
    // Nia saying "do it" can't hire anyone on Riley's behalf.
    await say(nia, "do it");
    expect((await lastReply(nia)).body).toMatch(/nothing waiting/i);
    expect((await task(taskId)).status).toBe("open");
    // Maya can't release or fund anything.
    await say(maya, "got it");
    expect((await task(taskId)).status).toBe("open");
    // Once Riley's latest agent message is something else, an old suggestion can't be confirmed.
    await say(riley, "status");
    await say(riley, "help");
    await say(riley, "do it");
    expect((await task(taskId)).status).toBe("open");
  });

  it("does not auto-fund more than the requester authorized", async () => {
    const { riley, nia, taskId } = await scenario();
    await say(riley, "find someone");
    await say(riley, "hire nia"); // authorizes exactly $6.50
    await q("update tasks set fund_authorized_units = $2 where id = $1", [taskId, $(6)]); // pretend only $6 was authorized
    await say(nia, "do it");
    expect((await task(taskId)).status).toBe("agreed");
    expect((await payment(taskId))?.status).toBe("awaiting_funding");
  });
});
