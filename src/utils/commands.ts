/**
 * The command registry, and the two things this plugin needs from it.
 *
 * `app.commands` is not part of Obsidian's public d.ts, but it is the only way
 * to run a command by id or to read the name a command was registered under.
 * Both call sites live here so the cast exists in exactly one place, and so the
 * "id is unknown" case has a single answer.
 */
import type { App, Command } from "obsidian";
import type { ToolbarCommand } from "../core/toolbar-commands";

interface CommandRegistry {
  commands: Record<string, Command>;
  executeCommandById(id: string): boolean;
}

function registry(app: App): CommandRegistry | null {
  const commands = (app as unknown as { commands?: Partial<CommandRegistry> }).commands;
  if (!commands || typeof commands.executeCommandById !== "function") return null;
  return commands as CommandRegistry;
}

/** Runs a command by id. `false` means the app does not know that id. */
export function runCommand(app: App, id: string): boolean {
  return registry(app)?.executeCommandById(id) ?? false;
}

/**
 * The name a command was registered under, in the app's own language.
 *
 * Core commands are registered with a translated name, which is what lets the
 * default toolbar ship without a label (and without a translation key) for each
 * of its commands: the tooltip comes from here instead.
 */
export function commandName(app: App, id: string): string {
  if (!id) return "";
  const command = registry(app)?.commands?.[id];
  return typeof command?.name === "string" ? command.name : "";
}

/**
 * What to call a toolbar entry.
 *
 * The user's own label wins, then the command's registered name, then the raw
 * id — so a button is never left with an empty tooltip, which is what happens
 * today when a command is removed by the plugin that registered it.
 */
export function toolbarLabel(app: App, cmd: ToolbarCommand): string {
  return cmd.label || commandName(app, cmd.commandId) || cmd.commandId || cmd.id;
}
