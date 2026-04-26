/** Files route (M32 bridge).
 *
 * Sub-tabs for the legacy Files / Source Control / Problems /
 * Keybindings activities. The existing Activity-driven UI stays
 * intact — Files Route just wraps it in a Tabs strip so all the
 * tooling lives behind a single rail entry.
 */
import { Breadcrumbs } from "../Breadcrumbs";
import { ContainerFilesView } from "../ContainerFilesView";
import { ContainerList } from "../ContainerList";
import { ErrorBoundary } from "../ErrorBoundary";
import { FileViewer } from "../FileViewer";
import { KeybindingsEditor } from "../KeybindingsEditor";
import { ProblemsPanel } from "../ProblemsPanel";
import { SourceControlView } from "../SourceControlView";
import type { ContainerRecord } from "../../lib/types";
import type { Activity } from "../ActivityBar";

interface Props {
  containers: ContainerRecord[];
  activeContainerId: number | null;
  onSelectContainer: (id: number) => void;
  /** Sub-activity: which Files sub-tab is open. */
  subActivity: Extract<Activity, "files" | "scm" | "problems" | "keybindings">;
  onSubActivityChange: (a: Extract<Activity, "files" | "scm" | "problems" | "keybindings">) => void;
  activeFsPath: string;
  onFsPathChange: (path: string) => void;
  openedFile: string | null;
  onOpenFile: (path: string | null) => void;
}

const SUB_TABS: ReadonlyArray<{ id: Props["subActivity"]; label: string }> = [
  { id: "files", label: "Files" },
  { id: "scm", label: "Source Control" },
  { id: "problems", label: "Problems" },
  { id: "keybindings", label: "Keybindings" },
];

export function FilesRoute({
  containers,
  activeContainerId,
  onSelectContainer,
  subActivity,
  onSubActivityChange,
  activeFsPath,
  onFsPathChange,
  openedFile,
  onOpenFile,
}: Props) {
  void containers;
  return (
    <div className="flex h-full min-w-0 flex-1">
      <aside
        aria-label="Files sidebar"
        className="border-edge bg-pane flex w-72 shrink-0 flex-col border-r"
      >
        <nav
          aria-label="Files sub-tabs"
          role="tablist"
          className="border-edge flex shrink-0 border-b"
        >
          {SUB_TABS.map((tab) => {
            const isActive = subActivity === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => onSubActivityChange(tab.id)}
                className={`flex-1 px-2 py-1.5 text-[11px] transition-colors ${
                  isActive
                    ? "border-accent bg-chip text-primary border-b-2"
                    : "text-secondary hover:bg-chip hover:text-primary"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>
        <div className="flex-1 overflow-y-auto">
          {subActivity === "files" && (
            <ContainerFilesView
              containerId={activeContainerId}
              path={activeFsPath}
              onNavigate={onFsPathChange}
              onOpenFile={onOpenFile}
            />
          )}
          {subActivity === "scm" && <SourceControlView />}
          {subActivity === "problems" && (
            <ProblemsPanel
              onOpenContainer={(id) => {
                onSelectContainer(id);
                onSubActivityChange("files");
              }}
            />
          )}
          {subActivity === "keybindings" && <KeybindingsEditor />}
        </div>
        <div className="border-edge border-t">
          <ContainerList selectedId={activeContainerId} onSelect={onSelectContainer} />
        </div>
      </aside>
      <main className="bg-page flex h-full min-w-0 flex-1 flex-col">
        {activeContainerId !== null && (
          <Breadcrumbs
            containerId={activeContainerId}
            path={activeFsPath}
            onPathChange={onFsPathChange}
          />
        )}
        {openedFile !== null && activeContainerId !== null ? (
          <ErrorBoundary
            key={`eb-file-${activeContainerId}-${openedFile}`}
            label={`the ${openedFile} viewer`}
          >
            <FileViewer
              key={`${activeContainerId}-${openedFile}`}
              containerId={activeContainerId}
              path={openedFile}
              onClose={() => onOpenFile(null)}
            />
          </ErrorBoundary>
        ) : (
          <FilesEmptyState />
        )}
      </main>
    </div>
  );
}

function FilesEmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-secondary text-sm">
        Pick a container, then click a file in the tree to view it here.
      </p>
    </div>
  );
}
