import type { SearchMatcher } from "./matcher";

export interface TextScanLimits {
  maxMatches?: number;
  maxExcerptLength?: number;
}

export interface TextScanMatch {
  line: number;
  column: number;
  offset: number;
  excerpt: string;
  matchStartInExcerpt: number;
  matchEndInExcerpt: number;
}

export type ScanMatches<T> = T[] & { truncated?: boolean };

const withTruncated = <T>(values: T[], truncated: boolean): ScanMatches<T> => {
  const result = values as ScanMatches<T>;
  Object.defineProperty(result, "truncated", { value: truncated, enumerable: false });
  return result;
};

/** Makes a bounded excerpt while keeping the complete match visible. */
export const makeMatchExcerpt = (
  value: string,
  matchStart: number,
  matchEnd: number,
  maxLength = 240,
): { excerpt: string; matchStartInExcerpt: number; matchEndInExcerpt: number } => {
  if (value.length <= maxLength) {
    return { excerpt: value, matchStartInExcerpt: matchStart, matchEndInExcerpt: matchEnd };
  }

  const matchLength = Math.max(0, matchEnd - matchStart);
  const roomForContext = Math.max(0, maxLength - matchLength);
  let start = Math.max(0, matchStart - Math.floor(roomForContext / 2));
  let end = Math.min(value.length, start + maxLength);
  if (end - start < maxLength) start = Math.max(0, end - maxLength);

  // A pathological regex can match more than the requested excerpt. In that case returning the
  // match is more useful than silently cutting its highlight in half.
  if (matchLength > maxLength) {
    start = matchStart;
    end = matchEnd;
  }

  const prefix = start > 0 ? "…" : "";
  const suffix = end < value.length ? "…" : "";
  return {
    excerpt: `${prefix}${value.slice(start, end)}${suffix}`,
    matchStartInExcerpt: prefix.length + matchStart - start,
    matchEndInExcerpt: prefix.length + matchEnd - start,
  };
};

interface LineRange {
  start: number;
  end: number;
  line: number;
}

const lineRangeAt = (value: string, offset: number, firstContentOffset: number): LineRange => {
  let lineStart = firstContentOffset;
  let line = 1;
  for (let index = firstContentOffset; index < offset; index++) {
    if (value[index] === "\r") {
      if (value[index + 1] === "\n") index++;
      lineStart = index + 1;
      line++;
    } else if (value[index] === "\n") {
      lineStart = index + 1;
      line++;
    }
  }

  let end = lineStart;
  while (end < value.length && value[end] !== "\r" && value[end] !== "\n") end++;
  return { start: lineStart, end, line };
};

/**
 * Finds bounded, editor-friendly matches in decoded text. Offsets are UTF-16 string offsets, which
 * is the coordinate system used by the text viewer and JavaScript's string APIs.
 */
export const scanTextForMatches = (
  text: string,
  matcher: SearchMatcher,
  { maxMatches = Number.POSITIVE_INFINITY, maxExcerptLength = 240 }: TextScanLimits = {},
): ScanMatches<TextScanMatch> => {
  const matches: TextScanMatch[] = [];
  if (matcher.isEmpty || !matcher.isValidRegex || maxMatches <= 0) return withTruncated(matches, false);

  // UTF-8 BOMs are not content in an editor. Keep it in the returned offset so the caller can map
  // back to the decoded buffer, but start line/column accounting after it.
  const firstContentOffset = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let fromIndex = firstContentOffset;
  let truncated = false;
  while (fromIndex <= text.length) {
    const found = matcher.find(text, fromIndex);
    if (!found) break;
    const line = lineRangeAt(text, found.start, firstContentOffset);
    const excerpt = makeMatchExcerpt(
      text.slice(line.start, line.end),
      found.start - line.start,
      found.end - line.start,
      maxExcerptLength,
    );
    matches.push({
      line: line.line,
      column: found.start - line.start + 1,
      offset: found.start,
      excerpt: excerpt.excerpt,
      matchStartInExcerpt: excerpt.matchStartInExcerpt,
      matchEndInExcerpt: excerpt.matchEndInExcerpt,
    });
    if (matches.length >= maxMatches) {
      const next = matcher.find(text, Math.max(found.end, found.start + 1));
      truncated = next !== undefined;
      break;
    }
    fromIndex = Math.max(found.end, found.start + 1);
  }

  return withTruncated(matches, truncated);
};
