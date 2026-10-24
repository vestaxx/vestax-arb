#!/usr/bin/env node
// apply-middles.mjs
// Adds the gold "💰 Middles" label to the top row of the arbs TRACKER cards, only for
// entries whose note contains "MIDDLE:". Normal pairs are not changed in any way.
//
// Usage (run from the repo root, then commit the changed file):
//   node apply-middles.mjs                 -> finds the file that contains "function trCard"
//   node apply-middles.mjs path/to/file    -> patches that file
//
// It only edits the tracker card builder (trCard). It refuses to write anything unless every
// spot it needs matches exactly once, and it checks the page's scripts still parse afterwards.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const MID = '/MIDDLE:/.test(t.note || "")';
const LABEL = '<div style="text-align:center;align-self:center;white-space:nowrap;font-weight:800;letter-spacing:.04em;color:#f5b301">💰 Middles</div>';

const steps = [
  {
    name: "top row grid (3 columns for middle cards)",
    re: /<article class="card"><div class="top">'(\s*\+\s*)'<div class="pct"><b'/g,
    rep: (_m, plus) => `<article class="card"><div class="top"' + (${MID} ? ' style="grid-template-columns:auto 1fr auto"' : '') + '>'${plus}'<div class="pct"><b'`,
    required: true,
  },
  {
    name: "Middles label between the percent and OPEN",
    re: /'<div class="when">' \+ chip/g,
    rep: () => `(${MID} ? '${LABEL}' : '') + '<div class="when">' + chip`,
    required: true,
  },
  {
    name: "title block spans two columns",
    re: /'<div><div class="sport">' \+ ICON\(t\.sport\)/g,
    rep: () => `'<div' + (${MID} ? ' style="grid-column:1/3"' : '') + '><div class="sport">' + ICON(t.sport)`,
    required: true,
  },
  {
    name: "'locked in' block goes in column 3",
    re: /'<div class="vs">' \+ sub \+ 'in '/g,
    rep: () => `'<div class="vs"' + (${MID} ? ' style="grid-column:3"' : '') + '>' + sub + 'in '`,
    required: true,
  },
  {
    name: "remove the old small '· MIDDLE' tag (only if present)",
    re: / \+ \(\/MIDDLE:\/\.test\(t\.note \|\| ""\) \? ' <span style="color:#f5b301;font-weight:700">· MIDDLE<\/span>' : ''\)/g,
    rep: () => "",
    required: false,
  },
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "dist", "build", ".next"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(html?|m?[jt]sx?)$/i.test(e.name)) out.push(p);
  }
  return out;
}

function checkScripts(src) {
  if (!/<script/i.test(src)) return;
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m, n = 0;
  while ((m = re.exec(src))) {
    if (!m[1].trim()) continue;
    n++;
    try { new vm.Script(m[1]); } catch (e) { throw new Error(`script #${n} no longer parses: ${e.message}`); }
  }
}

function patch(src) {
  if (src.includes("💰 Middles")) return null; // already done
  let out = src;
  for (const s of steps) {
    const hits = [...out.matchAll(s.re)].length;
    if (hits === 0 && !s.required) continue;
    if (hits !== 1) throw new Error(`"${s.name}" matched ${hits} times (needs exactly 1). Nothing was changed.`);
    out = out.replace(s.re, s.rep);
  }
  checkScripts(out);
  return out;
}

const arg = process.argv[2];
let targets;
if (arg) targets = [arg];
else targets = walk(process.cwd()).filter((f) => fs.readFileSync(f, "utf8").includes("function trCard"));
if (targets.length !== 1) {
  console.error(targets.length ? `Found several files with "function trCard":\n  ${targets.join("\n  ")}\nRun again with the path of the right one.` : 'Could not find a file containing "function trCard". Pass the file path.');
  process.exit(1);
}
const file = targets[0];
const src = fs.readFileSync(file, "utf8");
try {
  const res = patch(src);
  if (res === null) { console.log(`${file}: already has the Middles label. Nothing to do.`); process.exit(0); }
  fs.writeFileSync(file, res);
  console.log(`Patched ${file}. Review with: git diff ${file}\nThen commit it.`);
} catch (e) {
  console.error(`Not patched: ${e.message}`);
  process.exit(1);
}
