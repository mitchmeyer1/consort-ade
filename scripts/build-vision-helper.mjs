import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "native/ConsortVision.swift");
const output = resolve(root, "native/bin/consort-vision");
const moduleCache = resolve(root, ".consort/cache/swift-modules");
mkdirSync(dirname(output), { recursive: true });
mkdirSync(moduleCache, { recursive: true });

let current = false;
try { current = statSync(output).mtimeMs >= statSync(source).mtimeMs; } catch {}
if (!current) execFileSync("/usr/bin/xcrun", ["swiftc", "-O", "-module-cache-path", moduleCache, source, "-o", output], {
  stdio: "inherit",
  env: { ...process.env, CLANG_MODULE_CACHE_PATH: moduleCache, SWIFT_MODULECACHE_PATH: moduleCache },
});
console.log(`native OCR helper: ${output}`);
