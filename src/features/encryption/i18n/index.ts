// Re-export the plugin's shared `t()` so the migrated encryption features can
// keep their relative `./i18n` / `../i18n` imports without change. All
// encryption strings live in the plugin's main dictionary (src/i18n).
export { t } from "../../../i18n";
