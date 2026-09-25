/**
 * CSS custom property helpers.
 *
 * Deliberately NOT `setCssProps` / `setCssStyles`: those are Obsidian 1.13+ APIs
 * and this plugin supports older clients, where they simply do not exist. A thin
 * wrapper over `style.setProperty` behaves the same everywhere, and because the
 * property name is always `--`-prefixed, values live in the stylesheet
 * (`var(--x, default)`) instead of being hard-coded in TypeScript.
 */

export function setCssVars(el: HTMLElement, vars: Record<string, string>): void {
  for (const key of Object.keys(vars)) {
    if (!key.startsWith("--")) continue;
    el.style.setProperty(key, vars[key]);
  }
}

export function clearCssVars(el: HTMLElement, ...keys: string[]): void {
  for (const key of keys) el.style.removeProperty(key);
}
