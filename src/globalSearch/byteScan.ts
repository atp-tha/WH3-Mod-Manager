import type { SearchMatcher } from "./matcher";
import { makeMatchExcerpt, type ScanMatches } from "./textScan";

export interface ByteScanLimits {
  maxMatches?: number;
  maxExcerptLength?: number;
  chunkBytes?: number;
  overlapBytes?: number;
}

export interface ByteScanMatch {
  offset: number;
  encoding: "utf8" | "utf16le";
  excerpt: string;
  matchStartInExcerpt: number;
  matchEndInExcerpt: number;
}

const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
const DEFAULT_OVERLAP_BYTES = 64 * 1024;

const constrainWholeFileAnchors = (pattern: RegExp, allowStart: boolean, allowEnd: boolean): RegExp => {
  if (allowStart && allowEnd) return pattern;

  let source = "";
  let inCharacterClass = false;
  for (let index = 0; index < pattern.source.length; index++) {
    const character = pattern.source[index];
    if (character === "\\") {
      source += character;
      if (index + 1 < pattern.source.length) source += pattern.source[++index];
      continue;
    }
    if (character === "[") inCharacterClass = true;
    if (character === "]" && inCharacterClass) inCharacterClass = false;
    const disabledStart = character === "^" && !inCharacterClass && !allowStart;
    const disabledEnd = character === "$" && !inCharacterClass && !allowEnd;
    source += disabledStart || disabledEnd ? "(?!)" : character;
  }
  return new RegExp(source, pattern.flags);
};

const withGlobal = (pattern: RegExp): RegExp => {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags.replace("y", ""));
};

const scanDecodedWindow = (
  value: string,
  matcher: SearchMatcher,
  allowStart: boolean,
  allowEnd: boolean,
  maxExcerptLength: number,
): Array<{ start: number; end: number; excerpt: string; matchStartInExcerpt: number; matchEndInExcerpt: number }> => {
  if (!matcher.isValidRegex || matcher.isEmpty) return [];
  const constrained = constrainWholeFileAnchors(matcher.toRegExp(), allowStart, allowEnd);
  const pattern = withGlobal(constrained);
  const matches: Array<{
    start: number;
    end: number;
    excerpt: string;
    matchStartInExcerpt: number;
    matchEndInExcerpt: number;
  }> = [];
  for (;;) {
    const found = pattern.exec(value);
    if (!found) break;
    const start = found.index;
    const end = start + found[0].length;
    const excerpt = makeMatchExcerpt(value, start, end, maxExcerptLength);
    matches.push({ start, end, ...excerpt });
    if (found[0].length === 0) pattern.lastIndex++;
  }
  return matches;
};

/** Boolean counterpart used by the legacy streaming pack search. */
export const containsBytesInWindow = (
  buffer: Buffer,
  matcher: SearchMatcher,
  allowStart: boolean,
  allowEnd: boolean,
): boolean =>
  scanDecodedWindow(buffer.toString("utf8"), matcher, allowStart, allowEnd, 0).length > 0 ||
  scanDecodedWindow(buffer.toString("utf16le"), matcher, allowStart, allowEnd, 0).length > 0 ||
  scanDecodedWindow(buffer.subarray(1).toString("utf16le"), matcher, allowStart, allowEnd, 0).length > 0;

const byteOffsetForUtf8Index = (value: string, index: number): number =>
  Buffer.byteLength(value.slice(0, index), "utf8");

/**
 * Searches the two text decodings used by binary pack payloads. Overlapping windows retain matches
 * that straddle a read boundary, while the offset/encoding key removes duplicates from the overlap.
 */
export const scanBytesForMatches = (
  buffer: Buffer,
  matcher: SearchMatcher,
  {
    maxMatches = Number.POSITIVE_INFINITY,
    maxExcerptLength = 240,
    chunkBytes = DEFAULT_CHUNK_BYTES,
    overlapBytes = DEFAULT_OVERLAP_BYTES,
  }: ByteScanLimits = {},
): ScanMatches<ByteScanMatch> => {
  const matches: ByteScanMatch[] = [];
  if (matcher.isEmpty || !matcher.isValidRegex || maxMatches <= 0 || buffer.length === 0) {
    Object.defineProperty(matches, "truncated", { value: false, enumerable: false });
    return matches as ScanMatches<ByteScanMatch>;
  }

  const seen = new Set<string>();
  let truncated = false;
  const safeChunkBytes = Math.max(1, chunkBytes);
  const safeOverlapBytes = Math.min(Math.max(0, overlapBytes), safeChunkBytes);

  const addMatches = (
    decoded: string,
    encoding: "utf8" | "utf16le",
    windowStart: number,
    alignment: number,
    isFirstWindow: boolean,
    isLastWindow: boolean,
  ): boolean => {
    const decodedMatches = scanDecodedWindow(
      decoded,
      matcher,
      isFirstWindow && alignment === 0,
      isLastWindow,
      maxExcerptLength,
    );
    for (const match of decodedMatches) {
      const offset =
        encoding === "utf8"
          ? windowStart + byteOffsetForUtf8Index(decoded, match.start)
          : windowStart + alignment + match.start * 2;
      const key = `${encoding}:${offset}:${match.end - match.start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ offset, encoding, ...match });
      if (matches.length >= maxMatches) {
        truncated = true;
        return false;
      }
    }
    return true;
  };

  for (let baseStart = 0; baseStart < buffer.length && !truncated; baseStart += safeChunkBytes) {
    const windowStart = Math.max(0, baseStart - safeOverlapBytes);
    const windowEnd = Math.min(buffer.length, baseStart + safeChunkBytes);
    const isFirstWindow = baseStart === 0;
    const isLastWindow = windowEnd === buffer.length;
    const window = buffer.subarray(windowStart, windowEnd);

    if (!addMatches(window.toString("utf8"), "utf8", windowStart, 0, isFirstWindow, isLastWindow)) break;
    if (!addMatches(window.toString("utf16le"), "utf16le", windowStart, 0, isFirstWindow, isLastWindow)) break;
    if (window.length > 1) {
      if (!addMatches(window.subarray(1).toString("utf16le"), "utf16le", windowStart, 1, isFirstWindow, isLastWindow))
        break;
    }
  }

  Object.defineProperty(matches, "truncated", { value: truncated, enumerable: false });
  return matches as ScanMatches<ByteScanMatch>;
};

export { constrainWholeFileAnchors };
