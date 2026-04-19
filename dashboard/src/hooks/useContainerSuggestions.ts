/** Contextual suggestions for the palette (M23 — ζ).
 *
 * Reads three manifests from the active container's WORKDIR in
 * parallel and turns each entry into a palette command. Every
 * manifest's read is wrapped individually so a missing or malformed
 * file does not suppress the whole set.
 *
 * Payload shape matches what ``CommandPalette`` already renders — the
 * suggestions merge into the existing cmdk pipeline as a new group.
 */

import { useQuery } from "@tanstack/react-query";
import { parse as parseToml } from "smol-toml";

import { readContainerFile } from "../lib/api";

export interface ContainerSuggestion {
  id: string;
  title: string;
  subtitle: string;
  /** The raw shell command to pre-type into the PTY. */
  command: string;
  /** Where it came from — surfaces in the subtitle. */
  source: "package.json" | "pyproject.toml" | "Makefile";
}

async function readOrNull(id: number, path: string): Promise<string | null> {
  try {
    const res = await readContainerFile(id, path);
    return typeof res.content === "string" ? res.content : null;
  } catch {
    return null;
  }
}

function suggestionsFromPackageJson(content: string): ContainerSuggestion[] {
  try {
    const parsed = JSON.parse(content) as { scripts?: Record<string, string> };
    const scripts = parsed.scripts ?? {};
    return Object.entries(scripts).map(([name, cmd]) => ({
      id: `sugg:npm:${name}`,
      title: `Run npm: ${name}`,
      subtitle: `${cmd} — package.json`,
      command: `npm run ${name}`,
      source: "package.json" as const,
    }));
  } catch {
    return [];
  }
}

function suggestionsFromPyproject(content: string): ContainerSuggestion[] {
  let doc: unknown;
  try {
    doc = parseToml(content);
  } catch {
    return [];
  }
  const out: ContainerSuggestion[] = [];
  const obj = (doc ?? {}) as Record<string, unknown>;
  const projectScripts = ((obj.project as Record<string, unknown> | undefined)?.scripts ??
    {}) as Record<string, string>;
  const poetryScripts = ((
    (obj.tool as Record<string, unknown> | undefined)?.poetry as Record<string, unknown> | undefined
  )?.scripts ?? {}) as Record<string, string>;
  const seen = new Set<string>();
  for (const [name, cmd] of Object.entries({ ...projectScripts, ...poetryScripts })) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      id: `sugg:py:${name}`,
      title: `Run python: ${name}`,
      subtitle: `${cmd} — pyproject.toml`,
      command: name,
      source: "pyproject.toml",
    });
  }
  return out;
}

function suggestionsFromMakefile(content: string): ContainerSuggestion[] {
  const targets = new Set<string>();
  for (const raw of content.split(/\r?\n/)) {
    // Reject lines that start with whitespace (recipe body) or `.` or `#`.
    if (!raw || raw.startsWith("\t") || raw.startsWith(" ")) continue;
    if (raw.startsWith("#") || raw.startsWith(".")) continue;
    const m = raw.match(/^([A-Za-z0-9_-]+):(\s|$)/);
    if (!m) continue;
    const name = m[1];
    targets.add(name);
  }
  return Array.from(targets).map((name) => ({
    id: `sugg:make:${name}`,
    title: `make ${name}`,
    subtitle: "Makefile",
    command: `make ${name}`,
    source: "Makefile" as const,
  }));
}

export function useContainerSuggestions(
  containerId: number | null,
  workdir: string,
): ContainerSuggestion[] {
  const query = useQuery({
    queryKey: ["suggestions", containerId, workdir],
    enabled: containerId !== null && workdir.length > 0,
    staleTime: 60_000,
    gcTime: 300_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const id = containerId as number;
      const [pkg, py, mk] = await Promise.all([
        readOrNull(id, `${workdir.replace(/\/$/, "")}/package.json`),
        readOrNull(id, `${workdir.replace(/\/$/, "")}/pyproject.toml`),
        readOrNull(id, `${workdir.replace(/\/$/, "")}/Makefile`),
      ]);
      const out: ContainerSuggestion[] = [];
      if (pkg) out.push(...suggestionsFromPackageJson(pkg));
      if (py) out.push(...suggestionsFromPyproject(py));
      if (mk) out.push(...suggestionsFromMakefile(mk));
      return out;
    },
  });

  return query.data ?? [];
}
