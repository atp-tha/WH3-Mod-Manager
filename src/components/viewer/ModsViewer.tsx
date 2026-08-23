import React, { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "react-redux";
import { useAppDispatch, useAppSelector } from "../../hooks";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChevronDown, faFile, faMagnifyingGlass, faXmark } from "@fortawesome/free-solid-svg-icons";
import PackTablesTreeView, { CopyIntoSource, PackTablesTreeViewHandle, ViewerPackTarget } from "./PackTablesTreeView";
import PackFileView from "./PackFileView";
import PackTablesTableView from "./PackTablesTableView";
import { Resizable } from "re-resizable";
import debounce from "just-debounce-it";
import localizationContext from "../../localizationContext";
import { gameToPackWithDBTablesName } from "../../supportedGames";
import { Modal } from "@/src/flowbite";
import DBDuplication from "@/src/components/viewer/DBDuplication";
import {
  removePackData,
  requestFlowFileReload,
  selectDBTable,
  selectFlowFile,
  setDeepCloneTarget,
  setPacksData,
} from "@/src/appSlice";
import NodeEditor from "../NodeEditor";
import type { RootState } from "../../store";
import type { PackedFile } from "@/src/packFileTypes";
import type { ShowViewerDialog } from "./viewerDialogs";
import { makeSelectCurrentPackData, makeSelectCurrentPackUnsavedFiles } from "./viewerSelectors";
import {
  DEFAULT_DB_TABLE_ROOT,
  UNUSED_DB_TABLE_ROOT,
  getDBGroupName,
  getDBPackedFilePath,
  getPackNameFromPath,
  parseDBTablePath,
} from "@/src/utility/packFileHelpers";
import { clearPackDataStoreForPack } from "./packDataStore";
import { clearPreparedTableForPack } from "./tablePrepCache";
import { getDefaultSaveAsPackName, getPackFileInventory, getPreferredTreeTab, hasLoadedDBTable } from "./viewerHelpers";
import GlobalSearchPanel from "./GlobalSearchPanel";
import { useKeepMountedOnceActive } from "../useKeepMountedOnceActive";
import type { GlobalSearchDbResult, GlobalSearchResult } from "@/src/globalSearch/types";

type ViewerTabKind = "db" | "flow" | "file";

type ViewerTab = {
  id: string;
  fileKey: string;
  title: string;
  kind: ViewerTabKind;
  packPath: string;
  dbName?: string;
  dbSubname?: string;
  /** Absent means the live "db" folder, matching DBTable. */
  dbFolder?: string;
  flowFile?: string;
  filePath?: string;
};

type ViewerTabCandidate = Omit<ViewerTab, "id">;

type PackTab = { packPath: string; openTabs: ViewerTab[]; activeTabId: string | null };
type CopyOverwriteRequest = {
  source: CopyIntoSource;
  targetPackPath: string;
  openAfterCopy: boolean;
  filePath: string;
};
type CopyTableNameRequest = {
  source: CopyIntoSource;
  targetPackPath: string;
  openAfterCopy: boolean;
  tableName: string;
  filePath: string;
  exactFileExists: boolean;
};
const EMPTY_TABS: ViewerTab[] = [];
/** Below this the modder File button cannot show its label inside the sidebar's width. */
const TOOLBAR_ICON_ONLY_SIDEBAR_WIDTH = 300;

const copyPackPathKey = (value: string) => value.replaceAll("/", "\\").toLowerCase();

const getRenamedDBTablePath = (filePath: string, tableName: string): string | undefined => {
  const parsed = parseDBTablePath(filePath);
  const trimmedTableName = tableName.trim();
  if (
    !parsed ||
    (parsed.dbFolder !== DEFAULT_DB_TABLE_ROOT && parsed.dbFolder !== UNUSED_DB_TABLE_ROOT) ||
    !trimmedTableName ||
    /[\\/]/.test(trimmedTableName)
  ) {
    return undefined;
  }

  return `${parsed.dbFolder}\\${trimmedTableName}\\${parsed.dbSubname}`;
};

const getDBTableNameForCopy = (filePath: string): string | undefined => {
  const parsed = parseDBTablePath(filePath);
  if (!parsed || (parsed.dbFolder !== DEFAULT_DB_TABLE_ROOT && parsed.dbFolder !== UNUSED_DB_TABLE_ROOT))
    return undefined;
  return parsed.dbName;
};

const hasDBSelectionTarget = (selection?: DBTableSelection): selection is DBTableSelection =>
  Boolean(selection?.packPath && selection.dbName && selection.dbSubname);

const getPackFileName = (packPath: string) => packPath.split(/[\\/]/).pop() ?? packPath;

const ModsViewer = memo(() => {
  const dispatch = useAppDispatch();
  const viewerStore = useStore<RootState>();
  const currentDBTableSelection = useAppSelector((state) => state.app.currentDBTableSelection);
  const currentFlowFileSelection = useAppSelector((state) => state.app.currentFlowFileSelection);
  const currentFlowFilePackPath = useAppSelector((state) => state.app.currentFlowFilePackPath);
  const currentGame = useAppSelector((state) => state.app.currentGame);
  const isFeaturesForModdersEnabled = useAppSelector((state) => state.app.isFeaturesForModdersEnabled);
  // Use currentFlowFilePackPath if a flow file is selected, otherwise use DB table pack path.
  // This is only the Redux fallback for the content pane; pack tabs own the active path once opened.
  const reduxFallbackPackPath =
    currentFlowFilePackPath ??
    currentDBTableSelection?.packPath ??
    (gameToPackWithDBTablesName[currentGame] || "db.pack");
  const deepCloneTarget = useAppSelector((state) => state.app.deepCloneTarget);
  const startArgs = useAppSelector((state) => state.app.startArgs);
  const packsDataByPath = useAppSelector((state) => state.app.packsData);
  const unsavedPacksDataByPath = useAppSelector((state) => state.app.unsavedPacksData);
  const dbPackName = gameToPackWithDBTablesName[currentGame] || "db.pack";
  const selectCurrentPackData = useMemo(makeSelectCurrentPackData, []);
  const selectCurrentPackUnsavedFiles = useMemo(makeSelectCurrentPackUnsavedFiles, []);

  const [isOpen, setIsOpen] = React.useState(true);
  const [isSaveAsModalOpen, setIsSaveAsModalOpen] = React.useState(false);
  const [saveAsPackName, setSaveAsPackName] = React.useState("");
  const [saveAsDirectory, setSaveAsDirectory] = React.useState<string | undefined>(undefined);
  const [isSaveAsProcessing, setIsSaveAsProcessing] = React.useState(false);
  /** Path of the pack Save As would replace, while we ask whether to. */
  const [overwriteConfirmPath, setOverwriteConfirmPath] = React.useState<string | null>(null);
  const [isNewPackModalOpen, setIsNewPackModalOpen] = React.useState(false);
  const [newPackName, setNewPackName] = React.useState("");
  const [isNewPackProcessing, setIsNewPackProcessing] = React.useState(false);
  const [isFileMenuOpen, setIsFileMenuOpen] = useState(false);
  const [packCloseConfirmPath, setPackCloseConfirmPath] = useState<string | null>(null);
  const [copyOverwriteRequest, setCopyOverwriteRequest] = useState<CopyOverwriteRequest | null>(null);
  const [copyTableNameRequest, setCopyTableNameRequest] = useState<CopyTableNameRequest | null>(null);
  const [copyTableName, setCopyTableName] = useState("");
  const [isCopyProcessing, setIsCopyProcessing] = useState(false);
  const [packTabs, setPackTabs] = useState<PackTab[]>([]);
  const [activePackPath, setActivePackPath] = useState<string | null>(null);
  // Written synchronously so a handler can create a pack tab and open a file tab in it in one tick,
  // before setActivePackPath has been applied.
  const activePackPathRef = useRef<string | null>(null);
  const activatePackTab = useCallback((packPath: string | null) => {
    activePackPathRef.current = packPath;
    setActivePackPath(packPath);
  }, []);
  const activePackTab = useMemo(
    () => packTabs.find((packTab) => packTab.packPath === activePackPath) ?? null,
    [packTabs, activePackPath],
  );
  const openTabs = activePackTab?.openTabs ?? EMPTY_TABS;
  const activeTabId = activePackTab?.activeTabId ?? null;
  const isDBPackOpen = packTabs.some((packTab) => {
    const packName = packsDataByPath[packTab.packPath]?.packName ?? getPackFileName(packTab.packPath);
    return packName.toLowerCase() === dbPackName.toLowerCase();
  });
  const setOpenTabs = useCallback((action: React.SetStateAction<ViewerTab[]>) => {
    const targetPackPath = activePackPathRef.current;
    if (!targetPackPath) return;
    setPackTabs((prev) =>
      prev.map((packTab) =>
        packTab.packPath !== targetPackPath
          ? packTab
          : { ...packTab, openTabs: typeof action === "function" ? action(packTab.openTabs) : action },
      ),
    );
  }, []);
  const setActiveTabId = useCallback((tabId: string | null) => {
    const targetPackPath = activePackPathRef.current;
    if (!targetPackPath) return;
    setPackTabs((prev) =>
      prev.map((packTab) => (packTab.packPath === targetPackPath ? { ...packTab, activeTabId: tabId } : packTab)),
    );
  }, []);
  const [messageDialog, setMessageDialog] = useState<{ title: string; message: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const activeTab = useMemo(() => openTabs.find((tab) => tab.id === activeTabId) ?? null, [openTabs, activeTabId]);
  const activeViewerPackPath = activePackPath ?? reduxFallbackPackPath;
  const currentPackData = useAppSelector((state) => selectCurrentPackData(state, activeViewerPackPath));
  const unsavedFiles = useAppSelector((state) => selectCurrentPackUnsavedFiles(state, activeViewerPackPath));
  const packOpenRequest = useAppSelector((state) => state.app.packOpenRequest);
  const packFileInventory = useMemo(
    () => (currentPackData ? getPackFileInventory(currentPackData, unsavedFiles) : undefined),
    [currentPackData, unsavedFiles],
  );

  const preferredTreeTabCacheRef = useRef<
    Record<
      string,
      {
        packData: PackViewData | undefined;
        unsavedFiles: PackedFile[] | undefined;
        openTabs: ViewerTab[];
        activeTabId: string | null;
        preferredTab: "db" | "files";
      }
    >
  >({});
  // Choosing the tree's sub-tab scans a pack's whole file list, so it is cached per pack against the
  // inputs it actually reads. A plain memo over the three maps would rescan every open pack whenever
  // any one of them changed, which is once per table edit.
  const preferredTreeTabByPackPath = useMemo(() => {
    const cache = preferredTreeTabCacheRef.current;
    const preferredTabs: Record<string, "db" | "files"> = {};

    for (const packTab of packTabs) {
      const packData = packsDataByPath[packTab.packPath];
      const unsavedFiles = unsavedPacksDataByPath[packTab.packPath];
      const cached = cache[packTab.packPath];
      if (
        cached &&
        cached.packData === packData &&
        cached.unsavedFiles === unsavedFiles &&
        cached.openTabs === packTab.openTabs &&
        cached.activeTabId === packTab.activeTabId
      ) {
        preferredTabs[packTab.packPath] = cached.preferredTab;
        continue;
      }

      const preferredTab = getPreferredTreeTab(packTab, packsDataByPath, unsavedPacksDataByPath);
      cache[packTab.packPath] = {
        packData,
        unsavedFiles,
        openTabs: packTab.openTabs,
        activeTabId: packTab.activeTabId,
        preferredTab,
      };
      preferredTabs[packTab.packPath] = preferredTab;
    }

    return preferredTabs;
  }, [packTabs, packsDataByPath, unsavedPacksDataByPath]);

  const treeViewRefs = useRef<Record<string, PackTablesTreeViewHandle | null>>({});
  const treeScrollTopsRef = useRef<Record<string, number>>({});
  const treeScrollElementsRef = useRef<Record<string, HTMLDivElement | null>>({});
  const viewerRootRef = useRef<HTMLDivElement>(null);
  const sidebarResizableRef = useRef<Resizable>(null);
  const fileMenuRef = useRef<HTMLDivElement>(null);
  const fileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const [isSidebarNarrow, setIsSidebarNarrow] = useState(false);
  const [isGlobalSearchOpen, setIsGlobalSearchOpen] = useState(false);
  // Hidden rather than unmounted once it has been opened, so closing and reopening keeps the query,
  // the options and the results that are already in. Nothing is paid for until the first open.
  const isGlobalSearchMounted = useKeepMountedOnceActive(isGlobalSearchOpen);
  /**
   * A result whose pack the viewer has not loaded yet, held until it arrives.
   *
   * Opening a tab is not enough for such a pack: the content pane shows "Loading pack…" until
   * packsData carries it, and only requestOpenModInViewer makes main read and push it.
   */
  const pendingSearchNavigationRef = useRef<{ packPath: string; apply: () => void } | null>(null);
  const saveAsPackNameInputRef = useRef<HTMLInputElement>(null);
  const newPackNameInputRef = useRef<HTMLInputElement>(null);
  const copyTableNameInputRef = useRef<HTMLInputElement>(null);
  const tabIdCounterRef = useRef(0);
  const lastActionRef = useRef<{ key: string; at: number; openedNew: boolean; tabId?: string } | null>(null);
  const lastHandledPackOpenNonceRef = useRef(0);
  const didRunTestDBCloneRef = useRef(false);
  const lastObservedPackOpenNonceRef = useRef(0);
  const pendingPackOpenRequestsRef = useRef<PackOpenRequest[]>([]);
  const [packOpenRequestVersion, setPackOpenRequestVersion] = useState(0);
  const lastSelectionKeyRef = useRef<string | null>(null);
  const lastProcessedSelectionRequestKeyRef = useRef<string | null>(null);
  const suppressSelectionToTabSyncRef = useRef(false);
  const currentDBTableSelectionRef = useRef(currentDBTableSelection);
  const currentFlowFileSelectionRef = useRef(currentFlowFileSelection);
  const currentFlowFilePackPathRef = useRef(currentFlowFilePackPath);

  const localized: Record<string, string> = useContext(localizationContext);

  const showDialog = useCallback<ShowViewerDialog>((message, options) => {
    setMessageDialog({ title: options?.title ?? "Message", message });
  }, []);

  /** For outcomes worth confirming but not worth a click to dismiss, like a successful save. */
  const showToast = useCallback((message: string) => {
    setToast(message);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    currentDBTableSelectionRef.current = currentDBTableSelection;
    currentFlowFileSelectionRef.current = currentFlowFileSelection;
    currentFlowFilePackPathRef.current = currentFlowFilePackPath;
  }, [currentDBTableSelection, currentFlowFilePackPath, currentFlowFileSelection]);

  // Focus on the Save As pack name input when modal opens
  useEffect(() => {
    if (isSaveAsModalOpen && saveAsPackNameInputRef.current) {
      window.focus();
      setTimeout(() => {
        saveAsPackNameInputRef.current?.focus();
        // The field arrives prefilled with the open pack's name, so select it: typing replaces it,
        // and clicking puts the caret where you clicked.
        saveAsPackNameInputRef.current?.select();
      }, 0);
    }
  }, [isSaveAsModalOpen]);

  // Focus on the New Pack name input when modal opens
  useEffect(() => {
    if (isNewPackModalOpen && newPackNameInputRef.current) {
      window.focus();
      setTimeout(() => {
        newPackNameInputRef.current?.focus();
      }, 0);
    }
  }, [isNewPackModalOpen]);

  useEffect(() => {
    if (!copyTableNameRequest || !copyTableNameInputRef.current) return;
    window.focus();
    setTimeout(() => {
      copyTableNameInputRef.current?.focus();
      copyTableNameInputRef.current?.select();
    }, 0);
  }, [copyTableNameRequest]);

  useEffect(() => {
    if (!isFileMenuOpen) return;

    const dismissFileMenu = (event: MouseEvent) => {
      if (fileMenuRef.current?.contains(event.target as Node)) return;
      setIsFileMenuOpen(false);
    };
    const closeFileMenuOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setIsFileMenuOpen(false);
      fileMenuButtonRef.current?.focus();
    };

    document.addEventListener("mousedown", dismissFileMenu, true);
    document.addEventListener("keydown", closeFileMenuOnEscape);
    return () => {
      document.removeEventListener("mousedown", dismissFileMenu, true);
      document.removeEventListener("keydown", closeFileMenuOnEscape);
    };
  }, [isFileMenuOpen]);

  useEffect(() => {
    if (!isFeaturesForModdersEnabled) setIsFileMenuOpen(false);
  }, [isFeaturesForModdersEnabled]);

  const [dbTableFilter, setDBTableFilter] = useState("");

  const onFilterChangeDebounced = useMemo(
    () =>
      debounce((value: string) => {
        setDBTableFilter(value);
      }, 250),
    [setDBTableFilter],
  );

  const clearFilter = () => {
    setDBTableFilter("");
  };

  const createTabId = useCallback(() => `tab-${Date.now()}-${++tabIdCounterRef.current}`, []);

  const buildDbTabCandidate = useCallback((selection: DBTableSelection): ViewerTabCandidate => {
    const packLabel = getPackNameFromPath(selection.packPath) ?? selection.packPath;
    // The folder belongs in both: without it a spare copy and the live table are the same tab, and
    // the titles would be indistinguishable even if they were not.
    const groupName = getDBGroupName(selection.dbFolder || DEFAULT_DB_TABLE_ROOT, selection.dbName);
    return {
      fileKey: `db|${selection.packPath}|${getDBPackedFilePath(selection)}`,
      title: `${groupName}/${selection.dbSubname}${packLabel ? ` | ${packLabel}` : ""}`,
      kind: "db",
      packPath: selection.packPath,
      dbFolder: selection.dbFolder,
      dbName: selection.dbName,
      dbSubname: selection.dbSubname,
    };
  }, []);

  const buildFlowTabCandidate = useCallback((flowFile: string, packPath: string): ViewerTabCandidate => {
    const packLabel = getPackNameFromPath(packPath) ?? packPath;
    const shortFlowName = flowFile.replace(/^whmmflows[\\/]/, "");
    const flowLabel = shortFlowName ? `Flow:${shortFlowName}` : flowFile;
    return {
      fileKey: `flow|${packPath}|${flowFile}`,
      title: `${flowLabel}${packLabel ? ` | ${packLabel}` : ""}`,
      kind: "flow",
      packPath,
      flowFile,
    };
  }, []);

  const buildPackedFileTabCandidate = useCallback((filePath: string, packPath: string): ViewerTabCandidate => {
    const packLabel = getPackNameFromPath(packPath) ?? packPath;
    const shortFileName = filePath.split(/[\\/]/).pop() ?? filePath;
    return {
      fileKey: `file|${packPath}|${filePath}`,
      title: `${shortFileName}${packLabel ? ` | ${packLabel}` : ""}`,
      kind: "file",
      packPath,
      filePath,
    };
  }, []);

  const openOrActivatePackTab = useCallback(
    (packPath: string) => {
      setPackTabs((prev) =>
        prev.some((packTab) => packTab.packPath === packPath)
          ? prev
          : [...prev, { packPath, openTabs: [], activeTabId: null }],
      );
      activatePackTab(packPath);
    },
    [activatePackTab],
  );

  const openOrActivateTab = useCallback(
    (candidate: ViewerTabCandidate, options: { forceNewTab?: boolean } = {}) => {
      // Routing to the candidate's pack first means every decision below has to read that pack's
      // tabs, not the ones still closed over from whichever pack was active a moment ago.
      if (activePackPathRef.current !== candidate.packPath) openOrActivatePackTab(candidate.packPath);
      const targetPackTab = packTabs.find((packTab) => packTab.packPath === candidate.packPath) ?? null;
      const targetOpenTabs = targetPackTab?.openTabs ?? EMPTY_TABS;
      const targetActiveTabId = targetPackTab?.activeTabId ?? null;
      const now = Date.now();
      const lastAction = lastActionRef.current;
      const actionKey = `${candidate.packPath}|${candidate.fileKey}`;
      const isJustOpenedSame =
        lastAction && lastAction.key === actionKey && lastAction.openedNew && now - lastAction.at < 350;

      if (options.forceNewTab && isJustOpenedSame && lastAction?.tabId) {
        setActiveTabId(lastAction.tabId);
        return;
      }

      // Reuse existing tab with same fileKey instead of always creating a new one
      if (options.forceNewTab) {
        const existingTab =
          targetOpenTabs.find((tab) => tab.fileKey === candidate.fileKey && tab.id !== targetActiveTabId) ??
          targetOpenTabs.find((tab) => tab.fileKey === candidate.fileKey);
        if (existingTab) {
          setActiveTabId(existingTab.id);
          lastActionRef.current = { key: actionKey, at: now, openedNew: false, tabId: existingTab.id };
          return;
        }
      }

      let openedNew = false;
      let tabToActivate: ViewerTab;

      if (options.forceNewTab || !targetActiveTabId) {
        const newTab: ViewerTab = { id: createTabId(), ...candidate };
        openedNew = true;
        tabToActivate = newTab;
        setOpenTabs((prevTabs) => [...prevTabs, newTab]);
      } else {
        const activeTabIndex = targetOpenTabs.findIndex((tab) => tab.id === targetActiveTabId);
        if (activeTabIndex < 0) {
          const newTab: ViewerTab = { id: createTabId(), ...candidate };
          openedNew = true;
          tabToActivate = newTab;
          setOpenTabs((prevTabs) => [...prevTabs, newTab]);
        } else {
          tabToActivate = { ...targetOpenTabs[activeTabIndex], ...candidate };
          setOpenTabs((prevTabs) => prevTabs.map((tab) => (tab.id === tabToActivate.id ? tabToActivate : tab)));
        }
      }

      setActiveTabId(tabToActivate.id);
      lastActionRef.current = { key: actionKey, at: now, openedNew, tabId: tabToActivate.id };
      if (tabToActivate.kind === "db" && tabToActivate.dbName && tabToActivate.dbSubname) {
        const selection = {
          dbFolder: tabToActivate.dbFolder,
          dbName: tabToActivate.dbName,
          dbSubname: tabToActivate.dbSubname,
          packPath: tabToActivate.packPath,
        };
        const isLoaded = hasLoadedDBTable(
          packsDataByPath[tabToActivate.packPath],
          unsavedPacksDataByPath[tabToActivate.packPath] ?? [],
          selection,
        );
        if (!isLoaded) {
          window.api?.getPackData(tabToActivate.packPath, selection);
        }
      }
    },
    [
      createTabId,
      openOrActivatePackTab,
      packTabs,
      packsDataByPath,
      setActiveTabId,
      setOpenTabs,
      unsavedPacksDataByPath,
    ],
  );

  const handleOpenDBTable = useCallback(
    (selection: DBTableSelection, options?: { forceNewTab?: boolean }) => {
      if (!hasDBSelectionTarget(selection)) return;
      openOrActivateTab(buildDbTabCandidate(selection), options);
    },
    [buildDbTabCandidate, openOrActivateTab],
  );

  const handleOpenFlowFile = useCallback(
    (selection: { flowFile: string; packPath: string }, options?: { forceNewTab?: boolean }) => {
      openOrActivateTab(buildFlowTabCandidate(selection.flowFile, selection.packPath), options);
      // Picking a flow here means "show me what is in the pack", which is how you get its saved
      // contents back after replacing the graph in place. Landing on the flow the editor already
      // holds moves neither the tab nor the selection, whether it opens in this tab or another one,
      // so the reload has to be asked for rather than left to those changing.
      dispatch(requestFlowFileReload());
    },
    [buildFlowTabCandidate, dispatch, openOrActivateTab],
  );

  const handleOpenPackedFile = useCallback(
    (selection: { filePath: string; packPath: string }, options?: { forceNewTab?: boolean }) => {
      openOrActivateTab(buildPackedFileTabCandidate(selection.filePath, selection.packPath), options);
    },
    [buildPackedFileTabCandidate, openOrActivateTab],
  );

  const isPackLoaded = useCallback(
    (packPath: string) =>
      Object.keys(packsDataByPath).some((loadedPath) => copyPackPathKey(loadedPath) === copyPackPathKey(packPath)),
    [packsDataByPath],
  );

  /** Applies a selection now when its pack is loaded, or asks main for the pack and applies it then. */
  const navigateToPack = useCallback(
    (packPath: string, apply: () => void) => {
      if (isPackLoaded(packPath)) {
        apply();
        return;
      }
      pendingSearchNavigationRef.current = { packPath, apply };
      window.api?.requestOpenModInViewer(packPath);
    },
    [isPackLoaded],
  );

  useEffect(() => {
    const pending = pendingSearchNavigationRef.current;
    if (!pending || !isPackLoaded(pending.packPath)) return;
    pendingSearchNavigationRef.current = null;
    pending.apply();
  }, [isPackLoaded, packsDataByPath]);

  const handleOpenGlobalSearchDbResult = useCallback(
    (result: GlobalSearchDbResult) => {
      navigateToPack(result.packPath, () =>
        handleOpenDBTable({
          packPath: result.packPath,
          dbName: result.dbName,
          dbSubname: result.dbSubname,
          dbFolder: result.dbFolder,
        }),
      );
    },
    [handleOpenDBTable, navigateToPack],
  );

  const handleOpenGlobalSearchFileResult = useCallback(
    (result: Exclude<GlobalSearchResult, GlobalSearchDbResult>) => {
      navigateToPack(result.packPath, () =>
        handleOpenPackedFile({ packPath: result.packPath, filePath: result.filePath }),
      );
    },
    [handleOpenPackedFile, navigateToPack],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Ctrl/Cmd+Shift+F, the search-across-files chord every editor uses. It toggles: the same
      // keystroke puts the dock away, and the panel keeps its state while hidden.
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      setIsGlobalSearchOpen((isPanelOpen) => !isPanelOpen);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const globalSearchOpenPacks = useMemo(
    () =>
      packTabs.map((packTab) => ({
        packPath: packTab.packPath,
        label: packsDataByPath[packTab.packPath]?.packName ?? getPackNameFromPath(packTab.packPath) ?? packTab.packPath,
      })),
    [packTabs, packsDataByPath],
  );

  const getTargetPackFileNames = useCallback(
    async (targetPackPath: string): Promise<Set<string> | undefined> => {
      const targetPackDataPath = Object.keys(packsDataByPath).find(
        (packPath) => copyPackPathKey(packPath) === copyPackPathKey(targetPackPath),
      );
      const targetUnsavedDataPath = Object.keys(unsavedPacksDataByPath).find(
        (packPath) => copyPackPathKey(packPath) === copyPackPathKey(targetPackPath),
      );
      const targetPackData = targetPackDataPath ? packsDataByPath[targetPackDataPath] : undefined;
      const targetUnsavedFiles = targetUnsavedDataPath
        ? unsavedPacksDataByPath[targetUnsavedDataPath] || []
        : undefined;

      if (targetPackData || targetUnsavedFiles) {
        return new Set([
          ...(targetPackData?.tables || []),
          ...Object.keys(targetPackData?.packedFiles || {}),
          ...(targetUnsavedFiles || []).map((file) => file.name),
        ]);
      }

      if (!window.api?.getPackFilesList) return undefined;
      return new Set(await window.api.getPackFilesList(targetPackPath));
    },
    [packsDataByPath, unsavedPacksDataByPath],
  );

  const handleCopyInto = useCallback(
    async (
      source: CopyIntoSource,
      targetPackPath: string,
      openAfterCopy: boolean,
      overwriteExisting = false,
      destinationFilePath?: string,
    ) => {
      setIsCopyProcessing(true);
      try {
        const sourceTableName = getDBTableNameForCopy(source.filePath);
        if (sourceTableName && !overwriteExisting) {
          const targetFileNames = await getTargetPackFileNames(targetPackPath);
          if (targetFileNames) {
            const hasTableName = (tableName: string) =>
              [...targetFileNames].some((filePath) => {
                const targetTableName = getDBTableNameForCopy(filePath);
                return targetTableName?.toLowerCase() === tableName.toLowerCase();
              });

            if (destinationFilePath) {
              const destinationTableName = getDBTableNameForCopy(destinationFilePath);
              if (destinationTableName && hasTableName(destinationTableName)) {
                showDialog(`The destination already contains a table named "${destinationTableName}"`, {
                  title: "Table Already Exists",
                });
                return;
              }
            }

            const hasSameTableName = !destinationFilePath && hasTableName(sourceTableName);
            if (hasSameTableName) {
              setCopyTableNameRequest({
                source,
                targetPackPath,
                openAfterCopy,
                tableName: sourceTableName,
                filePath: source.filePath,
                exactFileExists: [...targetFileNames].some(
                  (filePath) => copyPackPathKey(filePath) === copyPackPathKey(source.filePath),
                ),
              });
              setCopyTableName(sourceTableName);
              return;
            }
          }
        }

        let result:
          | {
              success: boolean;
              targetPackPath?: string;
              filePath?: string;
              overwriteRequired?: boolean;
              tableNameRequired?: boolean;
              tableName?: string;
              error?: string;
            }
          | undefined;

        if (source.kind === "dbRows") {
          if (!source.rows || !source.tableSchema) {
            result = { success: false, error: "The selected rows do not have a table schema" };
          } else {
            const copiedFile: PackedFile = {
              name: destinationFilePath || source.filePath,
              file_size: 0,
              start_pos: -1,
              is_compressed: false,
              schemaFields: source.rows.flat(),
              tableSchema: source.tableSchema,
              version: source.version,
            };
            const saveResult = await window.api?.saveDBTableEdits(targetPackPath, copiedFile);
            result = saveResult?.success
              ? { success: true, targetPackPath, filePath: copiedFile.name }
              : { success: false, error: saveResult?.error || "Failed to save copied rows" };
          }
        } else if (destinationFilePath) {
          result = await window.api?.copyPackedFileToPack(
            source.packPath,
            source.filePath,
            targetPackPath,
            overwriteExisting,
            destinationFilePath,
          );
        } else {
          result = await window.api?.copyPackedFileToPack(
            source.packPath,
            source.filePath,
            targetPackPath,
            overwriteExisting,
          );
        }

        if (result?.tableNameRequired && !destinationFilePath && !overwriteExisting) {
          setCopyTableNameRequest({
            source,
            targetPackPath,
            openAfterCopy,
            tableName: result.tableName || sourceTableName || "",
            filePath: result.filePath || source.filePath,
            exactFileExists: false,
          });
          setCopyTableName(result.tableName || sourceTableName || "");
          return;
        }
        if (result?.overwriteRequired && !overwriteExisting) {
          setCopyOverwriteRequest({
            source,
            targetPackPath,
            openAfterCopy,
            filePath: result.filePath || source.filePath,
          });
          return;
        }
        if (!result?.success) {
          showDialog(`Failed to copy ${source.filePath}: ${result?.error || "Unknown error"}`, {
            title: "Copy Failed",
          });
          return;
        }

        setCopyOverwriteRequest(null);
        setCopyTableNameRequest(null);
        setCopyTableName("");
        if (!openAfterCopy) return;

        const copiedPackPath = result.targetPackPath || targetPackPath;
        const copiedFilePath = result.filePath || destinationFilePath || source.filePath;
        const targetWasAlreadyOpen = packTabs.some((packTab) => packTab.packPath === copiedPackPath);
        if (!targetWasAlreadyOpen && !copiedPackPath.startsWith("memory://")) {
          // This asks the main process to load the destination's file index and register its viewer
          // tab. The local tab is opened immediately below so the copied file can be selected in the
          // same interaction, even while that index is still arriving.
          window.api?.requestOpenModInViewer(copiedPackPath);
        }
        openOrActivatePackTab(copiedPackPath);

        if ((source.kind === "db" || source.kind === "dbRows") && source.dbSelection) {
          const copiedTable = parseDBTablePath(copiedFilePath);
          handleOpenDBTable({
            ...source.dbSelection,
            ...(copiedTable
              ? {
                  dbFolder: copiedTable.dbFolder,
                  dbName: copiedTable.dbName,
                  dbSubname: copiedTable.dbSubname,
                }
              : {}),
            packPath: copiedPackPath,
          });
        } else if (copiedFilePath.startsWith("whmmflows\\")) {
          handleOpenFlowFile({ flowFile: copiedFilePath, packPath: copiedPackPath });
        } else {
          handleOpenPackedFile({ filePath: copiedFilePath, packPath: copiedPackPath });
        }
      } catch (error) {
        console.error("Error copying packed file into another pack:", error);
        showDialog(`Failed to copy ${source.filePath}: ${error instanceof Error ? error.message : "Unknown error"}`, {
          title: "Copy Failed",
        });
      } finally {
        setIsCopyProcessing(false);
      }
    },
    [
      handleOpenDBTable,
      handleOpenFlowFile,
      handleOpenPackedFile,
      getTargetPackFileNames,
      openOrActivatePackTab,
      packTabs,
      showDialog,
    ],
  );

  const handleConfirmCopyOverwrite = useCallback(() => {
    if (!copyOverwriteRequest || isCopyProcessing) return;
    void handleCopyInto(
      copyOverwriteRequest.source,
      copyOverwriteRequest.targetPackPath,
      copyOverwriteRequest.openAfterCopy,
      true,
    );
  }, [copyOverwriteRequest, handleCopyInto, isCopyProcessing]);

  const handleCopyTableWithNewName = useCallback(() => {
    if (!copyTableNameRequest || isCopyProcessing) return;
    if (copyTableName.trim().toLowerCase() === copyTableNameRequest.tableName.trim().toLowerCase()) {
      showDialog("Enter a different table name for the copy", { title: "Table Name Unchanged" });
      return;
    }
    const destinationFilePath = getRenamedDBTablePath(copyTableNameRequest.filePath, copyTableName);
    if (!destinationFilePath) {
      showDialog("Enter a valid table name without slashes", { title: "Invalid Table Name" });
      return;
    }

    void handleCopyInto(
      copyTableNameRequest.source,
      copyTableNameRequest.targetPackPath,
      copyTableNameRequest.openAfterCopy,
      false,
      destinationFilePath,
    );
  }, [copyTableName, copyTableNameRequest, handleCopyInto, isCopyProcessing, showDialog]);

  const handleOverwriteOriginalTable = useCallback(() => {
    if (!copyTableNameRequest || isCopyProcessing || !copyTableNameRequest.exactFileExists) return;
    void handleCopyInto(
      copyTableNameRequest.source,
      copyTableNameRequest.targetPackPath,
      copyTableNameRequest.openAfterCopy,
      true,
    );
  }, [copyTableNameRequest, handleCopyInto, isCopyProcessing]);

  const getOtherOpenPacks = useCallback(
    (sourcePackPath: string): ViewerPackTarget[] =>
      packTabs
        .filter((packTab) => packTab.packPath !== sourcePackPath)
        .map((packTab) => ({
          packPath: packTab.packPath,
          label:
            packsDataByPath[packTab.packPath]?.packName ?? getPackNameFromPath(packTab.packPath) ?? packTab.packPath,
        })),
    [packTabs, packsDataByPath],
  );

  const handleCloseTab = useCallback((tabId: string) => {
    const targetPackPath = activePackPathRef.current;
    if (!targetPackPath) return;
    // Derived inside the updater so a pack opened over IPC between render and click is not clobbered.
    setPackTabs((prevPackTabs) =>
      prevPackTabs.map((packTab) => {
        if (packTab.packPath !== targetPackPath) return packTab;
        const tabIndex = packTab.openTabs.findIndex((tab) => tab.id === tabId);
        if (tabIndex < 0) return packTab;
        const nextOpenTabs = packTab.openTabs.filter((tab) => tab.id !== tabId);
        const nextActiveTabId =
          tabId === packTab.activeTabId
            ? ((nextOpenTabs[tabIndex - 1] ?? nextOpenTabs[tabIndex])?.id ?? null)
            : packTab.activeTabId;
        return { ...packTab, openTabs: nextOpenTabs, activeTabId: nextActiveTabId };
      }),
    );
  }, []);

  // With no pack tab open, activeViewerPackPath is only the Redux fallback (the game's db pack), which
  // nobody asked to open - saving it is not on offer.
  const hasActivePackTab = activePackPath != undefined;
  const hasUnsavedFiles = hasActivePackTab && unsavedFiles.length > 0;
  // Save As works on any pack that exists on disk, changed or not - it saves a copy. A memory pack
  // has no file to copy, so it needs something unsaved in it before there is anything to write.
  const canSavePackAs = hasActivePackTab && (!activeViewerPackPath.startsWith("memory://") || hasUnsavedFiles);

  useEffect(() => {
    if (!activePackPath) return;
    const activeTab =
      openTabs.find((tab) => tab.id === activeTabId) ??
      ({
        fileKey: `pack|${activePackPath}`,
        kind: "db",
        packPath: activePackPath,
        dbName: "",
        dbSubname: "",
        id: "",
        title: "",
      } as ViewerTab);
    const currentDBSelection = currentDBTableSelectionRef.current;
    const currentFlowSelection = currentFlowFileSelectionRef.current;
    const currentFlowPackPath = currentFlowFilePackPathRef.current;

    if (activeTab.kind === "flow" && activeTab.flowFile) {
      const isAlreadySelected =
        currentFlowSelection === activeTab.flowFile && currentFlowPackPath === activeTab.packPath;
      if (isAlreadySelected) {
        lastSelectionKeyRef.current = activeTab.fileKey;
        return;
      }
      suppressSelectionToTabSyncRef.current = true;
      dispatch(selectFlowFile({ flowFile: activeTab.flowFile, packPath: activeTab.packPath }));
      lastSelectionKeyRef.current = activeTab.fileKey;
      return;
    }

    if (activeTab.kind === "file" && activeTab.filePath) {
      const isAlreadySelected =
        !currentFlowSelection &&
        currentDBSelection?.packPath === activeTab.packPath &&
        !currentDBSelection?.dbName &&
        !currentDBSelection?.dbSubname;
      if (!isAlreadySelected) {
        suppressSelectionToTabSyncRef.current = true;
        if (currentFlowSelection) dispatch(selectFlowFile(undefined));
        dispatch(
          selectDBTable({
            packPath: activeTab.packPath,
            dbName: "",
            dbSubname: "",
          }),
        );
      }
      lastSelectionKeyRef.current = activeTab.fileKey;
      return;
    }

    if (activeTab.kind === "db" && activeTab.packPath && !activeTab.dbName && !activeTab.dbSubname) {
      const isAlreadySelected =
        !currentFlowSelection &&
        currentDBSelection?.packPath === activeTab.packPath &&
        !currentDBSelection?.dbName &&
        !currentDBSelection?.dbSubname;
      if (isAlreadySelected) {
        lastSelectionKeyRef.current = activeTab.fileKey;
        return;
      }
      suppressSelectionToTabSyncRef.current = true;
      if (currentFlowSelection) {
        dispatch(selectFlowFile(undefined));
      }
      dispatch(
        selectDBTable({
          packPath: activeTab.packPath,
          dbName: "",
          dbSubname: "",
        }),
      );
      lastSelectionKeyRef.current = activeTab.fileKey;
      return;
    }

    if (activeTab.dbName && activeTab.dbSubname) {
      const isAlreadySelected =
        !currentFlowSelection &&
        currentDBSelection?.packPath === activeTab.packPath &&
        (currentDBSelection?.dbFolder || DEFAULT_DB_TABLE_ROOT) === (activeTab.dbFolder || DEFAULT_DB_TABLE_ROOT) &&
        currentDBSelection?.dbName === activeTab.dbName &&
        currentDBSelection?.dbSubname === activeTab.dbSubname;
      if (isAlreadySelected) {
        lastSelectionKeyRef.current = activeTab.fileKey;
        return;
      }
      suppressSelectionToTabSyncRef.current = true;
      if (currentFlowSelection) {
        dispatch(selectFlowFile(undefined));
      }
      dispatch(
        selectDBTable({
          packPath: activeTab.packPath,
          dbFolder: activeTab.dbFolder,
          dbName: activeTab.dbName,
          dbSubname: activeTab.dbSubname,
        }),
      );
      lastSelectionKeyRef.current = activeTab.fileKey;
    }
  }, [activePackPath, activeTabId, openTabs, dispatch]);

  useEffect(() => {
    let selectionRequestKey: string | null = null;
    if (currentFlowFileSelection) {
      const flowPackPath = currentFlowFilePackPath ?? currentDBTableSelection?.packPath ?? reduxFallbackPackPath;
      if (flowPackPath) {
        selectionRequestKey = `flow|${flowPackPath}|${currentFlowFileSelection}`;
      }
    } else if (hasDBSelectionTarget(currentDBTableSelection)) {
      selectionRequestKey = `db|${currentDBTableSelection.packPath}|${currentDBTableSelection.dbName}|${currentDBTableSelection.dbSubname}`;
    }

    if (suppressSelectionToTabSyncRef.current) {
      suppressSelectionToTabSyncRef.current = false;
      lastProcessedSelectionRequestKeyRef.current = selectionRequestKey;
      return;
    }

    if (selectionRequestKey === lastProcessedSelectionRequestKeyRef.current) {
      return;
    }

    // A selection aimed at a pack that is not in front belongs to whichever tab owns it, so it waits
    // rather than being recorded as handled - recording it would strand the tab for good, since the
    // key never repeats once activating that pack makes it actionable.
    const selectionPackPath = currentFlowFileSelection
      ? (currentFlowFilePackPath ?? currentDBTableSelection?.packPath ?? reduxFallbackPackPath)
      : currentDBTableSelection?.packPath;
    if (activePackPath && selectionPackPath && selectionPackPath !== activePackPath) return;

    lastProcessedSelectionRequestKeyRef.current = selectionRequestKey;

    if (currentFlowFileSelection) {
      const flowPackPath = currentFlowFilePackPath ?? currentDBTableSelection?.packPath ?? reduxFallbackPackPath;
      if (!flowPackPath) return;
      const candidate = buildFlowTabCandidate(currentFlowFileSelection, flowPackPath);
      if (lastSelectionKeyRef.current === candidate.fileKey) return;
      openOrActivateTab(candidate);
      return;
    }

    if (hasDBSelectionTarget(currentDBTableSelection)) {
      const candidate = buildDbTabCandidate(currentDBTableSelection);
      if (lastSelectionKeyRef.current === candidate.fileKey) return;
      openOrActivateTab(candidate);
      return;
    }
  }, [
    currentFlowFileSelection,
    currentFlowFilePackPath,
    currentDBTableSelection,
    reduxFallbackPackPath,
    activePackPath,
    buildFlowTabCandidate,
    buildDbTabCandidate,
    openOrActivateTab,
  ]);

  useEffect(() => {
    const capturePackOpenRequest = () => {
      const request = viewerStore.getState().app.packOpenRequest;
      if (!request) {
        // removePackData clears a request for the closed path; allow that path to be reopened with
        // the reducer's fresh nonce sequence.
        lastObservedPackOpenNonceRef.current = 0;
        lastHandledPackOpenNonceRef.current = 0;
        return;
      }
      if (request.nonce <= lastObservedPackOpenNonceRef.current) return;
      lastObservedPackOpenNonceRef.current = request.nonce;
      pendingPackOpenRequestsRef.current.push(request);
      setPackOpenRequestVersion((version) => version + 1);
    };

    const unsubscribe = viewerStore.subscribe(capturePackOpenRequest);
    capturePackOpenRequest();
    return unsubscribe;
  }, [viewerStore]);

  useEffect(() => {
    // The selector is retained as a dependency for the initial/fallback path; the store
    // subscription above captures every nonce even when React batches several dispatches together.
    if (packOpenRequest && packOpenRequest.nonce > lastObservedPackOpenNonceRef.current) {
      lastObservedPackOpenNonceRef.current = packOpenRequest.nonce;
      pendingPackOpenRequestsRef.current.push(packOpenRequest);
    }

    const pendingRequests = pendingPackOpenRequestsRef.current.splice(0);
    for (const request of pendingRequests) {
      if (request.nonce <= lastHandledPackOpenNonceRef.current) continue;
      lastHandledPackOpenNonceRef.current = request.nonce;
      openOrActivatePackTab(request.packPath);
    }
  }, [packOpenRequest, packOpenRequestVersion, openOrActivatePackTab]);

  useEffect(() => {
    if (activePackPath) window.api?.setViewerActivePack?.(activePackPath);
  }, [activePackPath]);

  useEffect(() => {
    if (!activePackPath) return;
    if (activeTabId) return;
    if (currentFlowFileSelection && currentFlowFilePackPath === activePackPath) return;
    if (hasDBSelectionTarget(currentDBTableSelection) && currentDBTableSelection.packPath === activePackPath) return;

    if (!currentPackData) return;

    const hasDefaultTable = currentPackData.tables.includes("db\\main_units_tables\\data__");
    if (!hasDefaultTable) return;

    handleOpenDBTable({
      packPath: activeViewerPackPath,
      dbName: "main_units_tables",
      dbSubname: "data__",
    });
  }, [
    activePackPath,
    activeTabId,
    currentFlowFilePackPath,
    currentFlowFileSelection,
    currentDBTableSelection,
    currentPackData,
    activeViewerPackPath,
    handleOpenDBTable,
  ]);

  const handleSavePack = useCallback(async () => {
    if (!hasUnsavedFiles) return;

    try {
      const result = await window.api?.savePackWithUnsavedFiles(activeViewerPackPath);
      if (result?.success) {
        console.log("Pack saved successfully:", result.savedPath);
        // A warning is something to read, so it keeps the dialog; a plain success does not.
        if (result.warning) {
          showDialog(`${result.warning}\n\nSaved to: ${result.savedPath}`, { title: "Pack Saved" });
        } else {
          showToast(`Pack saved to: ${result.savedPath}`);
        }
      } else {
        console.error("Failed to save pack:", result?.error);
        showDialog(`Failed to save pack: ${result?.error || "Unknown error"}`, { title: "Save Failed" });
      }
    } catch (error) {
      console.error("Error saving pack:", error);
      showDialog(`Error saving pack: ${error instanceof Error ? error.message : "Unknown error"}`, {
        title: "Save Failed",
      });
    }
  }, [activeViewerPackPath, hasUnsavedFiles, showDialog, showToast]);

  const handleSavePackAs = useCallback(async () => {
    // Deliberately not gated on unsaved changes: Save As on an untouched pack saves a copy of it.
    setSaveAsPackName(getDefaultSaveAsPackName(activeViewerPackPath));
    setSaveAsDirectory(undefined);
    setOverwriteConfirmPath(null);
    setIsSaveAsModalOpen(true);

    // The data folder is where the game reads packs from, so it is the useful default. Fetched per
    // open rather than cached because the selected game can change while the viewer stays up.
    const dataFolder = await window.api?.getDataFolder();
    // Only fills a still-empty field: Browse may already have won the race.
    if (dataFolder) setSaveAsDirectory((currentDirectory) => currentDirectory ?? dataFolder);
  }, [activeViewerPackPath]);

  const handleSaveAsConfirm = useCallback(
    async (overwriteExisting = false) => {
      if (!saveAsPackName.trim() || !saveAsDirectory) {
        showDialog("Please enter a pack name and select a directory", { title: "Missing Information" });
        return;
      }

      setIsSaveAsProcessing(true);

      try {
        const result = await window.api?.savePackAsWithUnsavedFiles(
          activeViewerPackPath,
          saveAsPackName.trim(),
          saveAsDirectory,
          overwriteExisting,
        );
        if (result?.alreadyExists) {
          // Nothing was written; ask before replacing what is there.
          setOverwriteConfirmPath(result.savedPath ?? "");
        } else if (result?.success) {
          console.log("Pack saved as successfully:", result.savedPath);
          setIsSaveAsModalOpen(false);
          setOverwriteConfirmPath(null);
          setSaveAsPackName("");
          setSaveAsDirectory(undefined);
          if (result.warning) {
            showDialog(`${result.warning}\n\nPack: ${result.savedPath}`, { title: "Pack Saved" });
          } else {
            showToast(`Pack saved to: ${result.savedPath}`);
          }
        } else {
          console.error("Failed to save pack as:", result?.error);
          showDialog(`Failed to save pack as: ${result?.error || "Unknown error"}`, {
            title: "Save Failed",
          });
        }
      } catch (error) {
        console.error("Error saving pack as:", error);
        showDialog(`Error saving pack as: ${error instanceof Error ? error.message : "Unknown error"}`, {
          title: "Save Failed",
        });
      } finally {
        setIsSaveAsProcessing(false);
      }
    },
    [activeViewerPackPath, saveAsDirectory, saveAsPackName, showDialog, showToast],
  );

  const handleSelectSaveAsDirectory = useCallback(async () => {
    try {
      const selectedDirectory = await window.api?.selectDirectory(saveAsDirectory);
      if (selectedDirectory) {
        setSaveAsDirectory(selectedDirectory);
      }
      // The folder dialog is parented on this window, but focus can still land on the main window
      // when it closes, leaving the half-filled modal behind another window.
      window.focus();
      saveAsPackNameInputRef.current?.focus();
    } catch (error) {
      console.error("Error selecting directory:", error);
      showDialog(`Error selecting directory: ${error instanceof Error ? error.message : "Unknown error"}`, {
        title: "Directory Selection Failed",
      });
    }
  }, [saveAsDirectory, showDialog]);

  const handleNewPack = () => {
    if (!isFeaturesForModdersEnabled) return;
    setIsFileMenuOpen(false);
    setNewPackName("");
    setIsNewPackModalOpen(true);
  };

  const handleAddNewFlow = () => {
    setIsFileMenuOpen(false);
    treeViewRefs.current[activePackPath ?? ""]?.openNewFlowDialog();
  };

  const handleOpenDBPack = () => {
    if (isDBPackOpen) return;
    setIsFileMenuOpen(false);
    window.api?.requestOpenModInViewer(dbPackName);
  };

  const handleNewPackConfirm = useCallback(async () => {
    if (!newPackName.trim()) {
      showDialog("Please enter a pack name", { title: "Missing Name" });
      return;
    }

    setIsNewPackProcessing(true);

    try {
      const packName = newPackName.trim();
      const packPath = `memory://${packName}`;

      const newPackData: PackViewData = {
        packName: packName,
        packPath: packPath,
        tables: [],
        packedFiles: {},
      };

      dispatch(setPacksData([newPackData]));
      openOrActivatePackTab(packPath);

      console.log("Pack created in memory:", packName);
      setIsNewPackModalOpen(false);
      setNewPackName("");
    } catch (error) {
      console.error("Error creating pack:", error);
      showDialog(`Error creating pack: ${error instanceof Error ? error.message : "Unknown error"}`, {
        title: "Create Failed",
      });
    } finally {
      setIsNewPackProcessing(false);
    }
  }, [dispatch, newPackName, openOrActivatePackTab, showDialog]);

  const closePackTab = useCallback(
    (packPath: string) => {
      const packIndex = packTabs.findIndex((packTab) => packTab.packPath === packPath);
      if (packIndex < 0) return;

      // Which neighbour to fall back to is read from this render; the removal itself goes through an
      // updater so a pack opened over IPC while the confirm dialog was up is not clobbered.
      if (activePackPathRef.current === packPath) {
        const remaining = packTabs.filter((packTab) => packTab.packPath !== packPath);
        activatePackTab((remaining[packIndex - 1] ?? remaining[packIndex])?.packPath ?? null);
      }
      setPackTabs((prevPackTabs) => prevPackTabs.filter((packTab) => packTab.packPath !== packPath));

      clearPackDataStoreForPack(packPath);
      clearPreparedTableForPack(packPath);
      // referencesHash is global to the renderer and is refreshed by the next pack data-store update.
      delete preferredTreeTabCacheRef.current[packPath];
      delete treeScrollTopsRef.current[packPath];
      delete treeScrollElementsRef.current[packPath];
      delete treeViewRefs.current[packPath];
      dispatch(removePackData(packPath));
      window.api?.viewerClosedPack?.(packPath);
    },
    [activatePackTab, dispatch, packTabs],
  );

  const requestClosePackTab = useCallback(
    (packPath: string) => {
      if (unsavedPacksDataByPath[packPath]?.length) {
        setPackCloseConfirmPath(packPath);
        return;
      }
      closePackTab(packPath);
    },
    [closePackTab, unsavedPacksDataByPath],
  );

  useLayoutEffect(() => {
    if (!activePackPath) return;
    const scrollElement = treeScrollElementsRef.current[activePackPath];
    if (scrollElement) scrollElement.scrollTop = treeScrollTopsRef.current[activePackPath] ?? 0;
  }, [activePackPath]);

  useLayoutEffect(() => {
    const sidebarElement = sidebarResizableRef.current?.resizable;
    const rootElement = viewerRootRef.current;
    if (!sidebarElement || !rootElement || typeof ResizeObserver === "undefined") return;

    const apply = (width: number) => {
      rootElement.style.setProperty("--viewer-sidebar-width", `${width}px`);
      setIsSidebarNarrow(width < TOOLBAR_ICON_ONLY_SIDEBAR_WIDTH);
    };

    apply(sidebarElement.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const borderBoxSize = entry.borderBoxSize;
      const width = borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
      if (width != undefined) apply(width);
    });
    observer.observe(sidebarElement);
    return () => observer.disconnect();
  }, [isOpen]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "f") {
        document.getElementById("dbTableFilter")?.focus();
        e.stopImmediatePropagation();
      }
    };

    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // only runs when mounted first time
  useEffect(() => {
    if (!currentDBTableSelection) {
      // window.api?.getPackData(activeViewerPackPath, { dbName: "main_units_tables", dbSubname: "data__" });
      // dispatch(
      //   selectDBTable({
      //     packPath: `\\\\${activeViewerPackPath}`,
      //     dbName: "main_units_tables",
      //     dbSubname: "data__",
      //   })
      // );
    }
  }, [currentDBTableSelection]);

  // for testing, automatically opens db.pack main_units_tablesl
  useEffect(() => {
    // startArgs arrives over IPC after mount, so this cannot be a mount-only effect - but it still
    // has to fire once rather than again on every pack switch.
    if (didRunTestDBCloneRef.current) return;
    if (startArgs.includes("-testDBClone")) {
      didRunTestDBCloneRef.current = true;
      window.api?.getPackData(activeViewerPackPath, { dbName: "main_units_tables", dbSubname: "data__" });
      dispatch(
        selectDBTable({
          packPath: `K:\\SteamLibrary\\steamapps\\common\\Total War WARHAMMER III\\data\\db.pack`,
          dbName: "main_units_tables",
          dbSubname: "data__",
        }),
      );
    }
  }, [activeViewerPackPath, dispatch, startArgs]);

  // console.log(`currentPackData.data is ${currentPackData.data}`);

  return (
    <>
      {deepCloneTarget && (
        <Modal
          onClose={() => {
            dispatch(setDeepCloneTarget(undefined));
          }}
          show={isOpen}
          size="6xl"
          position="top-center"
          explicitClasses={["mt-8", "!max-w-7xl", "md:!h-full", "overflow-hidden", "modalDontOverflowWindowHeight"]}
        >
          <Modal.Header>Deep Cloning...</Modal.Header>
          <Modal.Body>
            <div className="text-center mt-8">
              <DBDuplication launchSource="modsViewer" />
            </div>
          </Modal.Body>
        </Modal>
      )}

      {/* Save As Modal */}
      <Modal onClose={() => setIsSaveAsModalOpen(false)} show={isSaveAsModalOpen} size="md" position="center">
        <Modal.Header>Save Pack As</Modal.Header>
        <Modal.Body>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Pack Name (without .pack extension)
              </label>
              <input
                ref={saveAsPackNameInputRef}
                type="text"
                value={saveAsPackName}
                onChange={(e) => setSaveAsPackName(e.target.value)}
                placeholder="e.g. my_custom_pack"
                className="w-full px-3 py-2 bg-gray-700 text-white border border-gray-600 rounded-lg focus:outline-none focus:border-blue-500"
                disabled={isSaveAsProcessing}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Save Location</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={saveAsDirectory || ""}
                  placeholder="Loading data folder, or click Browse to pick another"
                  readOnly
                  className="flex-1 px-3 py-2 bg-gray-700 text-gray-400 border border-gray-600 rounded-lg focus:outline-none"
                />
                <button
                  onClick={handleSelectSaveAsDirectory}
                  disabled={isSaveAsProcessing}
                  className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white font-medium rounded-lg transition-colors duration-200 disabled:opacity-50"
                >
                  Browse
                </button>
              </div>
              {saveAsDirectory && <p className="text-xs text-gray-400 mt-1 truncate">{saveAsDirectory}</p>}
            </div>
          </div>
        </Modal.Body>
        <Modal.Footer>
          <button
            onClick={() => setIsSaveAsModalOpen(false)}
            disabled={isSaveAsProcessing}
            className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white font-medium rounded-lg transition-colors duration-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            // Not passed directly: the click event would arrive as the overwrite argument.
            onClick={() => void handleSaveAsConfirm()}
            disabled={isSaveAsProcessing || !saveAsPackName.trim() || !saveAsDirectory}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSaveAsProcessing ? "Saving..." : "Save"}
          </button>
        </Modal.Footer>
      </Modal>

      {/* Destination-file overwrite confirmation */}
      <Modal
        onClose={() => {
          if (!isCopyProcessing) setCopyOverwriteRequest(null);
        }}
        show={!!copyOverwriteRequest}
        size="md"
        position="center"
      >
        <Modal.Header>File Already Exists</Modal.Header>
        <Modal.Body>
          <div className="text-sm text-gray-200">
            The destination pack already contains:
            <div className="mt-2 break-all text-gray-400">{copyOverwriteRequest?.filePath}</div>
            <div className="mt-2 break-all text-gray-400">{copyOverwriteRequest?.targetPackPath}</div>
            <div className="mt-3">Overwrite it with the copied file?</div>
          </div>
        </Modal.Body>
        <Modal.Footer>
          <button
            onClick={() => setCopyOverwriteRequest(null)}
            disabled={isCopyProcessing}
            className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white font-medium rounded-lg transition-colors duration-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirmCopyOverwrite}
            disabled={isCopyProcessing}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-medium rounded-lg transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isCopyProcessing ? "Overwriting..." : "Overwrite"}
          </button>
        </Modal.Footer>
      </Modal>

      {/* Destination table-name prompt for DB tables and copied rows */}
      <Modal
        onClose={() => {
          if (!isCopyProcessing) {
            setCopyTableNameRequest(null);
            setCopyTableName("");
          }
        }}
        show={!!copyTableNameRequest}
        size="md"
        position="center"
      >
        <Modal.Header>Table Already Exists</Modal.Header>
        <Modal.Body>
          <div className="space-y-3 text-sm text-gray-200">
            <div>
              The destination pack already contains a table named:
              <div className="mt-2 break-all text-gray-400">{copyTableNameRequest?.tableName}</div>
            </div>
            <label className="block">
              <span className="mb-1 block text-gray-300">New table name</span>
              <input
                ref={copyTableNameInputRef}
                type="text"
                value={copyTableName}
                onChange={(event) => setCopyTableName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") handleCopyTableWithNewName();
                }}
                className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
                disabled={isCopyProcessing}
                aria-label="New table name"
              />
            </label>
            <div className="break-all text-xs text-gray-500">Destination: {copyTableNameRequest?.targetPackPath}</div>
          </div>
        </Modal.Body>
        <Modal.Footer>
          <button
            onClick={() => {
              setCopyTableNameRequest(null);
              setCopyTableName("");
            }}
            disabled={isCopyProcessing}
            className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white font-medium rounded-lg transition-colors duration-200 disabled:opacity-50"
          >
            Cancel
          </button>
          {copyTableNameRequest?.exactFileExists && copyTableNameRequest.source.kind === "db" && (
            <button
              onClick={handleOverwriteOriginalTable}
              disabled={isCopyProcessing}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-medium rounded-lg transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isCopyProcessing ? "Copying..." : "Overwrite Original"}
            </button>
          )}
          <button
            onClick={handleCopyTableWithNewName}
            disabled={isCopyProcessing || !copyTableName.trim()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isCopyProcessing ? "Copying..." : "Copy with New Name"}
          </button>
        </Modal.Footer>
      </Modal>

      {/* Overwrite confirmation, shown over the Save As modal so Cancel goes back to it */}
      <Modal onClose={() => setOverwriteConfirmPath(null)} show={!!overwriteConfirmPath} size="md" position="center">
        <Modal.Header>Pack Already Exists</Modal.Header>
        <Modal.Body>
          <div className="text-sm text-gray-200">
            A pack already exists at:
            <div className="mt-2 mb-3 break-all text-gray-400">{overwriteConfirmPath}</div>
            Overwrite it? The existing pack will be replaced and cannot be recovered.
          </div>
        </Modal.Body>
        <Modal.Footer>
          <button
            onClick={() => setOverwriteConfirmPath(null)}
            disabled={isSaveAsProcessing}
            className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white font-medium rounded-lg transition-colors duration-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleSaveAsConfirm(true)}
            disabled={isSaveAsProcessing}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-medium rounded-lg transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSaveAsProcessing ? "Overwriting..." : "Overwrite"}
          </button>
        </Modal.Footer>
      </Modal>

      {/* New Pack Modal */}
      <Modal onClose={() => setIsNewPackModalOpen(false)} show={isNewPackModalOpen} size="md" position="center">
        <Modal.Header>Create New Pack</Modal.Header>
        <Modal.Body>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">Pack Name (without .pack extension)</label>
            <input
              ref={newPackNameInputRef}
              type="text"
              value={newPackName}
              onChange={(e) => setNewPackName(e.target.value)}
              placeholder="e.g. new_mod_pack"
              className="w-full px-3 py-2 bg-gray-700 text-white border border-gray-600 rounded-lg focus:outline-none focus:border-blue-500"
              disabled={isNewPackProcessing}
            />
          </div>
        </Modal.Body>
        <Modal.Footer>
          <button
            onClick={() => setIsNewPackModalOpen(false)}
            disabled={isNewPackProcessing}
            className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white font-medium rounded-lg transition-colors duration-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleNewPackConfirm}
            disabled={isNewPackProcessing || !newPackName.trim()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isNewPackProcessing ? "Creating..." : "Create"}
          </button>
        </Modal.Footer>
      </Modal>

      {/* Discard confirmation for a dirty pack tab */}
      <Modal onClose={() => setPackCloseConfirmPath(null)} show={!!packCloseConfirmPath} size="md" position="center">
        <Modal.Header>Close Pack</Modal.Header>
        <Modal.Body>
          <div className="text-sm text-gray-200">
            This pack has unsaved files. Closing it will discard:
            <ul className="mt-2 max-h-48 overflow-auto list-disc list-inside text-gray-400 break-all">
              {(packCloseConfirmPath ? (unsavedPacksDataByPath[packCloseConfirmPath] ?? []) : []).map((file) => (
                <li key={file.name}>{file.name}</li>
              ))}
            </ul>
          </div>
        </Modal.Body>
        <Modal.Footer>
          <button
            onClick={() => setPackCloseConfirmPath(null)}
            className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white font-medium rounded-lg transition-colors duration-200"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              if (packCloseConfirmPath) closePackTab(packCloseConfirmPath);
              setPackCloseConfirmPath(null);
            }}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-medium rounded-lg transition-colors duration-200"
          >
            Discard and Close
          </button>
        </Modal.Footer>
      </Modal>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
          <button
            onClick={() => setToast(null)}
            className="pointer-events-auto max-w-[80vw] px-6 py-3 rounded-lg bg-green-700 text-white text-sm shadow-lg break-all text-left"
          >
            {toast}
          </button>
        </div>
      )}

      <Modal onClose={() => setMessageDialog(null)} show={!!messageDialog} size="md" position="center">
        <Modal.Header>{messageDialog?.title ?? "Message"}</Modal.Header>
        <Modal.Body>
          <div className="whitespace-pre-wrap text-sm text-gray-200">{messageDialog?.message}</div>
        </Modal.Body>
        <Modal.Footer>
          <button
            onClick={() => setMessageDialog(null)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors duration-200"
          >
            OK
          </button>
        </Modal.Footer>
      </Modal>

      <div
        ref={viewerRootRef}
        className="dark:text-gray-300 explicit-height-without-topbar-and-padding-3rem flex flex-col -mt-8"
      >
        {isOpen && (
          <>
            <div className="flex items-center py-1 pr-2 bg-gray-800 border-b border-gray-600">
              {/* Clamped to the sidebar so the strip beside it starts exactly where the table view does. */}
              <div
                className="relative flex items-center shrink-0"
                style={{ width: "var(--viewer-sidebar-width, 17%)" }}
              >
                {isFeaturesForModdersEnabled && (
                  <div ref={fileMenuRef} className="relative shrink-0">
                    <button
                      type="button"
                      ref={fileMenuButtonRef}
                      onClick={() => setIsFileMenuOpen((isOpen) => !isOpen)}
                      title="File"
                      aria-label="File"
                      aria-haspopup="menu"
                      aria-expanded={isFileMenuOpen}
                      aria-controls="mods-viewer-file-menu"
                      className={
                        (isSidebarNarrow ? "px-2" : "px-3") +
                        " py-1 text-sm bg-purple-600 hover:bg-purple-700 text-white font-medium rounded-lg shadow-lg transition-colors duration-200 flex items-center gap-2 shrink-0"
                      }
                    >
                      <FontAwesomeIcon icon={faFile} className="w-4 h-4" />
                      {!isSidebarNarrow && <span>File</span>}
                      {!isSidebarNarrow && <FontAwesomeIcon icon={faChevronDown} className="w-3 h-3" />}
                    </button>

                    {isFileMenuOpen && (
                      <div
                        id="mods-viewer-file-menu"
                        role="menu"
                        aria-label="File"
                        className="absolute left-0 top-full z-50 mt-1 min-w-[10rem] overflow-hidden rounded-md border border-gray-600 bg-gray-800 py-1 shadow-xl"
                      >
                        <button
                          type="button"
                          role="menuitem"
                          onClick={handleNewPack}
                          className="block w-full whitespace-nowrap px-3 py-2 text-left text-sm text-gray-200 hover:bg-gray-700"
                        >
                          New Pack
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={handleAddNewFlow}
                          className="block w-full whitespace-nowrap px-3 py-2 text-left text-sm text-gray-200 hover:bg-gray-700"
                        >
                          Add New Flow
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={handleOpenDBPack}
                          disabled={isDBPackOpen}
                          className={
                            "block w-full whitespace-nowrap px-3 py-2 text-left text-sm " +
                            (isDBPackOpen ? "cursor-not-allowed text-gray-500" : "text-gray-200 hover:bg-gray-700")
                          }
                        >
                          open db.pack
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Pack tabs begin exactly at the sidebar's right edge. */}
              <div className="flex flex-1 min-w-0 items-center gap-1 overflow-x-auto">
                {packTabs.map((packTab) => {
                  const isActive = packTab.packPath === activePackPath;
                  const packLabel =
                    packsDataByPath[packTab.packPath]?.packName ??
                    getPackNameFromPath(packTab.packPath) ??
                    packTab.packPath;
                  const isDirty = (unsavedPacksDataByPath[packTab.packPath]?.length ?? 0) > 0;
                  return (
                    <div
                      key={packTab.packPath}
                      className={
                        "flex items-center gap-1 rounded-md border text-xs shrink-0 " +
                        (isActive
                          ? "bg-gray-700 text-white border-gray-500"
                          : "bg-gray-800 text-gray-300 border-gray-700 hover:bg-gray-700/60")
                      }
                    >
                      <button
                        type="button"
                        onClick={() => activatePackTab(packTab.packPath)}
                        className="px-2 py-1 max-w-[220px] truncate"
                        title={packLabel}
                      >
                        {isDirty && <span aria-hidden="true">• </span>}
                        {packLabel}
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          requestClosePackTab(packTab.packPath);
                        }}
                        className="px-1 pr-2 text-gray-400 hover:text-white"
                        aria-label={`Close ${packLabel}`}
                      >
                        <FontAwesomeIcon icon={faXmark} />
                      </button>
                    </div>
                  );
                })}
              </div>

              <div className="flex shrink-0 items-center ml-2">
                <button
                  type="button"
                  onClick={() => setIsGlobalSearchOpen((isPanelOpen) => !isPanelOpen)}
                  title={`${localized.globalSearch || "Global search"} (Ctrl+Shift+F)`}
                  aria-label={localized.globalSearch || "Global search"}
                  aria-pressed={isGlobalSearchOpen}
                  className={
                    "px-2 py-1 text-sm rounded-lg text-white font-medium shadow-lg transition-colors duration-200 flex items-center gap-2 " +
                    (isGlobalSearchOpen ? "bg-blue-700 hover:bg-blue-600" : "bg-gray-700 hover:bg-gray-600")
                  }
                >
                  <FontAwesomeIcon icon={faMagnifyingGlass} className="w-4 h-4" />
                </button>
              </div>

              {(hasUnsavedFiles || canSavePackAs) && (
                <div className="flex gap-2 shrink-0 ml-2">
                  {hasUnsavedFiles && !activeViewerPackPath.startsWith("memory://") && (
                    <button
                      onClick={handleSavePack}
                      className="px-3 py-1 text-sm bg-green-600 hover:bg-green-700 text-white font-medium rounded-lg shadow-lg transition-colors duration-200 flex items-center gap-2"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3-3m0 0l-3 3m3-3v12"
                        />
                      </svg>
                      Save Pack
                    </button>
                  )}
                  {canSavePackAs && (
                    <button
                      onClick={() => void handleSavePackAs()}
                      className="px-3 py-1 text-sm bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg shadow-lg transition-colors duration-200 flex items-center gap-2"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 19l9 2-9-18-9 18 9-2m0 0v-8m0 8l-6-4m6 4l6-4"
                        />
                      </svg>
                      Save As
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="flex flex-1 min-h-0 w-full h-full overflow-hidden">
              <Resizable
                ref={sidebarResizableRef}
                defaultSize={{
                  width: "17%",
                  height: "100%",
                }}
                maxWidth="100%"
                minWidth="1"
              >
                <div className="h-full flex flex-col">
                  <div className="relative flex-1 min-h-0">
                    {packTabs.map((packTab) => (
                      <div
                        key={packTab.packPath}
                        ref={(element) => {
                          treeScrollElementsRef.current[packTab.packPath] = element;
                        }}
                        onScroll={(event) => {
                          treeScrollTopsRef.current[packTab.packPath] = event.currentTarget.scrollTop;
                        }}
                        className={
                          "absolute inset-0 overflow-auto scrollbar scrollbar-track-gray-700 scrollbar-thumb-blue-700 " +
                          (packTab.packPath === activePackPath ? "" : "hidden")
                        }
                      >
                        <PackTablesTreeView
                          ref={(handle) => {
                            treeViewRefs.current[packTab.packPath] = handle;
                          }}
                          packPath={packTab.packPath}
                          preferredTab={preferredTreeTabByPackPath[packTab.packPath] ?? "db"}
                          tableFilter={dbTableFilter}
                          showDialog={showDialog}
                          otherOpenPacks={getOtherOpenPacks(packTab.packPath)}
                          onCopyInto={handleCopyInto}
                          onOpenDBTable={handleOpenDBTable}
                          onOpenFlowFile={handleOpenFlowFile}
                          onOpenPackedFile={handleOpenPackedFile}
                        />
                      </div>
                    ))}
                  </div>

                  <div className="flex items-center mt-3">
                    <span className="relative w-full">
                      <input
                        id="dbTableFilter"
                        type="text"
                        placeholder={localized.filter}
                        onChange={(e) => onFilterChangeDebounced(e.target.value)}
                        defaultValue={dbTableFilter}
                        className="block bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 w-full px-2 py-1 pr-6 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white dark:focus:ring-blue-500 dark:focus:border-blue-500"
                      ></input>

                      <span className="absolute right-[0.3rem] top-1/2 -translate-y-1/2 leading-none text-gray-400">
                        <button onClick={() => clearFilter()}>
                          <FontAwesomeIcon icon={faXmark} />
                        </button>
                      </span>
                    </span>
                  </div>
                </div>
              </Resizable>
              <div style={{ width: "100%", minWidth: "1px", height: "100%" }} className="flex flex-col">
                <div className="flex items-center gap-1 border-b border-gray-700 bg-gray-900/60 px-2 py-1 overflow-x-auto">
                  {openTabs.length === 0 ? (
                    <span className="text-xs text-gray-400">No files open</span>
                  ) : (
                    openTabs.map((tab) => {
                      const isActive = tab.id === activeTabId;
                      return (
                        <div
                          key={tab.id}
                          className={
                            "flex items-center gap-1 rounded-md border text-xs " +
                            (isActive
                              ? "bg-gray-700 text-white border-gray-500"
                              : "bg-gray-800 text-gray-300 border-gray-700 hover:bg-gray-700/60")
                          }
                        >
                          <button
                            type="button"
                            onClick={() => setActiveTabId(tab.id)}
                            className="px-2 py-1 max-w-[220px] truncate"
                            title={tab.title}
                          >
                            {tab.title}
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCloseTab(tab.id);
                            }}
                            className="px-1 pr-2 text-gray-400 hover:text-white"
                            aria-label={`Close ${tab.title}`}
                          >
                            <FontAwesomeIcon icon={faXmark} />
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
                <div className="flex-1 min-h-0">
                  {!currentPackData ? (
                    <div className="h-full flex items-center justify-center text-sm text-gray-400">Loading pack…</div>
                  ) : activeTab ? (
                    activeTab.kind === "db" && !activeTab.dbName && !activeTab.dbSubname ? (
                      <div className="h-full flex items-center justify-center text-sm text-gray-400">
                        {packFileInventory?.isEmpty
                          ? "Empty pack. Add a flow or create/edit files to populate it."
                          : "Select a file to view"}
                      </div>
                    ) : activeTab.kind === "flow" && activeTab.flowFile ? (
                      <NodeEditor currentFile={activeTab.flowFile} currentPack={activeTab.packPath} />
                    ) : activeTab.kind === "file" && activeTab.filePath ? (
                      <PackFileView
                        packPath={activeTab.packPath}
                        filePath={activeTab.filePath}
                        showDialog={showDialog}
                      />
                    ) : (
                      <PackTablesTableView
                        showDialog={showDialog}
                        otherOpenPacks={getOtherOpenPacks(activeTab.packPath)}
                        onCopyInto={handleCopyInto}
                      />
                    )
                  ) : (
                    <div className="h-full flex items-center justify-center text-sm text-gray-400">
                      {packFileInventory?.isEmpty
                        ? "Empty pack. Add a flow or create/edit files to populate it."
                        : "Select a file to view"}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {isGlobalSearchMounted && (
              <Resizable
                defaultSize={{ width: "100%", height: 375 }}
                minHeight={180}
                maxHeight="70%"
                enable={{ top: true }}
                className={"mt-3 shrink-0" + (isGlobalSearchOpen ? "" : " hidden")}
              >
                <GlobalSearchPanel
                  isOpen={isGlobalSearchOpen}
                  openPacks={globalSearchOpenPacks}
                  onOpenDbResult={handleOpenGlobalSearchDbResult}
                  onOpenFileResult={handleOpenGlobalSearchFileResult}
                  onClose={() => setIsGlobalSearchOpen(false)}
                />
              </Resizable>
            )}

            {/* <div className="grid grid-cols-10 dark:text-gray-300">
            <div className="col-span-2 overflow-scroll h-[90vh]">
              <PackTablesTreeView tableFilter={modFilter} />
            </div>
            <div className="col-span-8">
              <PackTablesTableView />
            </div>
          </div> */}
          </>
        )}
      </div>
    </>
  );
});

export default ModsViewer;
