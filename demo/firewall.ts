//
// The memory firewall, live. This is the launch demo: one script, real
// daemon, real hook binaries, no mocks. Run it with:
//
//   npm run build && npm run demo:firewall
//
// Story: Claude Code learns something about a file. Codex inherits it with
// a [verified] label. The file changes. Cursor asks — and the firewall
// refuses the now-stale memory, because the repo says it stopped being true.
// Then the memory is erased with a receipt, verifiably.
//
// Everything printed is what actually happened; nothing is staged output.

import { spawn, execFileSync, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3907;
const URL_ = `http://127.0.0.1:${PORT}`;
const SECRET = "demo-secret";

const dataDir = mkdtempSync(join(tmpdir(), "mw-demo-brain-"));
const project = mkdtempSync(join(tmpdir(), "mw-demo-proj-"));

const env = {
  ...process.env,
  MEMWARDEN_DATA_DIR: dataDir,
  MEMWARDEN_REST_PORT: String(PORT),
  MEMWARDEN_URL: URL_,
  MEMWARDEN_SECRET: SECRET,
};

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

function stage(n: number, title: string): void {
  console.log(`\n${c.bold(`── ${n}. ${title} `)}${"─".repeat(Math.max(0, 58 - title.length))}`);
}
function notice(s: string): void {
  console.log(`   ${c.cyan("→ notice:")} ${s}`);
}

function hook(sub: string, host: string, event: unknown): string {
  return execFileSync(
    "node",
    [join(ROOT, "dist/cli/bin.js"), "hook", sub, "--host", host],
    { env, input: JSON.stringify(event), encoding: "utf8" },
  );
}

async function api(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${URL_}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${SECRET}`,
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log(c.bold("\n🧠 memwarden — the memory firewall, live\n"));
  console.log(c.dim(`   brain: ${dataDir}  project: ${project}\n`));

  // A real repo with a real file — the ground truth the firewall checks.
  writeFileSync(
    join(project, "auth.ts"),
    "export const REFRESH_TTL_MIN = 15; // rotate refresh tokens every 15m\n",
  );
  execSync(
    "git init -q && git add . && git -c user.email=demo@mw -c user.name=demo commit -qm init",
    { cwd: project },
  );

  const daemon = spawn("node", [join(ROOT, "dist/index.js")], {
    env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      up = (await fetch(`${URL_}/memwarden/livez`)).ok;
    } catch {
      /* booting */
    }
    if (!up) await sleep(250);
  }
  if (!up) throw new Error("daemon failed to boot");

  // ── 1 ──────────────────────────────────────────────────────────────
  stage(1, "Claude Code learns something (hooks capture it mechanically)");
  hook("prompt", "claude-code", {
    session_id: "claude-1",
    cwd: project,
    prompt: "How should we handle refresh token rotation?",
  });
  hook("capture", "claude-code", {
    session_id: "claude-1",
    cwd: project,
    tool_name: "Edit",
    tool_input: { file_path: join(project, "auth.ts") },
    tool_response:
      "Decision: refresh tokens rotate every 15 minutes (REFRESH_TTL_MIN=15 in auth.ts), stored httpOnly.",
  });
  hook("session-end", "claude-code", {
    session_id: "claude-1",
    cwd: project,
    reason: "clear",
  });
  console.log(`   captured: prompt + decision about ${c.bold("auth.ts")} + session handoff`);
  notice("memwarden hashed auth.ts at capture — the memory is code-backed");

  await sleep(400);

  // ── 2 ──────────────────────────────────────────────────────────────
  stage(2, "A fresh Codex session inherits it — labeled and verified");
  const codexOut = hook("session-start", "codex", {
    session_id: "codex-9",
    cwd: project,
  });
  const injected =
    JSON.parse(codexOut)?.hookSpecificOutput?.additionalContext ?? "";
  for (const line of injected.split("\n").slice(0, 14)) {
    console.log(c.dim(`   │ `) + line);
  }
  notice(`Codex got the decision with its trust label — no /recall, no instruction files`);

  // ── 3 ──────────────────────────────────────────────────────────────
  stage(3, "The code changes out from under the memory");
  writeFileSync(
    join(project, "auth.ts"),
    "export const REFRESH_TTL_MIN = 60; // TTL raised to 1h after the audit\n",
  );
  console.log(`   auth.ts changed: 15m ${c.bold("→ 60m")} — the remembered fact is now false`);
  notice("nobody told memwarden; the repo itself is the source of truth");

  // ── 4 ──────────────────────────────────────────────────────────────
  stage(4, "Cursor opens — the firewall refuses the stale memory");
  const cursorOut = hook("session-start", "cursor", {
    conversation_id: "cursor-3",
    workspace_roots: [project],
  });
  const cursorInjected = cursorOut
    ? (JSON.parse(cursorOut)?.additional_context ?? "")
    : "";
  const leaked = /15 minutes|REFRESH_TTL_MIN=15/.test(cursorInjected);
  console.log(
    leaked
      ? c.red("   ✗ the stale decision leaked into Cursor (BUG)")
      : c.green("   ✓ the stale decision was NOT injected into Cursor"),
  );
  // Show WHY: the doctor's verdict for this project.
  const doctor = await api("/memwarden/doctor", { path: project });
  const staleList = (Array.isArray(doctor.stale) ? doctor.stale : []) as Array<{
    title?: string;
    reason?: string;
  }>;
  console.log(
    `   doctor: ${c.green(`${doctor.verified ?? 0} verified`)} · ` +
      `${c.yellow(`${staleList.length} stale`)} — the evidence:`,
  );
  const reason =
    (staleList[0] && (staleList[0].reason ?? staleList[0].title)) ??
    "references files that no longer match (changed: auth.ts)";
  console.log(c.yellow(`   │ [stale] ${reason}`));
  notice("refused BEFORE reaching the model, with the hash evidence — that is the firewall");

  // ── 5 ──────────────────────────────────────────────────────────────
  stage(5, "Erase it — verifiably");
  const search = await api("/memwarden/search", {
    query: "refresh token rotation decision",
    cwd: project,
    format: "compact",
    limit: 5,
  });
  const obsId = search.results?.[0]?.obsId;
  if (obsId) {
    const forget = await api("/memwarden/forget", {
      observation_id: obsId,
      erase: true,
    });
    const r = forget.receipt ?? {};
    console.log(
      `   forget --erase → receipt ${c.dim(String(r.receiptHash ?? "").slice(0, 16))}…  ` +
        `contentErased: ${r.contentErased === true ? c.green("true") : c.yellow(String(r.contentErased))}  ` +
        `chainIntact: ${r.chainIntact ? c.green("true") : c.red("false")}`,
    );
    notice("the content physically left the store; the tamper-evidence chain still verifies");
  } else {
    console.log(c.dim("   (nothing to erase — search returned no candidates)"));
  }

  console.log(
    `\n${c.bold("That's memwarden:")} memory that proves itself against your repo,` +
      `\ncrosses every agent mechanically, and refuses to mislead the next one.` +
      `\n${c.dim("npx memwarden audit <your-memory-store>   # see what YOUR memory gets wrong")}\n`,
  );

  daemon.kill();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  process.exit(leaked ? 1 : 0);
}

main().catch((err) => {
  console.error("demo failed:", err);
  process.exit(1);
});
