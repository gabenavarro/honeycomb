/** Subagent result artifact renderer (M35).
 *
 *  A Task tool dispatch — the body is the prompt sent to the subagent;
 *  metadata.result_summary is the subagent's final response. Renders
 *  as a two-bubble mini-thread.
 */
import type { Artifact } from "../../../lib/types";
import { MarkdownBody } from "./MarkdownBody";

interface Props {
  artifact: Artifact;
}

export function SubagentRenderer({ artifact }: Props) {
  // Backend writes metadata.subagent_type (round-trips Anthropic's Task
  // tool input field). See hub/services/chat_stream_artifact_hooks.py.
  const agentType = (artifact.metadata?.subagent_type as string | undefined) ?? "agent";
  const resultSummary = artifact.metadata?.result_summary as string | undefined;
  const parentChatId = artifact.metadata?.parent_chat_id as string | undefined;

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <header className="border-edge-soft border-b pb-2">
        <h1 className="text-primary text-[15px] font-semibold">{artifact.title}</h1>
        <p className="text-secondary mt-1 text-[11px]">
          Task → <span className="text-task font-mono">{agentType}</span>
          {parentChatId && (
            <span className="text-muted ml-2">from chat {parentChatId.slice(0, 8)}</span>
          )}
        </p>
        <p className="text-muted mt-1 text-[10px]">
          Subagent · {new Date(artifact.created_at).toLocaleString()}
        </p>
      </header>

      <section>
        <h2 className="text-muted mb-1 text-[10px] font-semibold tracking-wider uppercase">
          Prompt
        </h2>
        <pre className="border-edge-soft bg-input text-primary rounded border px-3 py-2 font-mono text-[11.5px] break-words whitespace-pre-wrap">
          {artifact.body}
        </pre>
      </section>

      {resultSummary && (
        <section>
          <h2 className="text-muted mb-1 text-[10px] font-semibold tracking-wider uppercase">
            Result
          </h2>
          <div className="border-edge-soft bg-card rounded border px-3 py-2">
            <MarkdownBody source={resultSummary} />
          </div>
        </section>
      )}
    </div>
  );
}
