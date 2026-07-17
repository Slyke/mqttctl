import fs from "node:fs";
import { randomBytes } from "node:crypto";

const argumentsMap = Object.fromEntries(process.argv.slice(2).reduce((entries, value, index, values) => {
  if (!value.startsWith("--")) return entries;
  entries.push([value.slice(2), values[index + 1]]);
  return entries;
}, []));
const action = argumentsMap.action;
const errorKey = argumentsMap["error-key"];
const errorFile = argumentsMap["error-file"] ?? "./errors.json";
const codes = JSON.parse(fs.readFileSync(errorFile, "utf8"));

const save = () => fs.writeFileSync(errorFile, `${JSON.stringify(Object.fromEntries(Object.entries(codes).sort(([left], [right]) => left.localeCompare(right))), null, 2)}\n`);

if (action === "add") {
  if (!errorKey || codes[errorKey]) throw new Error("A new --error-key is required.");
  let code;
  do code = randomBytes(8).toString("hex").toUpperCase(); while (Object.values(codes).includes(code));
  codes[errorKey] = code;
  save();
  console.log(`Added ${errorKey}: ${code}`);
} else if (action === "delete") {
  if (!errorKey || !codes[errorKey]) throw new Error("An existing --error-key is required.");
  delete codes[errorKey];
  save();
  console.log(`Deleted ${errorKey}`);
} else if (action === "validate") {
  const values = Object.values(codes);
  const valid = values.every((code) => /^[A-F0-9]{16}$/.test(code)) && new Set(values).size === values.length;
  if (!valid) throw new Error("Error codes must be unique 16-character uppercase hexadecimal values.");
  console.log("All error codes are valid.");
} else {
  throw new Error("Use --action add, delete, or validate.");
}
