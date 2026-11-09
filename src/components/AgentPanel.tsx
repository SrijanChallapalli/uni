import { agentMessageAction } from "@/app/actions";
import { agentThread } from "@/lib/services/assistant";
import type { Profile } from "@/lib/types";
import { AgentChat } from "./AgentChat";

/** Server wrapper: loads this person's conversation with their agent. */
export async function AgentPanel({ profile, taskId = null }: { profile: Profile; taskId?: string | null }) {
  const msgs = await agentThread(profile.id);
  const lastAgent = [...msgs].reverse().find((m) => m.role === "agent");
  const suggestions = lastAgent?.data.suggest?.length ? lastAgent.data.suggest : ["Status", "Help"];
  return (
    <AgentChat
      action={agentMessageAction.bind(null, taskId)}
      messages={msgs.map((m) => ({ id: Number(m.id), role: m.role, body: m.body }))}
      suggestions={suggestions}
      placeholder='e.g. "Get my Target order to Windsor by 7, up to $7"'
    />
  );
}
