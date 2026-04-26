/** Library activity (M35) — top-level shell for the Library route. */
import { useState } from "react";

import type { ArtifactType } from "../../lib/types";
import { useArtifacts } from "../../hooks/useArtifacts";
import { ArtifactCard } from "./ArtifactCard";

interface Props {
  containers: { id: number; project_name: string }[];
  activeContainerId: number | null;
  onSelectContainer: (id: number) => void;
}

export function LibraryActivity({ containers, activeContainerId, onSelectContainer }: Props) {
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const [selectedTypes, setSelectedTypes] = useState<ArtifactType[]>([]);
  const [search, setSearch] = useState("");

  const { artifacts, isLoading } = useArtifacts(activeContainerId, {
    type: selectedTypes.length > 0 ? selectedTypes : undefined,
    search: search || undefined,
  });

  void containers;
  void onSelectContainer;
  void setSelectedTypes;
  void setSearch;

  return (
    <div className="flex h-full min-w-0 flex-1">
      <aside
        aria-label="Library sidebar"
        className="border-edge bg-pane flex w-80 shrink-0 flex-col border-r"
      >
        <header className="border-edge border-b px-3 py-1.5">
          <h2 className="text-secondary text-[10px] font-semibold tracking-wider uppercase">
            Library
          </h2>
        </header>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {isLoading && artifacts.length === 0 ? (
            <p className="text-secondary px-2 py-4 text-[12px]">Loading…</p>
          ) : artifacts.length === 0 ? (
            <p className="text-secondary px-2 py-4 text-[12px]">
              No artifacts yet. They auto-save as you chat.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {artifacts.map((a) => (
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
          <div className="text-primary flex-1 overflow-y-auto p-4 text-[12px]">
            Renderer for {activeArtifactId} arrives in Tasks 9-11.
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center p-8 text-center">
            <p className="text-secondary text-sm">
              Pick an artifact from the sidebar to view it.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
