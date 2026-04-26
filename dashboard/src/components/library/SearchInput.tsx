/** Debounced search input (M35). Emits onChange after 250ms of idle. */
import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface Props {
  value: string;
  onChange: (next: string) => void;
}

export function SearchInput({ value, onChange }: Props) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  // Ref-capture pattern: keep a stable ref to the latest onChange so the
  // debounce effect doesn't need the callback in its deps. An unmemoized
  // parent would otherwise reset the 250ms timer on every render.
  // Callback identity is intentionally excluded from deps.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });
  useEffect(() => {
    const t = setTimeout(() => {
      if (draft !== value) onChangeRef.current(draft);
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, value]);

  return (
    <label className="border-edge bg-input text-primary focus-within:border-accent flex items-center gap-1.5 rounded border px-2 py-1 text-[12px]">
      <Search size={12} aria-hidden="true" className="text-muted shrink-0" />
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Search artifacts…"
        aria-label="Search artifacts"
        className="placeholder:text-muted flex-1 bg-transparent focus:outline-none"
      />
    </label>
  );
}
