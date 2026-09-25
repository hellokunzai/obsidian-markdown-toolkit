/**
 * Small DOM helpers.
 *
 * Note the deliberate use of the native `classList` rather than Obsidian's
 * `addClass` / `removeClass` / `createDiv` extensions: those are typed as global
 * augmentations that the project's lint setup cannot resolve, and each call site
 * turns into an `@typescript-eslint/no-unsafe-call` error. Plain DOM is typed,
 * portable, and produces exactly the same markup.
 */

export interface ElOptions {
  cls?: string;
  text?: string;
  attr?: Record<string, string>;
  children?: HTMLElement[];
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElOptions = {}
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (options.cls) el.className = options.cls;
  if (options.text !== undefined) el.textContent = options.text;
  if (options.attr) {
    for (const key of Object.keys(options.attr)) el.setAttribute(key, options.attr[key]);
  }
  if (options.children) for (const child of options.children) el.appendChild(child);
  return el;
}

/**
 * `addEventListener` with an async handler, without tripping
 * `@typescript-eslint/no-misused-promises` at every call site.
 */
export function onAsync<K extends keyof HTMLElementEventMap>(
  el: HTMLElement | SVGElement,
  type: K,
  handler: (event: HTMLElementEventMap[K] & Event) => void | Promise<void>
): void {
  el.addEventListener(type, (event) => {
    void handler(event as HTMLElementEventMap[K] & Event);
  });
}

export function toggleClass(el: Element, name: string, on: boolean): void {
  el.classList.toggle(name, on);
}
