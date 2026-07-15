//
// A URL is not a file.
//
// PATH_RE's "contains a slash" branch matches every URL, so a fetch-style
// tool_input ({url: "https://…"}) used to be captured as a REFERENCED FILE.
// existsSync("https://…") is false and always will be, so classifyProvenance
// reported `stale — references files that no longer match (deleted: https://…)`
// — every web fetch was born stale and refused by the firewall for life.
//
// Measured on a real brain before the fix: 357 of 1,444 stale memories (25%)
// were WebFetch captures anchored to their own URL. That is a quarter of
// everything the firewall refused, refused for a parsing bug rather than drift.
//
// audit.ts::extractFileRefs already strips URLs ("URLs are not file
// references"); these tests pin the capture-side mirror of that rule.
//
import { describe, expect, it } from "vitest";
import { collectFilesBounded, extractProvenance } from "../src/functions/provenance.js";
import { classifyProvenance } from "../src/functions/verify.js";

describe("provenance: URLs are never captured as files", () => {
  it("a WebFetch tool_input anchors to NO files", () => {
    const prov = extractProvenance({
      cwd: "/repo",
      data: {
        tool_name: "WebFetch",
        tool_input: {
          url: "https://docs.maximem.ai/concepts/memory-scopes",
          prompt: "extract the scope hierarchy",
        },
      },
    });
    expect(prov.files).toBeUndefined();
  });

  it("the memory is unsourced-by-command, NOT stale (the whole point)", () => {
    const prov = extractProvenance({
      cwd: "/repo",
      data: {
        tool_name: "WebFetch",
        tool_input: { url: "https://www.maximem.ai/" },
      },
    });
    // It still has command evidence, so it is allowed — it just isn't
    // anchored to a file that can never exist. Before the fix this returned
    // `stale`, and a stale memory is REFUSED at recall.
    const verdict = classifyProvenance(prov, "/repo");
    expect(verdict.status).not.toBe("stale");
    expect(verdict.status).toBe("sourced_unverified");
  });

  it("every URL scheme is rejected, at top level and nested", () => {
    const urls = [
      "https://example.com/a/b.ts",
      "http://example.com/",
      "ftp://files.example.com/x.tar.gz",
      "ws://localhost:3111/socket",
      "file:///Users/x/notes.md",
    ];
    for (const url of urls) {
      expect(collectFilesBounded({ url }).files, url).toEqual([]);
      // Also via an explicit FILE_KEY — a host that puts a URL in `path`
      // must not anchor us to it either.
      expect(collectFilesBounded({ path: url }).files, url).toEqual([]);
    }
  });

  it("real paths still collect — the guard must not over-reach", () => {
    const { files } = collectFilesBounded({
      file_path: "src/functions/provenance.ts",
      pattern: "src/**/*.ts",
    });
    expect(files).toContain("src/functions/provenance.ts");
  });

  it("a URL alongside a real file keeps the file and drops the URL", () => {
    const prov = extractProvenance({
      cwd: "/repo",
      data: {
        tool_name: "Edit",
        tool_input: {
          file_path: "/repo/src/auth.ts",
          reference: "https://docs.example.com/auth/spec",
        },
      },
    });
    expect(prov.files).toEqual(["src/auth.ts"]);
  });
});
