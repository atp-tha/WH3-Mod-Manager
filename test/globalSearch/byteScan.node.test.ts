import { describe, expect, it } from "vitest";

import { scanBytesForMatches } from "../../src/globalSearch/byteScan";
import { createSearchMatcher } from "../../src/globalSearch/matcher";

describe("global search byte scanner", () => {
  it("finds UTF-16LE text at both byte alignments", () => {
    const matcher = createSearchMatcher("needle", { caseSensitive: true });
    const even = scanBytesForMatches(Buffer.concat([Buffer.from("xx"), Buffer.from("needle", "utf16le")]), matcher);
    const odd = scanBytesForMatches(Buffer.concat([Buffer.from("x"), Buffer.from("needle", "utf16le")]), matcher);

    expect(even.some((match) => match.encoding === "utf16le" && match.offset === 2)).toBe(true);
    expect(odd.some((match) => match.encoding === "utf16le" && match.offset === 1)).toBe(true);
  });

  it("keeps a match that straddles a small window boundary", () => {
    const matches = scanBytesForMatches(Buffer.from("xxxxneedlexxxx"), createSearchMatcher("needle"), {
      chunkBytes: 8,
      overlapBytes: 8,
    });

    expect(matches.some((match) => match.encoding === "utf8" && match.offset === 4)).toBe(true);
  });

  it("does not treat an internal window boundary as a whole-file anchor", () => {
    const buffer = Buffer.from("xxxxneedlexxxx");
    expect(
      scanBytesForMatches(buffer, createSearchMatcher("^needle", { regex: true }), { chunkBytes: 8, overlapBytes: 4 }),
    ).toEqual([]);
    expect(
      scanBytesForMatches(buffer, createSearchMatcher("needle$", { regex: true }), { chunkBytes: 8, overlapBytes: 4 }),
    ).toEqual([]);
  });
});
