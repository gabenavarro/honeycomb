import { describe, expect, it } from "vitest";

import {
  AVAILABLE_SLASH_COMMANDS,
  filterSlashCommands,
  parseSlashCommand,
  type SlashAction,
} from "../slashCommands";

describe("parseSlashCommand", () => {
  it("non-slash text returns kind='none'", () => {
    expect(parseSlashCommand("hello world")).toEqual<SlashAction>({ kind: "none" });
    expect(parseSlashCommand("")).toEqual<SlashAction>({ kind: "none" });
    expect(parseSlashCommand("  /edit foo")).toEqual<SlashAction>({ kind: "none" }); // leading whitespace = not a command
  });

  it("/edit transforms to a Claude prompt asking to open the path", () => {
    const action = parseSlashCommand("/edit src/main.tsx");
    expect(action).toEqual<SlashAction>({
      kind: "transform-and-send",
      userText: "Please open src/main.tsx for me to edit.",
    });
  });

  it("/edit without an argument returns 'unknown' (path is required)", () => {
    expect(parseSlashCommand("/edit")).toEqual<SlashAction>({
      kind: "unknown",
      raw: "/edit",
      reason: "/edit requires a path argument",
    });
  });

  it("/git wraps a Bash invocation", () => {
    expect(parseSlashCommand("/git status -sb")).toEqual<SlashAction>({
      kind: "transform-and-send",
      userText: "Run `git status -sb` via the Bash tool.",
    });
  });

  it("/git without args is unknown", () => {
    expect(parseSlashCommand("/git")).toEqual<SlashAction>({
      kind: "unknown",
      raw: "/git",
      reason: "/git requires a subcommand",
    });
  });

  it("/compact passes through literally to Claude", () => {
    expect(parseSlashCommand("/compact")).toEqual<SlashAction>({
      kind: "transform-and-send",
      userText: "/compact",
    });
  });

  it("/plan flips mode (no post)", () => {
    expect(parseSlashCommand("/plan")).toEqual<SlashAction>({
      kind: "set-mode",
      mode: "plan",
    });
  });

  it("/review with PR arg flips mode AND toasts the M35 deferral", () => {
    expect(parseSlashCommand("/review 42")).toEqual<SlashAction>({
      kind: "set-mode",
      mode: "review",
      toast: "PR thread loading arrives in M35.",
    });
  });

  it("/review without an arg also flips mode (PR optional)", () => {
    expect(parseSlashCommand("/review")).toEqual<SlashAction>({
      kind: "set-mode",
      mode: "review",
      toast: "PR thread loading arrives in M35.",
    });
  });

  it("/clear clears the chat", () => {
    expect(parseSlashCommand("/clear")).toEqual<SlashAction>({ kind: "clear-chat" });
  });

  it("/save note <title> creates a note artifact", () => {
    expect(parseSlashCommand("/save note My Idea")).toEqual<SlashAction>({
      kind: "create-artifact",
      artifact_type: "note",
      title: "My Idea",
      body: "My Idea",
    });
  });

  it("/save note without a title is unknown", () => {
    expect(parseSlashCommand("/save note")).toEqual<SlashAction>({
      kind: "unknown",
      raw: "/save note",
      reason: "/save note requires a title",
    });
  });

  it("/save note with whitespace-only title is unknown", () => {
    expect(parseSlashCommand("/save note    ")).toEqual<SlashAction>({
      kind: "unknown",
      raw: "/save note",
      reason: "/save note requires a title",
    });
  });

  it("/save without 'note' is unknown", () => {
    expect(parseSlashCommand("/save todo Foo")).toEqual<SlashAction>({
      kind: "unknown",
      raw: "/save todo Foo",
      reason: "/save expects 'note <title>' (other artifact types arrive in M35)",
    });
  });

  it("/skill stubs with a toast", () => {
    expect(parseSlashCommand("/skill foo")).toEqual<SlashAction>({
      kind: "toast",
      text: "Skills arrive in a future milestone.",
    });
  });

  it("/wat is unknown", () => {
    expect(parseSlashCommand("/wat")).toEqual<SlashAction>({
      kind: "unknown",
      raw: "/wat",
      reason: "Unknown command: /wat",
    });
  });
});

describe("filterSlashCommands", () => {
  it("empty prefix returns all 8 commands", () => {
    expect(filterSlashCommands("")).toEqual(AVAILABLE_SLASH_COMMANDS);
    expect(AVAILABLE_SLASH_COMMANDS.length).toBe(8);
  });

  it("prefix /e matches /edit only", () => {
    const matches = filterSlashCommands("/e");
    expect(matches.map((c) => c.name)).toEqual(["/edit"]);
  });

  it("prefix /s matches /save and /skill", () => {
    const matches = filterSlashCommands("/s");
    expect(matches.map((c) => c.name).sort()).toEqual(["/save", "/skill"]);
  });

  it("non-slash prefix returns empty array", () => {
    expect(filterSlashCommands("hello")).toEqual([]);
  });

  it("prefix /xyz returns empty (no matches)", () => {
    expect(filterSlashCommands("/xyz")).toEqual([]);
  });
});
