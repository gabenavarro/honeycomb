import type { ChatBlock } from "../types";
import { MessageToolBash } from "./MessageToolBash";
import { MessageToolEdit } from "./MessageToolEdit";
import { MessageToolGeneric } from "./MessageToolGeneric";
import { MessageToolRead } from "./MessageToolRead";
import { MessageToolTask } from "./MessageToolTask";
import { MessageToolTodo } from "./MessageToolTodo";
import { MessageToolWrite } from "./MessageToolWrite";

type ToolBlock = Extract<ChatBlock, { kind: "tool_use" }>;

const REGISTRY: Record<string, React.FC<{ block: ToolBlock }>> = {
  Bash: MessageToolBash,
  Edit: MessageToolEdit,
  MultiEdit: MessageToolEdit,
  Read: MessageToolRead,
  Write: MessageToolWrite,
  Task: MessageToolTask,
  TodoWrite: MessageToolTodo,
};

export function renderToolBlock(block: ToolBlock): React.ReactNode {
  const Cmp = REGISTRY[block.tool] ?? MessageToolGeneric;
  return <Cmp block={block} />;
}
