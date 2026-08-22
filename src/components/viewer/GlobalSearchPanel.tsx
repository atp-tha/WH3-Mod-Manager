import React, { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AutoSizer, List, ListRowProps } from "react-virtualized";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChevronDown, faChevronRight, faXmark } from "@fortawesome/free-solid-svg-icons";
import { IoSearch } from "react-icons/io5";

import localizationContext from "../../localizationContext";
import { getPackNameFromPath } from "@/src/utility/packFileHelpers";
import {
  DEFAULT_GLOBAL_SEARCH_KINDS,
  GLOBAL_SEARCH_RESULT_KINDS,
  MAX_GLOBAL_SEARCH_QUERY_LENGTH,
  getGlobalSearchResultFilePath,
  globalSearchKindLabels,
  type GlobalSearchDbResult,
  type GlobalSearchKinds,
  type GlobalSearchProgress,
  type GlobalSearchRequest,
  type GlobalSearchResult,
  type GlobalSearchResultKind,
  type GlobalSearchSkippedFile,
  type GlobalSearchSource,
} from "@/src/globalSearch/types";

export type GlobalSearchOpenPack = { packPath: string; label: string };

export type GlobalSearchPanelProps = {
  /** The packs with a tab in the viewer right now, for the per-pack source checkboxes. */
  openPacks: GlobalSearchOpenPack[];
  onOpenDbResult: (result: GlobalSearchDbResult) => void;
  onOpenFileResult: (result: Exclude<GlobalSearchResult, GlobalSearchDbResult>) => void;
  onClose: () => void;
};

type ViewerPackCatalogEntry = {
  path: string;
  name: string;
  humanName?: string;
  isEnabled: boolean;
  isInData: boolean;
};

/** One rendered line. The tree is flattened so it can go through a windowed list. */
type PanelRow =
  | { type: "pack"; key: string; packPath: string; packLabel: string; count: number }
  | { type: "file"; key: string; packPath: string; filePath: string; kind: GlobalSearchResultKind; count: number }
  | { type: "result"; key: string; result: GlobalSearchResult };

const PACK_ROW_HEIGHT = 26;
const FILE_ROW_HEIGHT = 24;
const RESULT_ROW_HEIGHT = 22;

const packPathKey = (value: string) => value.replaceAll("/", "\\").toLowerCase();

/**
 * Whether the pattern compiles, for the regex toggle.
 *
 * Unlike the ancillaries filter box, an uncompilable pattern here does **not** fall back to a
 * literal search: that box filters as you type, this one runs on a button, and quietly searching for
 * the literal text `foo(` when the user meant a group is a wrong answer rather than a partial one.
 * The Search button is disabled instead, and the input says why.
 */
const useRegexValidity = (query: string, isRegexEnabled: boolean): boolean =>
  useMemo(() => {
    if (!isRegexEnabled || query === "") return true;
    try {
      new RegExp(query);
      return true;
    } catch {
      return false;
    }
  }, [isRegexEnabled, query]);

/** Splits a value around a match so the matched run can be marked. */
const renderHighlighted = (value: string, start: number, end: number) => {
  if (start < 0 || end <= start || start > value.length) return <>{value}</>;
  const safeEnd = Math.min(end, value.length);
  return (
    <>
      {value.slice(0, start)}
      <mark className="rounded-sm bg-amber-500/30 text-amber-200">{value.slice(start, safeEnd)}</mark>
      {value.slice(safeEnd)}
    </>
  );
};

const shortFileName = (filePath: string) => filePath.split(/[\\/]/).pop() || filePath;

const GlobalSearchPanel = memo(({ openPacks, onOpenDbResult, onOpenFileResult, onClose }: GlobalSearchPanelProps) => {
  const localized: Record<string, string> = useContext(localizationContext);

  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [isRegex, setIsRegex] = useState(false);
  const [kinds, setKinds] = useState<GlobalSearchKinds>(DEFAULT_GLOBAL_SEARCH_KINDS);

  const [searchVanilla, setSearchVanilla] = useState(true);
  const [selectedOpenPackPaths, setSelectedOpenPackPaths] = useState<string[]>([]);
  const [includeEnabledMods, setIncludeEnabledMods] = useState(false);
  const [includeAllMods, setIncludeAllMods] = useState(false);

  const [packCatalog, setPackCatalog] = useState<ViewerPackCatalogEntry[]>([]);
  const [results, setResults] = useState<GlobalSearchResult[]>([]);
  const [progress, setProgress] = useState<GlobalSearchProgress | undefined>(undefined);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [skippedFiles, setSkippedFiles] = useState<GlobalSearchSkippedFile[]>([]);
  const [isTruncated, setIsTruncated] = useState(false);
  const [wasCanceled, setWasCanceled] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [collapsedKeys, setCollapsedKeys] = useState<string[]>([]);

  /** The run whose messages are still wanted. A late batch from a cancelled run is dropped. */
  const activeSearchIdRef = useRef<string | null>(null);
  const searchCounterRef = useRef(0);
  const queryInputRef = useRef<HTMLInputElement>(null);

  const isRegexValid = useRegexValidity(query, isRegex);

  useEffect(() => {
    queryInputRef.current?.focus();
  }, []);

  // Counts on the two mod-scope checkboxes come from the catalog the copy-into picker already uses.
  // The viewer window holds no mod list in Redux, so this is the only way to know how many there are.
  useEffect(() => {
    let isCancelled = false;
    void (async () => {
      try {
        const result = await window.api?.getViewerPackCatalog();
        if (isCancelled || !result?.success) return;
        setPackCatalog(result.packs || []);
      } catch (catalogError) {
        console.error("Global search: could not load the pack catalog:", catalogError);
      }
    })();
    return () => {
      isCancelled = true;
    };
  }, []);

  useEffect(() => {
    const unsubscribe = window.api?.onGlobalSearchResults((_event, batch) => {
      if (batch.searchId !== activeSearchIdRef.current) return;
      setResults((previous) => previous.concat(batch.results));
    });
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    const unsubscribe = window.api?.onGlobalSearchProgress((_event, nextProgress) => {
      if (nextProgress.searchId !== activeSearchIdRef.current) return;
      setProgress(nextProgress);
    });
    return () => unsubscribe?.();
  }, []);

  const enabledModCount = useMemo(() => packCatalog.filter((pack) => pack.isEnabled).length, [packCatalog]);

  const selectedOpenPackKeys = useMemo(() => selectedOpenPackPaths.map(packPathKey), [selectedOpenPackPaths]);

  const sources = useMemo<GlobalSearchSource[]>(() => {
    const next: GlobalSearchSource[] = [];
    for (const packPath of selectedOpenPackPaths) next.push({ kind: "pack", path: packPath });
    // "All mods" is a superset, so sending both would only make main deduplicate them again.
    if (includeAllMods) next.push({ kind: "allMods" });
    else if (includeEnabledMods) next.push({ kind: "enabledMods" });
    if (searchVanilla) next.push({ kind: "vanilla" });
    return next;
  }, [includeAllMods, includeEnabledMods, searchVanilla, selectedOpenPackPaths]);

  const selectedKindCount = GLOBAL_SEARCH_RESULT_KINDS.filter((kind) => kinds[kind]).length;
  const canSearch =
    !isSearching &&
    query.trim() !== "" &&
    query.length <= MAX_GLOBAL_SEARCH_QUERY_LENGTH &&
    isRegexValid &&
    selectedKindCount > 0 &&
    sources.length > 0;

  const toggleKind = useCallback((kind: GlobalSearchResultKind) => {
    setKinds((previous) => ({ ...previous, [kind]: !previous[kind] }));
  }, []);

  const toggleOpenPack = useCallback((packPath: string) => {
    setSelectedOpenPackPaths((previous) =>
      previous.some((selected) => packPathKey(selected) === packPathKey(packPath))
        ? previous.filter((selected) => packPathKey(selected) !== packPathKey(packPath))
        : [...previous, packPath],
    );
  }, []);

  const handleSearch = useCallback(async () => {
    if (!canSearch) return;

    const searchId = `viewer-global-search-${++searchCounterRef.current}-${Date.now()}`;
    activeSearchIdRef.current = searchId;

    setIsSearching(true);
    setHasSearched(true);
    setResults([]);
    setProgress(undefined);
    setError(undefined);
    setWarnings([]);
    setSkippedFiles([]);
    setIsTruncated(false);
    setWasCanceled(false);
    setCollapsedKeys([]);

    const request: GlobalSearchRequest = {
      searchId,
      query,
      caseSensitive,
      regex: isRegex,
      kinds,
      sources,
    };

    try {
      const response = await window.api?.runGlobalSearch(request);
      if (activeSearchIdRef.current !== searchId) return;

      if (!response) {
        setError("The search backend did not respond.");
        return;
      }
      if (!response.success) {
        setError(response.error || "The search failed.");
        return;
      }

      // The response carries the full result set, streamed batches included, so replacing rather
      // than appending is what keeps a batch that arrived twice from showing twice.
      setResults(response.results);
      setWarnings(response.warnings || []);
      setSkippedFiles(response.skippedFiles || []);
      setIsTruncated(response.truncated);
      setWasCanceled(response.canceled);
    } catch (searchError) {
      if (activeSearchIdRef.current !== searchId) return;
      const message = searchError instanceof Error ? searchError.message : String(searchError);
      // Until the main-process handler exists, `invoke` rejects with "No handler registered".
      setError(
        message.includes("No handler registered")
          ? "Global search is not available in this build: the main-process handler is not registered yet."
          : message,
      );
    } finally {
      if (activeSearchIdRef.current === searchId) {
        setIsSearching(false);
        activeSearchIdRef.current = null;
      }
    }
  }, [canSearch, caseSensitive, isRegex, kinds, query, sources]);

  const handleStop = useCallback(() => {
    window.api?.cancelGlobalSearch();
    setWasCanceled(true);
  }, []);

  const toggleCollapsed = useCallback((key: string) => {
    setCollapsedKeys((previous) =>
      previous.includes(key) ? previous.filter((collapsed) => collapsed !== key) : [...previous, key],
    );
  }, []);

  /**
   * Grouped pack -> file -> result, flattened to the rows the windowed list draws.
   *
   * Insertion order is kept rather than sorted: main emits targets in the order it searched them,
   * which is the order the user picked, and re-sorting would shuffle the tree as batches stream in.
   */
  const rows = useMemo<PanelRow[]>(() => {
    const byPack = new Map<string, { packPath: string; packLabel: string; files: Map<string, GlobalSearchResult[]> }>();

    for (const result of results) {
      const packKey = packPathKey(result.packPath);
      let packGroup = byPack.get(packKey);
      if (!packGroup) {
        packGroup = {
          packPath: result.packPath,
          packLabel: result.packLabel || getPackNameFromPath(result.packPath) || result.packPath,
          files: new Map(),
        };
        byPack.set(packKey, packGroup);
      }
      const filePath = getGlobalSearchResultFilePath(result);
      const fileGroup = packGroup.files.get(filePath);
      if (fileGroup) fileGroup.push(result);
      else packGroup.files.set(filePath, [result]);
    }

    const collapsed = new Set(collapsedKeys);
    const nextRows: PanelRow[] = [];

    for (const [packKey, packGroup] of byPack) {
      let packCount = 0;
      for (const fileResults of packGroup.files.values()) packCount += fileResults.length;

      nextRows.push({
        type: "pack",
        key: packKey,
        packPath: packGroup.packPath,
        packLabel: packGroup.packLabel,
        count: packCount,
      });
      if (collapsed.has(packKey)) continue;

      for (const [filePath, fileResults] of packGroup.files) {
        const fileKey = `${packKey}|${filePath.toLowerCase()}`;
        nextRows.push({
          type: "file",
          key: fileKey,
          packPath: packGroup.packPath,
          filePath,
          kind: fileResults[0].kind,
          count: fileResults.length,
        });
        if (collapsed.has(fileKey)) continue;

        for (let index = 0; index < fileResults.length; index++) {
          nextRows.push({ type: "result", key: `${fileKey}|${index}`, result: fileResults[index] });
        }
      }
    }

    return nextRows;
  }, [collapsedKeys, results]);

  const openResult = useCallback(
    (result: GlobalSearchResult) => {
      if (result.kind === "db") {
        onOpenDbResult(result);
        return;
      }
      // A model is binary, so there is no viewer for it; only its location is useful.
      if (result.kind === "rigidModel") return;
      onOpenFileResult(result);
    },
    [onOpenDbResult, onOpenFileResult],
  );

  const getRowHeight = useCallback(
    ({ index }: { index: number }) => {
      const row = rows[index];
      if (row.type === "pack") return PACK_ROW_HEIGHT;
      if (row.type === "file") return FILE_ROW_HEIGHT;
      return RESULT_ROW_HEIGHT;
    },
    [rows],
  );

  const renderRow = useCallback(
    ({ index, key, style }: ListRowProps) => {
      const row = rows[index];

      if (row.type === "pack") {
        const isCollapsed = collapsedKeys.includes(row.key);
        return (
          <div key={key} style={style} className="flex items-center">
            <button
              type="button"
              onClick={() => toggleCollapsed(row.key)}
              title={row.packPath}
              className="flex w-full items-center gap-2 px-2 text-left text-xs font-medium text-gray-100 hover:bg-gray-700/60"
            >
              <FontAwesomeIcon icon={isCollapsed ? faChevronRight : faChevronDown} className="w-2.5 shrink-0" />
              <span className="truncate">{row.packLabel}</span>
              <span className="ml-auto shrink-0 tabular-nums text-gray-400">{row.count}</span>
            </button>
          </div>
        );
      }

      if (row.type === "file") {
        const isCollapsed = collapsedKeys.includes(row.key);
        return (
          <div key={key} style={style} className="flex items-center">
            <button
              type="button"
              onClick={() => toggleCollapsed(row.key)}
              title={row.filePath}
              className="flex w-full items-center gap-2 pl-6 pr-2 text-left text-xs text-gray-300 hover:bg-gray-700/60"
            >
              <FontAwesomeIcon icon={isCollapsed ? faChevronRight : faChevronDown} className="w-2.5 shrink-0" />
              <span className="truncate">{shortFileName(row.filePath)}</span>
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-gray-500">
                {globalSearchKindLabels[row.kind]}
              </span>
              <span className="ml-auto shrink-0 tabular-nums text-gray-500">{row.count}</span>
            </button>
          </div>
        );
      }

      const { result } = row;
      const isOpenable = result.kind !== "rigidModel";
      return (
        <div key={key} style={style} className="flex items-center">
          <button
            type="button"
            onClick={() => openResult(result)}
            disabled={!isOpenable}
            title={isOpenable ? undefined : "Rigid models have no viewer; use the path to locate the file."}
            className={
              "flex w-full items-center gap-2 pl-12 pr-2 text-left text-xs " +
              (isOpenable ? "text-gray-300 hover:bg-gray-700/60" : "cursor-default text-gray-400")
            }
          >
            {result.kind === "db" && (
              <>
                <span className="shrink-0 text-gray-500">
                  {result.columnName} · row {result.rowIndex}
                </span>
                <span className="truncate font-mono">
                  {renderHighlighted(result.value, result.matchStart, result.matchEnd)}
                </span>
              </>
            )}
            {result.kind === "loc" && (
              <>
                <span className="shrink-0 text-gray-500">{result.matchedIn}</span>
                <span className="truncate font-mono">
                  {result.matchedIn === "key"
                    ? renderHighlighted(result.key, result.matchStart, result.matchEnd)
                    : renderHighlighted(result.value, result.matchStart, result.matchEnd)}
                </span>
              </>
            )}
            {result.kind === "text" && (
              <>
                <span className="shrink-0 tabular-nums text-gray-500">:{result.line}</span>
                <span className="truncate font-mono">
                  {renderHighlighted(result.excerpt, result.matchStartInExcerpt, result.matchEndInExcerpt)}
                </span>
              </>
            )}
            {result.kind === "rigidModel" && (
              <>
                <span className="shrink-0 tabular-nums text-gray-500">
                  @{result.offset} · {result.encoding}
                </span>
                <span className="truncate font-mono">
                  {renderHighlighted(result.excerpt, result.matchStartInExcerpt, result.matchEndInExcerpt)}
                </span>
              </>
            )}
          </button>
        </div>
      );
    },
    [collapsedKeys, openResult, rows, toggleCollapsed],
  );

  const checkboxClass = "flex shrink-0 items-center gap-1.5 text-xs text-gray-300";

  return (
    <div className="flex h-full flex-col border-t border-gray-600 bg-gray-800" data-testid="global-search-panel">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-2 py-2">
        <label
          className={
            "flex min-w-[16rem] flex-1 items-center gap-2 rounded border bg-gray-900 px-2 " +
            (isRegexValid ? "border-gray-700" : "border-amber-600")
          }
        >
          <IoSearch className="shrink-0 text-gray-500" />
          <input
            ref={queryInputRef}
            aria-label={localized.globalSearchQueryLabel || "Global search"}
            value={query}
            maxLength={MAX_GLOBAL_SEARCH_QUERY_LENGTH}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleSearch();
            }}
            placeholder={localized.globalSearchPlaceholder || "Search packs…"}
            className="w-full bg-transparent py-1.5 text-sm text-white outline-none"
          />
        </label>

        <label className={checkboxClass}>
          <input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)} />
          {localized.globalSearchCaseSensitive || "Case sensitive"}
        </label>
        <label className={checkboxClass}>
          <input type="checkbox" checked={isRegex} onChange={(event) => setIsRegex(event.target.checked)} />
          {localized.globalSearchRegex || "Regex"}
        </label>

        {isSearching ? (
          <button
            type="button"
            onClick={handleStop}
            className="shrink-0 rounded bg-red-700 px-4 py-1.5 text-xs font-medium uppercase text-white hover:bg-red-600"
          >
            {localized.globalSearchStop || "Stop"}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void handleSearch()}
            disabled={!canSearch}
            className="shrink-0 rounded bg-purple-600 px-4 py-1.5 text-xs font-medium uppercase text-white hover:bg-purple-700 disabled:cursor-not-allowed disabled:bg-gray-700 disabled:text-gray-500"
          >
            {localized.search || "Search"}
          </button>
        )}

        <button
          type="button"
          onClick={onClose}
          aria-label={localized.globalSearchClose || "Close global search"}
          className="shrink-0 px-1 text-gray-400 hover:text-white"
        >
          <FontAwesomeIcon icon={faXmark} />
        </button>
      </div>

      {!isRegexValid && (
        <div className="px-2 pb-1 text-[11px] text-amber-500">
          {localized.globalSearchInvalidRegex || "Not a valid regular expression yet."}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-gray-700 px-2 py-2">
        <span className="text-[11px] uppercase tracking-wide text-gray-500">
          {localized.globalSearchIn || "Search in"}
        </span>
        {GLOBAL_SEARCH_RESULT_KINDS.map((kind) => (
          <label key={kind} className={checkboxClass}>
            <input type="checkbox" checked={kinds[kind]} onChange={() => toggleKind(kind)} />
            {globalSearchKindLabels[kind]}
            {kind === "rigidModel" && <span className="text-gray-500">(slow)</span>}
          </label>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-gray-700 px-2 py-2">
        <span className="text-[11px] uppercase tracking-wide text-gray-500">
          {localized.globalSearchSources || "Sources"}
        </span>
        <label className={checkboxClass}>
          <input type="checkbox" checked={searchVanilla} onChange={(event) => setSearchVanilla(event.target.checked)} />
          {localized.globalSearchVanillaPacks || "Vanilla packs"}
        </label>
        <label className={checkboxClass}>
          <input
            type="checkbox"
            checked={includeEnabledMods || includeAllMods}
            disabled={includeAllMods}
            title={includeAllMods ? "Already covered by All mods" : undefined}
            onChange={(event) => setIncludeEnabledMods(event.target.checked)}
          />
          {localized.globalSearchEnabledMods || "Enabled mods"}
          {packCatalog.length > 0 && <span className="text-gray-500">({enabledModCount})</span>}
        </label>
        <label className={checkboxClass}>
          <input
            type="checkbox"
            checked={includeAllMods}
            onChange={(event) => setIncludeAllMods(event.target.checked)}
          />
          {localized.globalSearchAllMods || "All mods"}
          {packCatalog.length > 0 && <span className="text-gray-500">({packCatalog.length})</span>}
        </label>

        {openPacks.length > 0 && (
          <>
            <span className="text-[11px] uppercase tracking-wide text-gray-500">
              {localized.globalSearchOpenPacks || "Open packs"}
            </span>
            {openPacks.map((pack) => (
              <label key={pack.packPath} className={checkboxClass} title={pack.packPath}>
                <input
                  type="checkbox"
                  checked={selectedOpenPackKeys.includes(packPathKey(pack.packPath))}
                  onChange={() => toggleOpenPack(pack.packPath)}
                />
                <span className="max-w-[12rem] truncate">{pack.label}</span>
              </label>
            ))}
          </>
        )}
      </div>

      {(isSearching || progress) && (
        <div className="flex items-center gap-3 border-t border-gray-700 px-2 py-1 text-xs text-gray-400">
          {isSearching && (
            <div
              aria-hidden="true"
              className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-gray-600 border-t-blue-400"
            />
          )}
          {progress && (
            <>
              <span className="tabular-nums">
                {progress.targetsDone}/{progress.targetsTotal} packs
              </span>
              {progress.currentLabel && <span className="truncate">{progress.currentLabel}</span>}
              {progress.filesScanned > 0 && <span className="tabular-nums">{progress.filesScanned} files</span>}
            </>
          )}
          <span className="ml-auto shrink-0 tabular-nums">{results.length} matches</span>
        </div>
      )}

      {error && <div className="border-t border-gray-700 px-2 py-2 text-xs text-red-300">{error}</div>}

      {warnings.map((warning) => (
        <div key={warning} className="border-t border-gray-700 px-2 py-1 text-[11px] text-amber-500">
          {warning}
        </div>
      ))}

      {(isTruncated || wasCanceled || skippedFiles.length > 0) && (
        <div className="border-t border-gray-700 px-2 py-1 text-[11px] text-gray-400">
          {isTruncated && <span className="mr-3">Showing the first {results.length} matches.</span>}
          {wasCanceled && <span className="mr-3">Search stopped early.</span>}
          {skippedFiles.length > 0 && <span>{skippedFiles.length} file(s) skipped.</span>}
        </div>
      )}

      <div className="min-h-0 flex-1 border-t border-gray-700">
        {rows.length === 0 ? (
          <div className="p-3 text-xs text-gray-500">
            {!hasSearched
              ? localized.globalSearchIdle || "Pick what to search and where, then press Search."
              : isSearching
                ? localized.globalSearchRunning || "Searching…"
                : error
                  ? ""
                  : localized.globalSearchNoMatches || "No matches."}
          </div>
        ) : (
          <AutoSizer>
            {({ height, width }) => (
              <List
                width={width}
                height={height}
                rowCount={rows.length}
                rowHeight={getRowHeight}
                rowRenderer={renderRow}
                overscanRowCount={12}
              />
            )}
          </AutoSizer>
        )}
      </div>
    </div>
  );
});

export default GlobalSearchPanel;
