import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";

// The windowed list has nothing to do with what this panel decides; render every row so the
// assertions can see result lines.
vi.mock("react-virtualized", () => ({
  AutoSizer: ({ children }: { children: (size: { width: number; height: number }) => React.ReactNode }) =>
    children({ width: 900, height: 600 }),
  List: ({ rowCount, rowRenderer }: { rowCount: number; rowRenderer: (props: never) => React.ReactNode }) => (
    <div>
      {Array.from({ length: rowCount }, (_unused, index) =>
        rowRenderer({ index, key: String(index), style: {} } as never),
      )}
    </div>
  ),
}));

import GlobalSearchPanel from "../src/components/viewer/GlobalSearchPanel";
import type { GlobalSearchRequest, GlobalSearchResponse, GlobalSearchResult } from "../src/globalSearch/types";

const dbResult: GlobalSearchResult = {
  kind: "db",
  packPath: "C:\\game\\data\\db.pack",
  packLabel: "db.pack",
  packedFilePath: "db\\land_units_tables\\data__",
  dbName: "land_units_tables",
  dbSubname: "data__",
  columnName: "key",
  rowIndex: 4021,
  value: "chaos_warriors_01",
  matchStart: 0,
  matchEnd: 14,
};

const textResult: GlobalSearchResult = {
  kind: "text",
  packPath: "C:\\mods\\mymod.pack",
  packLabel: "mymod.pack",
  filePath: "script\\campaign\\units.lua",
  line: 88,
  column: 12,
  offset: 2100,
  excerpt: 'local u = "chaos_warriors"',
  matchStartInExcerpt: 11,
  matchEndInExcerpt: 25,
};

const rigidResult: GlobalSearchResult = {
  kind: "rigidModel",
  packPath: "C:\\game\\data\\data.pack",
  packLabel: "data.pack",
  filePath: "variantmeshes\\_variantmodels\\man.rigid_model_v2",
  offset: 512,
  encoding: "utf16le",
  excerpt: "chaos_warriors_body",
  matchStartInExcerpt: 0,
  matchEndInExcerpt: 14,
};

const emptyResponse = (searchId: string, results: GlobalSearchResult[] = []): GlobalSearchResponse => ({
  success: true,
  searchId,
  canceled: false,
  truncated: false,
  results,
  counts: { db: 0, loc: 0, text: 0, rigidModel: 0 },
  targetsSearched: 1,
  filesScanned: 0,
  skippedFiles: [],
  warnings: [],
  elapsedMs: 5,
});

const setupApi = (
  runGlobalSearch: (request: GlobalSearchRequest) => Promise<GlobalSearchResponse>,
  packs: Array<{ path: string; name: string; isEnabled: boolean; isInData: boolean }> = [],
) => {
  const cancelGlobalSearch = vi.fn();
  window.api = {
    getViewerPackCatalog: vi.fn().mockResolvedValue({ success: true, packs }),
    runGlobalSearch: vi.fn(runGlobalSearch),
    cancelGlobalSearch,
    onGlobalSearchProgress: vi.fn(() => vi.fn()),
    onGlobalSearchResults: vi.fn(() => vi.fn()),
  } as never;
  return { cancelGlobalSearch };
};

const renderPanel = (overrides: Partial<React.ComponentProps<typeof GlobalSearchPanel>> = {}) => {
  const onOpenDbResult = vi.fn();
  const onOpenFileResult = vi.fn();
  const onClose = vi.fn();
  render(
    <GlobalSearchPanel
      openPacks={[{ packPath: "C:\\mods\\mymod.pack", label: "mymod.pack" }]}
      onOpenDbResult={onOpenDbResult}
      onOpenFileResult={onOpenFileResult}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onOpenDbResult, onOpenFileResult, onClose };
};

const searchButton = () => screen.getByRole("button", { name: "Search" });

describe("GlobalSearchPanel", () => {
  beforeEach(() => {
    setupApi(async (request) => emptyResponse(request.searchId));
  });

  it("starts with every kind but rigid models enabled, and vanilla as the source", () => {
    renderPanel();

    expect(screen.getByRole("checkbox", { name: /DB tables/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Loc tables/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Text files/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Rigid models/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Vanilla packs/ })).toBeChecked();
  });

  it("keeps Search disabled until there is something to search for", async () => {
    renderPanel();
    expect(searchButton()).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Global search"), "chaos");
    expect(searchButton()).toBeEnabled();
  });

  it("refuses to run an uncompilable regex instead of searching for it literally", async () => {
    renderPanel();

    await userEvent.type(screen.getByLabelText("Global search"), "chaos(");
    expect(searchButton()).toBeEnabled();

    await userEvent.click(screen.getByRole("checkbox", { name: "Regex" }));
    expect(screen.getByText("Not a valid regular expression yet.")).toBeInTheDocument();
    expect(searchButton()).toBeDisabled();
  });

  it("disables Search when no kind is selected", async () => {
    renderPanel();
    await userEvent.type(screen.getByLabelText("Global search"), "chaos");

    for (const name of [/DB tables/, /Loc tables/, /Text files/]) {
      await userEvent.click(screen.getByRole("checkbox", { name }));
    }
    expect(searchButton()).toBeDisabled();
  });

  it("disables Search when no source is selected", async () => {
    renderPanel();
    await userEvent.type(screen.getByLabelText("Global search"), "chaos");

    await userEvent.click(screen.getByRole("checkbox", { name: /Vanilla packs/ }));
    expect(searchButton()).toBeDisabled();
  });

  it("sends the options and sources the user picked", async () => {
    const requests: GlobalSearchRequest[] = [];
    setupApi(async (request) => {
      requests.push(request);
      return emptyResponse(request.searchId);
    });
    renderPanel();

    await userEvent.type(screen.getByLabelText("Global search"), "chaos");
    await userEvent.click(screen.getByRole("checkbox", { name: "Case sensitive" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /Rigid models/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: "mymod.pack" }));
    await userEvent.click(searchButton());

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      query: "chaos",
      caseSensitive: true,
      regex: false,
      kinds: { db: true, loc: true, text: true, rigidModel: true },
    });
    expect(requests[0].sources).toEqual([{ kind: "pack", path: "C:\\mods\\mymod.pack" }, { kind: "vanilla" }]);
  });

  it("collapses 'enabled mods' into 'all mods' rather than sending both", async () => {
    const requests: GlobalSearchRequest[] = [];
    setupApi(async (request) => {
      requests.push(request);
      return emptyResponse(request.searchId);
    });
    renderPanel({ openPacks: [] });

    await userEvent.type(screen.getByLabelText("Global search"), "chaos");
    await userEvent.click(screen.getByRole("checkbox", { name: /Enabled mods/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /All mods/ }));
    await userEvent.click(searchButton());

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].sources).toEqual([{ kind: "allMods" }, { kind: "vanilla" }]);
  });

  it("opens a DB result through the table handler and a text result through the file handler", async () => {
    setupApi(async (request) => emptyResponse(request.searchId, [dbResult, textResult]));
    const { onOpenDbResult, onOpenFileResult } = renderPanel();

    await userEvent.type(screen.getByLabelText("Global search"), "chaos");
    await userEvent.click(searchButton());

    await waitFor(() => expect(screen.getByText(/row 4021/)).toBeInTheDocument());

    await userEvent.click(screen.getByText(/row 4021/));
    expect(onOpenDbResult).toHaveBeenCalledWith(dbResult);

    await userEvent.click(screen.getByText(":88"));
    expect(onOpenFileResult).toHaveBeenCalledWith(textResult);
  });

  it("does not offer to open a rigid model, which has no viewer", async () => {
    setupApi(async (request) => emptyResponse(request.searchId, [rigidResult]));
    const { onOpenFileResult } = renderPanel();

    await userEvent.type(screen.getByLabelText("Global search"), "chaos");
    await userEvent.click(searchButton());

    await waitFor(() => expect(screen.getByText(/@512/)).toBeInTheDocument());
    const row = screen.getByText(/@512/).closest("button");
    expect(row).toBeDisabled();

    await userEvent.click(row as HTMLButtonElement);
    expect(onOpenFileResult).not.toHaveBeenCalled();
  });

  it("groups results under their pack and file", async () => {
    setupApi(async (request) => emptyResponse(request.searchId, [dbResult, textResult]));
    // No open packs, so the only thing carrying a pack path as a title is the result tree.
    renderPanel({ openPacks: [] });

    await userEvent.type(screen.getByLabelText("Global search"), "chaos");
    await userEvent.click(searchButton());

    await waitFor(() => expect(screen.getByTitle("C:\\game\\data\\db.pack")).toBeInTheDocument());
    expect(screen.getByTitle("db\\land_units_tables\\data__")).toBeInTheDocument();
    expect(screen.getByTitle("C:\\mods\\mymod.pack")).toBeInTheDocument();
    expect(screen.getByTitle("script\\campaign\\units.lua")).toBeInTheDocument();
  });

  it("explains itself when the main-process handler is not registered", async () => {
    setupApi(async () => {
      throw new Error("Error invoking remote method 'runGlobalSearch': No handler registered for 'runGlobalSearch'");
    });
    renderPanel();

    await userEvent.type(screen.getByLabelText("Global search"), "chaos");
    await userEvent.click(searchButton());

    await waitFor(() => expect(screen.getByText(/the main-process handler is not registered yet/)).toBeInTheDocument());
  });

  it("surfaces a failure the backend reports", async () => {
    setupApi(async (request) => ({ ...emptyResponse(request.searchId), success: false, error: "cache unavailable" }));
    renderPanel();

    await userEvent.type(screen.getByLabelText("Global search"), "chaos");
    await userEvent.click(searchButton());

    await waitFor(() => expect(screen.getByText("cache unavailable")).toBeInTheDocument());
  });

  it("cancels through the backend when Stop is pressed", async () => {
    let release: (response: GlobalSearchResponse) => void = () => undefined;
    const { cancelGlobalSearch } = setupApi(
      (request) =>
        new Promise<GlobalSearchResponse>((resolve) => {
          release = resolve;
          void request;
        }),
    );
    renderPanel();

    await userEvent.type(screen.getByLabelText("Global search"), "chaos");
    await userEvent.click(searchButton());

    const stop = await screen.findByRole("button", { name: "Stop" });
    await userEvent.click(stop);
    expect(cancelGlobalSearch).toHaveBeenCalledTimes(1);

    release(emptyResponse("ignored", []));
  });
});
