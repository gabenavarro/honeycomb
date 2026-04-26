/** WorkspacePill stub (M32 Task 4 placeholder; replaced by Tasks 5+6). */
import type { ContainerRecord } from "../lib/types";

interface Props {
  containers: ContainerRecord[];
  activeContainerId: number | null;
  onSelectContainer: (id: number) => void;
}

export function WorkspacePill({ containers, activeContainerId, onSelectContainer }: Props) {
  void containers;
  void activeContainerId;
  void onSelectContainer;
  return null;
}
