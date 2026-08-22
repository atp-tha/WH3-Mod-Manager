import * as fs from "fs";
import { containsBytesInWindow } from "../globalSearch/byteScan";
import { createSearchMatcher } from "../globalSearch/matcher";

/** Bytes pulled from disk per read. Bounds peak memory regardless of how large a pack is. */
const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
/**
 * Bytes carried over between windows so a match straddling a chunk boundary is still found. A
 * search whose match runs longer than this could be missed at a boundary, which 64 KiB puts well
 * beyond any realistic pack search.
 */
const DEFAULT_OVERLAP_BYTES = 64 * 1024;

const keepFromWindow = (windowLength: number, overlapBytes: number) => {
  const kept = Math.min(overlapBytes, windowLength);
  return (windowLength - kept) % 2 === 0 ? kept : kept - 1;
};

export type PackSearchOptions = {
  /** Exposed for tests, which use tiny windows to exercise the boundary handling cheaply. */
  chunkBytes?: number;
  overlapBytes?: number;
};

/**
 * Searches the encodings used by pack text without relying on PowerShell, streaming the file so
 * that packs larger than Node's buffer and string limits are searched rather than skipped.
 */
export const packFileContains = async (
  filePath: string,
  searchTerm: string,
  { chunkBytes = DEFAULT_CHUNK_BYTES, overlapBytes = DEFAULT_OVERLAP_BYTES }: PackSearchOptions = {},
): Promise<boolean> => {
  // The legacy pack-wide search predates the global-search UI and intentionally keeps its old
  // invalid-regex-as-literal behaviour. The new panel uses the matcher directly and rejects such a
  // query instead.
  const regexMatcher = createSearchMatcher(searchTerm, { regex: true, caseSensitive: false });
  const matcher = regexMatcher.isValidRegex
    ? regexMatcher
    : createSearchMatcher(searchTerm, { regex: false, caseSensitive: false });
  const stream = fs.createReadStream(filePath, { highWaterMark: chunkBytes });
  let tail: Buffer = Buffer.alloc(0);
  let pendingChunk: Buffer | undefined;
  let isFirstWindow = true;

  const searchChunk = (chunk: Buffer, isLastWindow: boolean) => {
    const window = tail.length === 0 ? chunk : Buffer.concat([tail, chunk]);
    const found = containsBytesInWindow(window, matcher, isFirstWindow, isLastWindow);
    tail = window.subarray(window.length - keepFromWindow(window.length, overlapBytes));
    isFirstWindow = false;
    return found;
  };

  try {
    for await (const chunk of stream) {
      // Keep one chunk pending so `$` is enabled only for the actual final window.
      if (pendingChunk && searchChunk(pendingChunk, false)) return true;
      pendingChunk = chunk as Buffer;
    }
    if (pendingChunk && searchChunk(pendingChunk, true)) return true;
  } finally {
    stream.destroy();
  }

  // An empty file yields no chunks, so match the whole-file behaviour against the empty string.
  return pendingChunk === undefined && matcher.toRegExp().test("");
};
