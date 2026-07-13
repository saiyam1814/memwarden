//
// Session-end handoff synthesis — the SESSION JOURNAL's outbound half.
// When a host reports session_end, mem::observe calls buildSessionHandoff to
// turn the session's stored observations + firstPrompt into a compact,
// structured, DETERMINISTIC summary (goal / what happened / decisions / open
// threads). No LLM: the same inputs always produce the same handoff, so a
// Claude→Codex handoff is reproducible and auditable.
//
// The handoff is persisted three ways by the caller:
//   Session.summary        — the plain-text summary on the session row
//   KV.summaries           — a SessionSummary that mem::context renders
//   a CompressedObservation — searchable, so session-start recall in ANOTHER
//                             tool surfaces the previous tool's handoff.
//
// Everything here is pure over its input (no clock, no fs, no kv).

import type { CompressedObservation, Provenance, SessionSummary } from "./types.js";

/** Cap applied to a stored user prompt (observe's user_prompt path). Long
 * pasted prompts keep their head — that is where the intent lives. */
export const MAX_STORED_PROMPT_CHARS = 4000;

/** The loose shape of whatever is in the session's observation scope: mostly
 * synthetic CompressedObservations, but a raw observation can be present if a
 * compression pass has not overwritten it yet. Every field is optional and
 * read defensively. */
export interface HandoffSourceObservation {
  id?: string;
  type?: string;
  hookType?: string;
  title?: string;
  narrative?: string;
  facts?: string[];
  files?: string[];
  timestamp?: string;
  userPrompt?: string;
  provenance?: Provenance;
}

export interface HandoffInput {
  /** Observation id the handoff is persisted under (same slot as the raw
   * session_end observation). */
  obsId: string;
  sessionId: string;
  /** Session-end timestamp (the hook event's timestamp). */
  timestamp: string;
  project?: string | undefined;
  firstPrompt?: string | undefined;
  agentId?: string | undefined;
  /** The assistant's final message — the session's OUTCOME, when the host's
   * stop event supplied one (Codex last_assistant_message, Kiro
   * assistant_response). */
  assistantResponse?: string | undefined;
  /** The session's stored observations, excluding the session_end row. */
  observations: ReadonlyArray<HandoffSourceObservation>;
}

export interface Handoff {
  /** Plain-text structured summary — goes on Session.summary. */
  summaryText: string;
  /** Searchable observation persisted over the session_end obsId. */
  observation: CompressedObservation;
  /** Renderable summary for mem::context (KV.summaries). */
  sessionSummary: SessionSummary;
}

// Decision-ish language: deliberately conservative keywords so the "decisions"
// section is short and high-signal rather than a keyword soup.
const DECISION_RE =
  /\b(decided|decision|chose|chosen|opted for|picked|switched to|instead of|going with|settled on|will use|agreed to|renamed|migrated to)\b/i;

// Error-ish text, mirroring the hook client's Déjà Fix gate.
const ERRORISH_RE =
  /\b(error|errno|exception|traceback|failed|failure|panic)\b|[✕✗×]/i;

// Prompt language that names future work — feeds "open threads".
const FOLLOWUP_RE =
  /\b(todo|to-do|follow[- ]?up|next step|remaining|still need|later|don't forget|left to do)\b/i;

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function firstLine(s: string): string {
  return s.split("\n").find((l) => l.trim().length > 0)?.trim() ?? s.trim();
}

function textOf(o: HandoffSourceObservation): string {
  return [o.title, o.narrative, o.userPrompt, ...(o.facts ?? [])]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join("\n");
}

function isPrompt(o: HandoffSourceObservation): boolean {
  return (
    o.type === "conversation" ||
    typeof o.userPrompt === "string" ||
    o.hookType === "user_prompt" ||
    o.hookType === "prompt_submit"
  );
}

function isError(o: HandoffSourceObservation): boolean {
  if (o.type === "error") return true;
  // Only sniff narratives for tool-ish rows; a prompt ABOUT an error is not
  // itself an unresolved error.
  if (isPrompt(o)) return false;
  return ERRORISH_RE.test(o.narrative ?? "");
}

/** Sentences of `text` matching `re`. Splits on newlines, sentence ends, and
 * the ` | ` separator synthetic compression uses between tool input and
 * output — so a decision found in tool output is not prefixed with the
 * tool_input JSON. */
function matchingSpans(text: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    for (const span of line.split(/(?<=[.!?])\s+|\s\|\s/)) {
      const t = span.trim();
      if (t.length > 8 && re.test(t)) out.push(clip(t, 160));
    }
  }
  return out;
}

function dedupe(items: string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= cap) break;
  }
  return out;
}

/** Deterministic session handoff from stored observations. Pure. */
export function buildSessionHandoff(input: HandoffInput): Handoff {
  const obs = input.observations;

  // --- goal: the session's opening intent -------------------------------
  const promptObs = obs.filter(isPrompt);
  const firstPromptText =
    (typeof input.firstPrompt === "string" && input.firstPrompt.trim()) ||
    promptObs
      .map((o) => o.userPrompt ?? o.narrative ?? o.title ?? "")
      .find((s) => s.trim().length > 0) ||
    "";
  const goal = firstPromptText
    ? clip(firstPromptText.replace(/\s+/g, " ").trim(), 300)
    : "(no prompt captured)";

  // --- what happened: activity counts + files ---------------------------
  const counts = { edits: 0, commands: 0, reads: 0, errors: 0 };
  const files = new Set<string>();
  for (const o of obs) {
    if (isError(o)) counts.errors++;
    switch (o.type) {
      case "file_edit":
      case "file_write":
        counts.edits++;
        for (const f of o.files ?? []) files.add(f);
        break;
      case "command_run":
        counts.commands++;
        break;
      case "search":
      case "file_read":
      case "web_fetch":
        counts.reads++;
        break;
    }
  }
  const fileList = [...files].slice(0, 12);
  const parts: string[] = [];
  if (counts.edits > 0) parts.push(`${counts.edits} file edit${counts.edits === 1 ? "" : "s"}`);
  if (counts.commands > 0) parts.push(`${counts.commands} command${counts.commands === 1 ? "" : "s"}`);
  if (counts.reads > 0) parts.push(`${counts.reads} read/search${counts.reads === 1 ? "" : "es"}`);
  if (promptObs.length > 0) parts.push(`${promptObs.length} prompt${promptObs.length === 1 ? "" : "s"}`);
  if (counts.errors > 0) parts.push(`${counts.errors} error${counts.errors === 1 ? "" : "s"}`);
  const activity =
    obs.length === 0
      ? "no activity captured"
      : `${obs.length} observation${obs.length === 1 ? "" : "s"}` +
        (parts.length > 0 ? ` — ${parts.join(", ")}` : "") +
        (fileList.length > 0 ? `. Files touched: ${fileList.join(", ")}` : "");

  // --- claim lineage -------------------------------------------------------
  // Decisions and unresolved errors COPY text out of observations, so each
  // claim's SOURCE observation must contribute its file evidence to the
  // handoff's provenance — all of it, or the claim is DROPPED from the text.
  // This is what makes the cap safe: raising or hitting it can never leave
  // an untracked claim in the handoff (the old union-of-everything cap let a
  // decision from observation 51 ride while only the first 50 files were
  // tracked — its file could then drift undetected).
  const HANDOFF_PROV_FILE_CAP = 50;
  const provFiles: string[] = [];
  const provHashes: Record<string, string> = {};
  let provCwd: string | undefined;
  /** All-or-nothing inherit of one observation's file evidence. */
  const tryInherit = (p: Provenance | undefined): boolean => {
    const fresh = (p?.files ?? []).filter((f) => !provFiles.includes(f));
    if (provFiles.length + fresh.length > HANDOFF_PROV_FILE_CAP) return false;
    if (!provCwd && p?.cwd) provCwd = p.cwd;
    for (const f of fresh) {
      provFiles.push(f);
      const h = p?.fileHashes?.[f];
      if (h) provHashes[f] = h;
    }
    return true;
  };

  // --- decisions: conservative keyword spans, evidence-tracked ------------
  const decisions: string[] = [];
  {
    const seen = new Set<string>();
    outer: for (const o of obs) {
      for (const span of matchingSpans(textOf(o), DECISION_RE)) {
        const k = span.toLowerCase();
        if (seen.has(k)) continue;
        if (decisions.length >= 5) break outer;
        if (!tryInherit(o.provenance)) continue; // untrackable evidence → claim dropped
        seen.add(k);
        decisions.push(span);
      }
    }
  }

  // --- open threads ------------------------------------------------------
  // (a) error-shaped observations among the LAST 5 — an error the session
  //     ended on is presumed unresolved (deterministic proxy for "no later
  //     fix"); earlier errors were followed by more work and are presumed
  //     handled. Error text is copied, so its evidence is tracked the same
  //     way as decisions. (b) prompts that name future work — prompts carry
  //     no file evidence; mixedTrust covers them.
  const tail = obs.slice(-5);
  const openErrors = tail
    .filter((o) => isError(o) && tryInherit(o.provenance))
    .map((o) => clip(`unresolved: ${firstLine(o.title || o.narrative || "error")}`, 160));
  const openAsks = promptObs
    .filter((o) => FOLLOWUP_RE.test(textOf(o)))
    .map((o) =>
      clip(`asked for later: ${firstLine(o.userPrompt ?? o.narrative ?? o.title ?? "")}`, 160),
    );
  const openThreads = dedupe([...openErrors, ...openAsks], 4);

  // --- outcome: how the session actually ended ----------------------------
  const outcome =
    typeof input.assistantResponse === "string" && input.assistantResponse.trim()
      ? clip(input.assistantResponse.replace(/\s+/g, " ").trim(), 400)
      : undefined;

  // --- assemble -----------------------------------------------------------
  const lines: string[] = [
    `Session handoff${input.project ? ` — ${input.project}` : ""} (ended ${input.timestamp})`,
    `Goal: ${goal}`,
    `What happened: ${activity}`,
  ];
  if (outcome) lines.push(`Outcome: ${outcome}`);
  if (decisions.length > 0) {
    lines.push("Decisions:");
    for (const d of decisions) lines.push(`- ${d}`);
  }
  lines.push(
    openThreads.length > 0 ? "Open threads:" : "Open threads: none detected",
  );
  for (const t of openThreads) lines.push(`- ${t}`);
  const summaryText = lines.join("\n");

  const goalLine = goal === "(no prompt captured)" ? input.sessionId : firstLine(goal);
  const title = clip(`Session handoff: ${goalLine}`, 80);

  // The handoff's provenance was accumulated by the claim-lineage pass
  // above: exactly the observations whose text it copied. Conservative on
  // purpose: if ANY inherited file drifts, the whole handoff is stale (a
  // digest carrying possibly-false claims should be withheld from
  // auto-injection; explicit lookups still find it).
  //
  // The handoff is ALWAYS mixed-trust: beyond the inherited file evidence it
  // embeds the goal (a user prompt), the outcome, and prompt-derived
  // threads — none of which any file hash covers. classifyProvenance
  // therefore never lets a handoff reach "verified": unchanged files earn
  // "sourced" at most, and one unsourced hostile prompt beside one unchanged
  // file cannot ride a matching hash past a verified-only policy.
  const observation: CompressedObservation = {
    id: input.obsId,
    sessionId: input.sessionId,
    timestamp: input.timestamp,
    type: "task",
    title,
    subtitle: clip(activity, 120),
    facts: [
      ...decisions.map((d) => `decision: ${d}`),
      ...openThreads.map((t) => `open: ${t}`),
    ],
    narrative: clip(summaryText, 1500),
    concepts: ["handoff", "session-summary"],
    files: fileList,
    // High importance so mem::context's fallback path surfaces the handoff,
    // moderate confidence — it is a heuristic digest, not verified fact.
    importance: 8,
    confidence: 0.6,
  };
  if (input.agentId) observation.agentId = input.agentId;
  if (provFiles.length > 0 || provCwd) {
    observation.provenance = {
      ...(provCwd ? { cwd: provCwd } : {}),
      ...(provFiles.length > 0 ? { files: provFiles } : {}),
      ...(Object.keys(provHashes).length > 0 ? { fileHashes: provHashes } : {}),
      mixedTrust: true,
    };
  }

  const sessionSummary: SessionSummary = {
    sessionId: input.sessionId,
    project: input.project ?? "",
    createdAt: input.timestamp,
    title,
    narrative: summaryText,
    keyDecisions: decisions,
    filesModified: fileList,
    concepts: ["handoff", "session-summary"],
    observationCount: obs.length,
  };

  return { summaryText, observation, sessionSummary };
}
