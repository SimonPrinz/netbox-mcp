// Copies the bundled OpenAPI specification into the build output so the
// compiled server can locate it at runtime.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const outDir = join(root, "build", "spec");

const source = join(root, "netbox-openapi.yaml");
const target = join(outDir, "netbox-openapi.yaml");

if (!source) {
  console.warn(
    "[copy-assets] No OpenAPI specification found in the project root. " +
      "Set NETBOX_SPEC_PATH at runtime so the server can locate the spec.",
  );
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
copyFileSync(source, target);
console.log(`[copy-assets] Copied ${source} -> ${target}`);