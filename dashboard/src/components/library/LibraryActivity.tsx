/** Library activity (M35 T13) — top-level shell wiring sidebar (chips +
 * scope + search + cards) into the main pane (per-type renderer dispatch).
 *
 * Fleet scope is intentionally simplified for M35: when scope === "fleet"
 * we render an empty list, because fanning out N useArtifacts calls
 * would violate React's rules-of-hooks (the count would vary across
 * renders). Full multi-container fan-out is deferred (TODO M35.x).
 */
import { ChevronLeft } from "lucide-react";
import { useMemo, useState } from "react";

import { useArtifacts } from "../../hooks/useArtifacts";
import { useIsPhone } from "../../hooks/useMediaQuery";
import type { Artifact, ArtifactType, ContainerRecord } from "../../lib/types";
import { ArtifactCard } from "./ArtifactCard";
import { FilterChips } from "./FilterChips";
import { ScopeToggle, type LibraryScope } from "./ScopeToggle";
import { SearchInput } from "./SearchInput";
import { renderArtifact } from "./renderers/dispatch";

interface Props {
  containers: ContainerRecord[];
  activeContainerId: number | null;
  onSelectContainer: (id: number) => void;
}

export function LibraryActivity({ containers, activeContainerId, onSelectContainer }: Props) {
  const isPhone = useIsPhone();
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const [selectedTypes, setSelectedTypes] = useState<ArtifactType[]>([]);
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<LibraryScope>("active");

  // M35: fleet scope is enumerated client-side via stableIds; for v1
  // we keep the single-container `useArtifacts` for "active" and let
  // fleet scope reduce to empty until per-container fan-out is wired.
  const targetIds =
    scope === "active" && activeContainerId !== null
      ? [activeContainerId]
      : scope === "fleet"
        ? containers.map((c) => c.id)
        : [];
  const stableIds = useMemo(() => [...targetIds].sort((a, b) => a - b), [targetIds]);

  // useArtifacts is always called exactly once per render (with `null`
  // to disable). DO NOT loop it over stableIds — the hook count must
  // remain constant.
  const single = useArtifacts(stableIds.length === 1 ? stableIds[0] : null, {
    type: selectedTypes.length > 0 ? selectedTypes : undefined,
    search: search || undefined,
  });

  // For M35, fleet scope renders the single-container view for the
  // active workspace (TODO(M35.x): fan-out N useArtifacts calls).
  const allArtifacts: Artifact[] = stableIds.length === 1 ? single.artifacts : [];
  const activeContainer = containers.find((c) => c.id === activeContainerId);

  // M36 — phone branch: stack detail BELOW sidebar. Two sub-cases:
  //   1. artifact selected → detail-only with back-arrow header
  //   2. no selection      → sidebar-only, full-width
  if (isPhone) {
    if (activeArtifactId) {
      return (
        <main aria-label="Library artifact" className="bg-page flex h-full min-w-0 flex-1 flex-col">
          <header className="border-edge bg-pane flex items-center gap-2 border-b px-2 py-2">
            <button
              type="button"
              onClick={() => setActiveArtifactId(null)}
              aria-label="Back to library"
              className="text-secondary hover:text-primary flex min-h-[44px] min-w-[44px] items-center justify-center rounded p-2"
            >
              <ChevronLeft size={20} aria-hidden="true" />
            </button>
            <h1 className="text-primary flex-1 truncate text-[14px] font-semibold">Library</h1>
          </header>
          <ArtifactDetail
            artifactId={activeArtifactId}
            allArtifacts={allArtifacts}
            onSelectContainer={onSelectContainer}
          />
        </main>
      );
    }
    // No artifact selected — sidebar takes the full width.
    return (
      <main aria-label="Library" className="bg-page flex h-full min-w-0 flex-1 flex-col">
        <header className="border-edge flex flex-col gap-1.5 border-b px-3 py-2">
          <h2 className="text-secondary text-[10px] font-semibold tracking-wider uppercase">
            Library
          </h2>
          <ScopeToggle
            activeContainerName={activeContainer?.project_name ?? null}
            onScopeChange={setScope}
          />
        </header>
        <FilterChips
          selected={selectedTypes}
          onSelectedChange={setSelectedTypes}
          artifacts={allArtifacts}
        />
        <div className="px-2 pb-1">
          <SearchInput value={search} onChange={setSearch} />
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {allArtifacts.length === 0 ? (
            <p className="text-secondary px-2 py-4 text-[12px]">
              {single.isLoading ? "Loading…" : "No artifacts yet."}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {allArtifacts.map((a) => (
                <li key={a.artifact_id}>
                  <ArtifactCard
                    artifact={a}
                    active={a.artifact_id === activeArtifactId}
                    onSelect={setActiveArtifactId}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    );
  }

  // Tablet / desktop — M35 layout (unchanged).
  return (
    <div className="flex h-full min-w-0 flex-1">
      <aside
        aria-label="Library sidebar"
        className="border-edge bg-pane flex w-80 shrink-0 flex-col border-r"
      >
        <header className="border-edge flex flex-col gap-1.5 border-b px-3 py-2">
          <h2 className="text-secondary text-[10px] font-semibold tracking-wider uppercase">
            Library
          </h2>
          <ScopeToggle
            activeContainerName={activeContainer?.project_name ?? null}
            onScopeChange={setScope}
          />
        </header>
        <FilterChips
          selected={selectedTypes}
          onSelectedChange={setSelectedTypes}
          artifacts={allArtifacts}
        />
        <div className="px-2 pb-1">
          <SearchInput value={search} onChange={setSearch} />
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {allArtifacts.length === 0 ? (
            <p className="text-secondary px-2 py-4 text-[12px]">
              {single.isLoading ? "Loading…" : "No artifacts yet."}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {allArtifacts.map((a) => (
                <li key={a.artifact_id}>
                  <ArtifactCard
                    artifact={a}
                    active={a.artifact_id === activeArtifactId}
                    onSelect={setActiveArtifactId}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      <main className="bg-page flex h-full min-w-0 flex-1 flex-col">
        {activeArtifactId ? (
          <ArtifactDetail
            artifactId={activeArtifactId}
            allArtifacts={allArtifacts}
            onSelectContainer={onSelectContainer}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center p-8 text-center">
            <p className="text-secondary text-sm">Pick an artifact from the sidebar.</p>
          </div>
        )}
      </main>
    </div>
  );
}

function ArtifactDetail({
  artifactId,
  allArtifacts,
  onSelectContainer,
}: {
  artifactId: string;
  allArtifacts: Artifact[];
  onSelectContainer: (id: number) => void;
}) {
  const artifact = allArtifacts.find((a) => a.artifact_id === artifactId);
  if (!artifact) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center">
        <p className="text-secondary text-sm">Artifact not in current view.</p>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto">{renderArtifact(artifact)}</div>
      {artifact.source_chat_id && (
        <footer className="border-edge bg-pane border-t px-4 py-2 text-[12px]">
          <button
            type="button"
            onClick={() => {
              // Backlink: M35 just selects the source container; full
              // message-scroll lands in M36.
              onSelectContainer(artifact.container_id);
            }}
            className="border-edge text-primary hover:bg-chip rounded border px-3 py-1"
          >
            Open in chat
          </button>
        </footer>
      )}
    </div>
  );
}
