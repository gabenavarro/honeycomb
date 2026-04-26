import { ListChecks } from "lucide-react";

import { tryParse } from "./_partialJson";
import { ToolBlockChrome } from "./ToolBlockChrome";

interface TodoItem {
  content: string;
  activeForm: string;
  status: "pending" | "in_progress" | "completed";
}

interface Props {
  block: {
    id: string;
    tool: string;
    input: Record<string, unknown>;
    partialJson: string;
    complete: boolean;
  };
}

export function MessageToolTodo({ block }: Props) {
  const parsed = tryParse(block.partialJson) ?? block.input;
  const todos = (parsed.todos as TodoItem[] | undefined) ?? [];
  return (
    <ToolBlockChrome
      icon={<ListChecks size={11} />}
      name="TodoWrite"
      target={`${todos.length} item${todos.length === 1 ? "" : "s"}`}
      accent="text-todo"
      borderAccent="border-todo/30"
      complete={block.complete}
    >
      <ul className="space-y-1 text-[12px]">
        {todos.map((t, i) => {
          const symbol = t.status === "completed" ? "☑" : t.status === "in_progress" ? "▶" : "☐";
          const cls =
            t.status === "completed"
              ? "text-muted line-through"
              : t.status === "in_progress"
                ? "text-think"
                : "text-primary";
          return (
            <li key={i} className={cls}>
              <span className="mr-2 font-mono">{symbol}</span>
              {t.status === "in_progress" ? t.activeForm : t.content}
            </li>
          );
        })}
      </ul>
    </ToolBlockChrome>
  );
}
