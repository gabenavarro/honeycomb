/** Three-radio appearance picker (M31).
 *
 * Used in Settings -> Appearance. Will also be used in M36 by the
 * phone "More" tab. Self-contained — pulls preference from useTheme.
 */
import { useTheme, type ThemePreference } from "../lib/theme";

const OPTIONS: Array<{
  value: ThemePreference;
  label: string;
  description: string;
}> = [
  {
    value: "system",
    label: "System",
    description: "Auto-follow OS — switches with macOS / Windows night mode",
  },
  {
    value: "dark",
    label: "Dark",
    description: "Existing aesthetic — deep workspace, locked palette",
  },
  {
    value: "light",
    label: "Light",
    description: "Daytime / bright environments — Warm Workshop palette",
  },
];

function Swatch({ value }: { value: ThemePreference }) {
  // Inline SVG previews — three little 56x36 cards showing the palette
  // at a glance. Not theme-token-driven (these are static previews of
  // each option, not a reflection of the current state).
  if (value === "system") {
    return (
      <div
        className="h-9 w-14 flex-shrink-0 overflow-hidden rounded border border-[#d0d7de]"
        style={{
          background: "linear-gradient(135deg, #ffffff 0%, #ffffff 49%, #161b22 51%, #161b22 100%)",
        }}
      />
    );
  }
  if (value === "dark") {
    return (
      <div
        className="h-9 w-14 flex-shrink-0 overflow-hidden rounded"
        style={{
          background: "linear-gradient(135deg, #0d1117 0%, #161b22 50%, #1c2128 100%)",
        }}
      />
    );
  }
  return (
    <div
      className="h-9 w-14 flex-shrink-0 overflow-hidden rounded border border-[#e0d6bf]"
      style={{
        background: "linear-gradient(135deg, #fdfaf3 0%, #f7f1e3 50%, #f0e9d6 100%)",
      }}
    />
  );
}

export function AppearancePicker() {
  const { preference, setPreference } = useTheme();
  return (
    <fieldset className="flex flex-col gap-2" aria-label="Appearance">
      {OPTIONS.map((opt) => {
        const id = `appearance-${opt.value}`;
        const selected = preference === opt.value;
        return (
          <label
            key={opt.value}
            htmlFor={id}
            className={`flex cursor-pointer items-center gap-3.5 rounded-md border p-3 transition-colors ${
              selected
                ? "border-[#58a6ff] shadow-[0_0_0_1px_#58a6ff]"
                : "border-[#30363d] hover:border-[#6e7681]"
            }`}
          >
            <Swatch value={opt.value} />
            <div className="flex-1">
              <div className="text-[13px] font-medium text-[#c9d1d9]">{opt.label}</div>
              <div className="mt-0.5 text-[11px] text-[#8b949e]">{opt.description}</div>
            </div>
            <input
              id={id}
              type="radio"
              name="appearance"
              value={opt.value}
              checked={selected}
              onChange={() => setPreference(opt.value)}
              className="h-4 w-4 cursor-pointer accent-[#58a6ff]"
            />
          </label>
        );
      })}
    </fieldset>
  );
}
