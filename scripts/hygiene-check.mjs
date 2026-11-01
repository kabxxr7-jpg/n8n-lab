// Scans everything git tracks (and the commit messages) for things that must not be published:
// tool/vendor names, co-author trailers, key-like strings and absolute home paths.
// package-lock.json is skipped (integrity hashes look like keys). Exit 1 on any hit.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./lib/stack.mjs";

const words = ["clau" + "de", "anthr" + "opic", "co-authored" + "-by", "generated with", "ai assis" + "tant", "copil" + "ot", "chat" + "gpt", "open" + "ai"];
const patterns = [
  ["home path", /\/Users\/[A-Za-z0-9._-]+/],
  ["api key (sk_/pk_)", /\b[sp]k_(live|test)_[A-Za-z0-9]{10,}/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ["AWS key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ["JWT-like token", /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  // 40+ hex characters that are not an HMAC signature the tests print as "sha256=<hex>"
  ["long hex string", /(?<!sha256=)(?<![0-9a-f])[0-9a-f]{40,}(?![0-9a-f])/i],
];

const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const files = git("ls-files", "-z").split("\0").filter(Boolean).filter((f) => f !== "package-lock.json");
const hits = [];
const lineOf = (text, idx) => text.slice(0, idx).split("\n").length;

const scan = (label, text) => {
  const lower = text.toLowerCase();
  for (const w of words) {
    let i = lower.indexOf(w);
    while (i >= 0) {
      hits.push(`${label}:${lineOf(text, i)}  contains "${w}"`);
      i = lower.indexOf(w, i + 1);
    }
  }
  for (const [name, re] of patterns) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const m of text.matchAll(g)) hits.push(`${label}:${lineOf(text, m.index)}  ${name}: ${m[0].slice(0, 24)}...`);
  }
};

for (const f of files) {
  const buf = fs.readFileSync(path.join(ROOT, f));
  if (buf.includes(0)) continue; // binary (png)
  if (f === "scripts/hygiene-check.mjs") continue; // this file spells the words out in pieces
  scan(f, buf.toString("utf8"));
}
scan("git log", git("log", "--format=%an <%ae>%n%cn <%ce>%n%B"));

const logAuthors = new Set(git("log", "--format=%an <%ae>").split("\n").filter(Boolean));
if ([...logAuthors].some((a) => !a.endsWith("@users.noreply.github.com>"))) hits.push(`git log: author is not the noreply address: ${[...logAuthors].join("; ")}`);

if (hits.length) {
  console.error(hits.join("\n"));
  console.error(`\nhygiene check FAILED: ${hits.length} hit(s)`);
  process.exit(1);
}
console.log(`hygiene check passed: ${files.length} tracked files and ${git("rev-list", "--count", "HEAD").trim()} commits scanned`);
