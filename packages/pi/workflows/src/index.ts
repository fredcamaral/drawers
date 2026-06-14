/**
 * pi-drawer-workflows entry — the module `pi.extensions` loads.
 *
 * pi's loader calls the module's DEFAULT export as the extension factory. The
 * factory itself lives in `plugin/index.ts` (alongside the rest of the plugin
 * layer); this file is the thin entry that re-exports it as the default so the
 * package's `pi.extensions: ["./src/index.ts"]` resolves to the factory.
 *
 * Node-safe: no Bun.* APIs.
 */

export { default } from "./plugin/index";
