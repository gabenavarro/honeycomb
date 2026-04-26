/** AppearancePicker tests (M31). */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ThemeProvider, THEME_STORAGE_KEY } from "../../lib/theme";
import { AppearancePicker } from "../AppearancePicker";

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  // Stub matchMedia to prefersLight=false so default resolves to dark
  window.matchMedia = (q: string) =>
    ({
      matches: false,
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
      onchange: null,
    }) as unknown as MediaQueryList;
});
afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

function renderPicker() {
  return render(
    <ThemeProvider>
      <AppearancePicker />
    </ThemeProvider>,
  );
}

describe("AppearancePicker", () => {
  it("renders three radio rows: System, Dark, Light", () => {
    renderPicker();
    expect(screen.getByRole("radio", { name: /system/i })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /dark/i })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /light/i })).toBeTruthy();
  });

  it("defaults to System selected", () => {
    renderPicker();
    expect((screen.getByRole("radio", { name: /system/i }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("radio", { name: /dark/i }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("radio", { name: /light/i }) as HTMLInputElement).checked).toBe(false);
  });

  it("clicking Light selects it and persists to localStorage", () => {
    renderPicker();
    fireEvent.click(screen.getByRole("radio", { name: /light/i }));
    expect((screen.getByRole("radio", { name: /light/i }) as HTMLInputElement).checked).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("clicking Dark selects it and persists", () => {
    renderPicker();
    fireEvent.click(screen.getByRole("radio", { name: /dark/i }));
    expect((screen.getByRole("radio", { name: /dark/i }) as HTMLInputElement).checked).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("clicking System after Light clears storage + data-theme", () => {
    renderPicker();
    fireEvent.click(screen.getByRole("radio", { name: /light/i }));
    fireEvent.click(screen.getByRole("radio", { name: /system/i }));
    expect((screen.getByRole("radio", { name: /system/i }) as HTMLInputElement).checked).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.getAttribute("data-theme")).toBeNull();
  });
});
