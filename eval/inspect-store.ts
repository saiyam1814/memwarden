//
// Store inspection: is what we remember actually worth recalling?
//
// This exists because 761 passing tests and a 100% firewall eval both said
// "healthy" while the store held 379 memories titled `Write`, `Read` and `Bash`
// with raw tool-input JSON as their bodies. Every automated signal was green
// because the tests were asserting the broken behavior. The only thing that
// caught it was reading the actual rows.
//
// So this makes that reading a one-command habit rather than a manual sqlite
// dance, and grades the store against the same quality rules the extraction
// gate enforces at capture time:
//
//   - a title that is a bare tool name is unrankable (every memory looks alike)
//   - a body that parses as tool-input JSON is unreadable
//   - empty facts AND concepts means hybrid search has nothing to match
//   - every record at the same importance means ranking is dead
//
// It reads a COPY of the database (sqlite3 .backup) so a running daemon is
// never disturbed, and it only reads — nothing here mutates the brain.
//
// Run:  npx tsx eval/inspect-store.ts [--json] [--samples N] [--data-dir DIR]

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Lowercased: hosts differ on casing (Claude Code sends "Read", others send
// "read"), and a case-sensitive check silently under-counts the defect.
const TOOL_NAMES = new Set([
  "read", "write", "edit", "multiedit", "bash", "grep", "glob", "task",
  "webfetch", "websearch", "notebookedit", "observation", "shell", "view",
  "str_replace", "create", "search",
]);

function isBareToolName(title: string | undefined): boolean {
  return !!title && TOOL_NAMES.has(title.trim().toLowerCase());
}

interface Row {
  id?: string;
  type?: string;
  title?: string;
  content?: string;
  narrative?: string;
  facts?: string[];
  concepts?: string[];
  files?: string[];
  importance?: number;
  provenance?: { fileHashes?: Record<string, string> };
}

interface Finding {
  label: string;
  count: number;
  /** Why this matters, printed beside the number. */
  why: string;
  examples: string[];
}

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * JSON-shaped text is a payload, not prose — and it counts ANYWHERE in the
 * body, not just at the start. An earlier version only checked the prefix, so
 * bodies like `Wrote foo.ts. {"type":"create","content":"…"}` passed as clean
 * while carrying an entire file inside them.
 */
function isJsonish(s: string): boolean {
  return /\{\s*"[^"]+"\s*:/.test(s) || /\[\s*\{/.test(s);
}

function bodyOf(r: Row): string {
  return r.content ?? r.narrative ?? "";
}

function main(): void {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const sIdx = args.indexOf("--samples");
  const sampleCount = sIdx !== -1 ? Number(args[sIdx + 1]) || 8 : 8;
  const dIdx = args.indexOf("--data-dir");
  const dataDir =
    dIdx !== -1 && args[dIdx + 1]
      ? args[dIdx + 1]!
      : (process.env["MEMWARDEN_DATA_DIR"] ?? join(homedir(), ".memwarden"));

  const db = join(dataDir, "memwarden.db");
  if (!existsSync(db)) {
    console.error(`no brain at ${db}`);
    process.exit(1);
  }

  // Snapshot, so a live daemon mid-write cannot produce a malformed read and
  // so nothing we do can touch the real file.
  const tmp = mkdtempSync(join(tmpdir(), "memwarden-inspect-"));
  const copy = join(tmp, "snapshot.db");
  try {
    sh("sqlite3", [`file:${db}?mode=ro`, `.backup ${copy}`]);

    const dump = (scopeLike: string, limit: number): Row[] => {
      const out = sh("sqlite3", [
        copy,
        `SELECT value FROM kv WHERE scope LIKE '${scopeLike}' ORDER BY rowid DESC LIMIT ${limit};`,
      ]);
      const rows: Row[] = [];
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        try {
          rows.push(JSON.parse(line) as Row);
        } catch {
          // A row spanning newlines is rare and not worth a parser; skipping
          // it biases nothing we measure.
        }
      }
      return rows;
    };

    const memories = dump("mem:memories", 500);
    const observations = dump("mem:obs:%", 500);
    const all = [...memories, ...observations];

    if (all.length === 0) {
      console.log(
        `\n  no memories or observations found in ${db}.\n` +
          `  If the daemon is running and tools are wired, work once and re-check.\n`,
      );
      return;
    }

    const findings: Finding[] = [];
    const push = (label: string, why: string, rows: Row[], render: (r: Row) => string): void => {
      if (rows.length === 0) return;
      findings.push({
        label,
        why,
        count: rows.length,
        examples: rows.slice(0, 3).map(render),
      });
    };

    push(
      "titles that are a bare tool name",
      "every memory looks identical, so nothing can be ranked or skimmed",
      all.filter((r) => isBareToolName(r.title)),
      (r) => `${r.title}`,
    );
    push(
      "bodies that are raw JSON",
      "a payload no human or model reads as knowledge",
      all.filter((r) => isJsonish(bodyOf(r))),
      (r) => `${r.title ?? "(untitled)"} → ${bodyOf(r).slice(0, 60)}…`,
    );
    push(
      "records with no facts AND no concepts",
      "hybrid search has no terms to match; effectively invisible",
      all.filter((r) => (r.facts?.length ?? 0) === 0 && (r.concepts?.length ?? 0) === 0),
      (r) => `${r.title ?? "(untitled)"}`,
    );

    // Importance spread: if everything is the same number, ranking is dead.
    const imps = all
      .map((r) => r.importance)
      .filter((n): n is number => typeof n === "number");
    const distinctImps = new Set(imps);

    const codeBacked = all.filter(
      (r) => Object.keys(r.provenance?.fileHashes ?? {}).length > 0,
    );

    const healthy = all.filter(
      (r) =>
        r.title &&
        !isBareToolName(r.title) &&
        !isJsonish(bodyOf(r)) &&
        ((r.facts?.length ?? 0) > 0 || (r.concepts?.length ?? 0) > 0),
    );

    if (asJson) {
      console.log(
        JSON.stringify(
          {
            dataDir,
            sampled: all.length,
            memories: memories.length,
            observations: observations.length,
            healthy: healthy.length,
            healthyPct: Math.round((healthy.length / all.length) * 100),
            codeBacked: codeBacked.length,
            distinctImportanceLevels: distinctImps.size,
            findings: findings.map((f) => ({ label: f.label, count: f.count })),
          },
          null,
          2,
        ),
      );
      return;
    }

    const pct = (n: number): string => `${Math.round((n / all.length) * 100)}%`;
    console.log(`\n  memwarden store inspection — ${dataDir}\n`);
    console.log(
      `  sampled     ${all.length} records (${memories.length} distilled memories, ${observations.length} observations)`,
    );
    console.log(
      `  usable      ${healthy.length} (${pct(healthy.length)}) have a real title, prose body, and searchable terms`,
    );
    console.log(
      `  code-backed ${codeBacked.length} (${pct(codeBacked.length)}) carry capture-time file hashes the firewall can re-check`,
    );
    console.log(
      `  ranking     ${distinctImps.size} distinct importance level(s)` +
        (distinctImps.size <= 1
          ? "  ⚠ everything is equally important, so ranking does nothing"
          : ""),
    );

    if (findings.length === 0) {
      console.log(`\n  ✓ no quality defects found in the sample.\n`);
    } else {
      console.log(`\n  DEFECTS\n`);
      for (const f of findings) {
        console.log(`  ⚠ ${f.count} ${f.label} (${pct(f.count)})`);
        console.log(`      ${f.why}`);
        for (const e of f.examples) console.log(`      · ${e}`);
        console.log("");
      }
      console.log(
        `  Records captured before 0.0.8 keep their old shape. They age out through\n` +
          `  retention; 'memwarden doctor . --fix-stale' clears stale ones now. What\n` +
          `  matters is whether RECENT captures are clean — check the samples below.\n`,
      );
    }

    console.log(`  MOST RECENT CAPTURES (read these — the numbers cannot tell you if\n  the knowledge is worth having)\n`);
    for (const r of observations.slice(0, sampleCount)) {
      console.log(`  ── ${r.title ?? "(untitled)"}`);
      const body = bodyOf(r).replace(/\s+/g, " ").trim();
      if (body) console.log(`     ${body.slice(0, 150)}`);
      if (r.facts?.length) console.log(`     facts: ${r.facts.join(" | ").slice(0, 120)}`);
      if (r.concepts?.length) console.log(`     terms: ${r.concepts.slice(0, 8).join(", ")}`);
      console.log("");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main();
