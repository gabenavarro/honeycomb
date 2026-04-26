/** Settings route (M32). Renders the existing SettingsView in the
 *  main pane; no sidebar.
 */
import { SettingsView } from "../SettingsView";

export function SettingsRoute() {
  return (
    <main className="bg-page flex h-full min-w-0 flex-col">
      <SettingsView />
    </main>
  );
}
