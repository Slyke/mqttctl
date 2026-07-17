import fs from "node:fs";

export const getBuildInfo = () => {
  try {
    const parsed = JSON.parse(fs.readFileSync(new URL("../build-info.json", import.meta.url), "utf8"));
    return {
      version: String(parsed.version ?? "0.1.0"),
      buildHash: String(parsed.buildHash ?? "development")
    };
  } catch {
    return { version: "0.1.0", buildHash: "development" };
  }
};
