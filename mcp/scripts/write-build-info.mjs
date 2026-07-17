import fs from "node:fs";
import { execFileSync } from "node:child_process";

const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
let buildHash = process.env.BUILD_HASH ?? process.env.GIT_COMMIT ?? "";
if (!buildHash) {
  try {
    buildHash = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    buildHash = "development";
  }
}
fs.writeFileSync(new URL("../build-info.json", import.meta.url), `${JSON.stringify({ version: packageJson.version, buildHash }, null, 2)}\n`);
