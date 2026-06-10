// One-shot audit: every t("...") key used in src/ must exist in en.json,
// and dynamic t(`section.${var}`) prefixes must match known sections.
const fs = require("fs");

const en = JSON.parse(fs.readFileSync("src/i18n/locales/en.json", "utf8"));
const flat = (o, p = "") =>
  Object.entries(o).flatMap(([k, v]) =>
    typeof v === "object" ? flat(v, p + k + ".") : [p + k]);
const known = new Set(flat(en));

const walk = (d) =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(d + "/" + e.name)
    : /\.(tsx?|jsx?)$/.test(e.name) ? [d + "/" + e.name] : []);

const used = new Set();
const dynamic = new Set();
for (const f of walk("src")) {
  const code = fs.readFileSync(f, "utf8");
  for (const m of code.matchAll(/\bt\(\s*["']([^"']+)["']/g)) used.add(m[1]);
  for (const m of code.matchAll(/\bt\(\s*`([^`]+)`/g)) dynamic.add(m[1]);
}

const missing = [...used].filter((k) => !known.has(k));
console.log("static t() keys used:", used.size, "| dynamic templates:", dynamic.size);
console.log(missing.length ? "MISSING IN en.json: " + JSON.stringify(missing, null, 1) : "ALL STATIC KEYS RESOLVE ✓");

// For dynamic templates like `status.${b.status}`, check the section prefix exists.
for (const d of dynamic) {
  const prefix = d.split("${")[0]; // e.g. "status."
  const hits = [...known].filter((k) => k.startsWith(prefix));
  console.log(`dynamic "${d}" → ${hits.length} keys under "${prefix}" ${hits.length ? "✓" : "✗ NO MATCHES"}`);
}
