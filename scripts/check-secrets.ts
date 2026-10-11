// Scans every file that git would commit (tracked + untracked-but-not-ignored) for things
// that must never be published: credentials, phone numbers, personal paths and emails, and the
// ACTUAL values from your local .env and Mailbird config. Prints file:line and the rule that
// matched, never the matched text. Run it before every commit: npm run check:secrets
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f && existsSync(f));

const rules: { name: string; re: RegExp; skipFiles?: RegExp; allow?: RegExp }[] = [
  { name: "Anthropic key", re: /sk-ant-[A-Za-z0-9_-]{10,}/, allow: /abcdefghijklmnop/ }, // the redaction test uses an obviously fake key
  { name: "bearer token", re: /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/, allow: /Bearer\s+(\*\*\*|\$\{|<)/ },
  { name: "phone number", re: /\+\d{9,15}/, skipFiles: /package-lock\.json$/, allow: /\+10000000000|\+15555550114|\+15555550105/ }, // placeholder / fake test numbers
  { name: "email address", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/i, skipFiles: /package-lock\.json$|^test\//, // tests use fake addresses; the exact-value check below still covers real ones
    allow: /@example\.(com|org)|noreply@(github|anthropic)\.com|@users\.noreply\.github\.com/ },
  { name: "personal home path", re: /\/Users\/[a-z0-9_-]+\//i, allow: /\/Users\/(you|alex|name)\// },
  { name: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "long secret-looking token", re: /\b[A-Za-z0-9_-]{40,}\b/, skipFiles: /package-lock\.json$|\.test\.ts$/, allow: /mcp__|https?:\/\/|sha\d+-|node_modules|[a-z]+(-[a-z]+){4,}|[a-z]+(_[a-z]+){4,}/ },
];

// Exact secrets from this machine: if any appears in a publishable file, that is a leak.
const secrets: { label: string; value: string }[] = [];
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    const v = m?.[2]?.replace(/^["']|["']$/g, "").trim();
    if (m && v && v.length >= 6 && /TOKEN|KEY|NUMBER|SECRET|PASSWORD/.test(m[1]!)) secrets.push({ label: `value of ${m[1]} in .env`, value: v });
  }
}
try {
  const mb = JSON.parse(readFileSync(`${process.env.HOME}/.claude.json`, "utf8")).mcpServers?.mailbird;
  for (const a of mb?.args ?? []) {
    const t = String(a).match(/Bearer\s+(\S+)/)?.[1];
    if (t) secrets.push({ label: "Mailbird MCP bearer token", value: t });
  }
} catch { /* no Claude config on this machine, e.g. CI */ }

let found = 0;
for (const f of files) {
  const text = readFileSync(f, "utf8");
  if (text.includes("\0")) continue; // binary
  text.split("\n").forEach((line, i) => {
    for (const r of rules) {
      if (r.skipFiles?.test(f)) continue;
      const m = line.match(r.re);
      if (m && !(r.allow && r.allow.test(line))) {
        console.log(`${f}:${i + 1}  ${r.name}`);
        found++;
      }
    }
    for (const s of secrets) {
      if (line.includes(s.value)) {
        console.log(`${f}:${i + 1}  LEAK: ${s.label}`);
        found++;
      }
    }
  });
}
console.log(found === 0 ? `ok: ${files.length} files scanned, ${secrets.length} local secret value(s) checked, nothing found` : `\n${found} finding(s). Fix them before committing.`);
process.exit(found === 0 ? 0 : 1);
