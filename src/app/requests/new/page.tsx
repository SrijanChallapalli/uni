import { RequestComposer } from "@/components/RequestComposer";
import { pageProfile } from "@/lib/auth";
import { unitsToDollarString } from "@/lib/money";
import { toCampusLocal } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function NewRequest() {
  const { profile } = await pageProfile();
  const now = Date.now();
  const round = (ms: number) => new Date(Math.ceil(ms / (15 * 60000)) * 15 * 60000);
  return (
    <div>
      <h1 className="text-2xl font-bold">Request a pickup</h1>
      <p className="muted mt-1">Prepaid store orders only for now. Your agent structures the request; you confirm every detail.</p>
      <div className="mt-4">
        <RequestComposer defaults={{
          maxFee: unitsToDollarString(profile.default_budget_units),
          start: toCampusLocal(round(now + 30 * 60000)),
          end: toCampusLocal(round(now + 90 * 60000)),
          deadline: toCampusLocal(round(now + (90 + profile.default_deadline_buffer_min) * 60000)),
        }} />
      </div>
    </div>
  );
}
