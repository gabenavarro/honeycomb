/** Library route (M35 T13).
 *
 * Thin pass-through to LibraryActivity, which owns the full Library
 * surface (sidebar with chips + scope + search + cards, main pane with
 * per-type renderer dispatch). The M32 bridge surfacing M27 DiffEvents
 * has been replaced now that the dedicated artifact pipeline is wired.
 */
import { LibraryActivity } from "../library/LibraryActivity";
import type { ContainerRecord } from "../../lib/types";

interface Props {
  containers: ContainerRecord[];
  activeContainerId: number | null;
  onSelectContainer: (id: number) => void;
}

export function LibraryRoute({ containers, activeContainerId, onSelectContainer }: Props) {
  return (
    <LibraryActivity
      containers={containers}
      activeContainerId={activeContainerId}
      onSelectContainer={onSelectContainer}
    />
  );
}
