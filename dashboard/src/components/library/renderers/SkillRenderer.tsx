/** Skill artifact renderer (M35).
 *
 * Splits a leading YAML frontmatter block (--- ... ---) from the body,
 * displays the skill name + description from frontmatter (or falls back
 * to metadata / artifact.title), then renders the rest as Markdown.
 *
 * Auto-source (linking to live skill files) ships in a future milestone.
 */
import type { Artifact } from "../../../lib/types";
import { TYPE_ICON } from "../../../lib/artifact-meta";
import { MarkdownBody } from "./MarkdownBody";

interface Frontmatter {
  name?: string;
  description?: string;
  [key: string]: unknown;
}

interface SplitResult {
  frontmatter: Frontmatter;
  rest: string;
}

/** Parse a leading `---\n...\n---\n` block from raw markdown. */
function splitFrontmatter(body: string): SplitResult {
  if (!body.startsWith("---\n")) {
    return { frontmatter: {}, rest: body };
  }
  const end = body.indexOf("\n---\n", 4);
  if (end === -1) {
    return { frontmatter: {}, rest: body };
  }
  const block = body.slice(4, end);
  const rest = body.slice(end + 5); // skip closing ---\n

  const frontmatter: Frontmatter = {};
  for (const line of block.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line
      .slice(colonIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key) frontmatter[key] = value;
  }

  return { frontmatter, rest };
}

interface Props {
  artifact: Artifact;
}

export function SkillRenderer({ artifact }: Props) {
  const { frontmatter, rest } = splitFrontmatter(artifact.body);

  const skillName =
    (artifact.metadata?.skill_name as string | undefined) ??
    (frontmatter.name as string | undefined) ??
    artifact.title;

  const description = frontmatter.description as string | undefined;

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <header className="border-edge-soft border-b pb-2">
        <div className="flex items-center gap-2">
          <span className="text-claude font-mono text-[14px]" aria-hidden="true">
            {TYPE_ICON.skill}
          </span>
          <h1 className="text-primary text-[18px] font-semibold">{skillName}</h1>
        </div>
        {description && <p className="text-secondary mt-1 text-[12px]">{description}</p>}
        <p className="text-muted mt-1 text-[11px]">
          Skill · saved {new Date(artifact.created_at).toLocaleString()}
        </p>
      </header>
      {rest.trim() && <MarkdownBody source={rest} />}
    </div>
  );
}
