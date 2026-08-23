import React from "react";
import { configureStore } from "@reduxjs/toolkit";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { describe, expect, it, vi } from "vitest";

import appReducer, { requestOpenPackTab, selectDBTable, setUnsavedPacksData } from "../src/appSlice";
import initialState from "../src/initialAppState";
import LocalizationContext from "../src/localizationContext";
import ModsViewer from "../src/components/viewer/ModsViewer";
import type { PackedFile } from "../src/packFileTypes";

vi.mock("../src/components/viewer/PackTablesTreeView", () => {
  const MockPackTablesTreeView = React.forwardRef<any, any>((props, ref) => {
    React.useImperativeHandle(ref, () => ({ openNewFlowDialog: vi.fn() }), []);
    return (
      <div data-testid={`tree-${props.packPath}`}>
        <button
          type="button"
          data-testid={`open-table-${props.packPath}`}
          onClick={() =>
            props.onOpenDBTable({
              packPath: props.packPath,
              dbName: "units_tables",
              dbSubname: "data__",
            })
          }
        >
          Open table {props.packPath}
        </button>
        <button
          type="button"
          data-testid={`open-new-table-${props.packPath}`}
          onClick={() =>
            props.onOpenDBTable(
              {
                packPath: props.packPath,
                dbName: "new_units_tables",
                dbSubname: "data__",
              },
              { forceNewTab: true },
            )
          }
        >
          Open new table {props.packPath}
        </button>
        {props.onCopyInto && props.otherOpenPacks?.[0] && (
          <>
            <button
              type="button"
              data-testid={`copy-file-${props.packPath}`}
              onClick={() =>
                props.onCopyInto(
                  {
                    packPath: props.packPath,
                    filePath: "scripts\\same.lua",
                    kind: "file",
                  },
                  props.otherOpenPacks[0].packPath,
                  true,
                )
              }
            >
              Copy file {props.packPath}
            </button>
            <button
              type="button"
              data-testid={`copy-table-${props.packPath}`}
              onClick={() =>
                props.onCopyInto(
                  {
                    packPath: props.packPath,
                    filePath: "db\\units_tables\\data__",
                    kind: "db",
                    dbSelection: {
                      packPath: props.packPath,
                      dbName: "units_tables",
                      dbSubname: "data__",
                    },
                  },
                  props.otherOpenPacks[0].packPath,
                  true,
                )
              }
            >
              Copy table {props.packPath}
            </button>
          </>
        )}
      </div>
    );
  });
  MockPackTablesTreeView.displayName = "MockPackTablesTreeView";
  return { default: MockPackTablesTreeView };
});

vi.mock("../src/components/viewer/PackTablesTableView", () => ({
  default: () => <div data-testid="table-view">table</div>,
}));

vi.mock("../src/components/viewer/PackFileView", () => ({
  default: () => <div data-testid="file-view">file</div>,
}));

vi.mock("../src/components/NodeEditor", () => ({
  default: () => <div data-testid="node-editor">flow</div>,
}));

vi.mock("../src/components/viewer/DBDuplication", () => ({
  default: () => <div data-testid="db-duplication">duplication</div>,
}));

const file = (name: string): PackedFile => ({ name, file_size: 1, start_pos: -1 });

const pack = (packPath: string, packName: string): PackViewData => ({
  packName,
  packPath,
  tables: ["db\\units_tables\\data__"],
  packedFiles: {},
});

describe("multiple pack viewer tabs", () => {
  it("navigates table history with the mouse back and forward buttons", async () => {
    const packPath = "A:\\mods\\history.pack";
    window.api = { getPackData: vi.fn(), setViewerActivePack: vi.fn() } as unknown as NonNullable<Window["api"]>;
    const store = configureStore({
      reducer: { app: appReducer },
      preloadedState: {
        app: {
          ...initialState,
          packsData: { [packPath]: pack(packPath, "History") },
        },
      },
    });

    render(
      <Provider store={store}>
        <LocalizationContext.Provider value={{ filter: "Filter" }}>
          <ModsViewer />
        </LocalizationContext.Provider>
      </Provider>,
    );

    store.dispatch(requestOpenPackTab(packPath));
    await waitFor(() => expect(screen.getByRole("button", { name: "History", exact: true })).toBeInTheDocument());

    store.dispatch(selectDBTable({ packPath, dbName: "first_units_tables", dbSubname: "data__" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^first_units_tables\/data__/ })).toBeInTheDocument(),
    );

    store.dispatch(selectDBTable({ packPath, dbName: "second_units_tables", dbSubname: "data__" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^second_units_tables\/data__/ })).toBeInTheDocument(),
    );

    const root = screen.getByTestId("mods-viewer-root");
    expect(fireEvent.mouseDown(root, { button: 3 })).toBe(false);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^first_units_tables\/data__/ })).toBeInTheDocument(),
    );

    expect(fireEvent.mouseDown(root, { button: 4 })).toBe(false);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^second_units_tables\/data__/ })).toBeInTheDocument(),
    );
  });

  it("switches to the previous table's tab when history crosses a viewer tab", async () => {
    const user = userEvent.setup();
    const packPath = "A:\\mods\\history-tabs.pack";
    window.api = { getPackData: vi.fn(), setViewerActivePack: vi.fn() } as unknown as NonNullable<Window["api"]>;
    const store = configureStore({
      reducer: { app: appReducer },
      preloadedState: {
        app: {
          ...initialState,
          packsData: { [packPath]: pack(packPath, "History Tabs") },
        },
      },
    });

    render(
      <Provider store={store}>
        <LocalizationContext.Provider value={{ filter: "Filter" }}>
          <ModsViewer />
        </LocalizationContext.Provider>
      </Provider>,
    );

    store.dispatch(requestOpenPackTab(packPath));
    await waitFor(() => expect(screen.getByTestId(`open-table-${packPath}`)).toBeInTheDocument());
    await user.click(screen.getByTestId(`open-table-${packPath}`));
    await waitFor(() => expect(screen.getByRole("button", { name: /^units_tables\/data__/ })).toBeInTheDocument());

    await user.click(screen.getByTestId(`open-new-table-${packPath}`));
    await waitFor(() => expect(screen.getByRole("button", { name: /^new_units_tables\/data__/ })).toBeInTheDocument());

    expect(fireEvent.mouseDown(screen.getByTestId("mods-viewer-root"), { button: 3 })).toBe(false);
    await waitFor(() => expect(screen.getByRole("button", { name: /^units_tables\/data__/ })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /^units_tables\/data__/ }).parentElement).toHaveClass("bg-gray-700");
  });

  it("preserves file tabs per pack, activates existing packs, and closes clean packs", async () => {
    const user = userEvent.setup();
    const packA = "A:\\mods\\a.pack";
    const packB = "B:\\mods\\b.pack";
    const getPackData = vi.fn();
    const savePackWithUnsavedFiles = vi.fn().mockResolvedValue({ success: true, savedPath: packB });
    const viewerClosedPack = vi.fn();
    window.api = {
      getPackData,
      savePackWithUnsavedFiles,
      savePackAsWithUnsavedFiles: vi.fn(),
      getDataFolder: vi.fn().mockResolvedValue("C:\\data"),
      viewerClosedPack,
      setViewerActivePack: vi.fn(),
    } as unknown as NonNullable<Window["api"]>;

    const store = configureStore({
      reducer: { app: appReducer },
      preloadedState: {
        app: {
          ...initialState,
          packsData: { [packA]: pack(packA, "A"), [packB]: pack(packB, "B") },
        },
      },
    });

    render(
      <Provider store={store}>
        <LocalizationContext.Provider value={{ filter: "Filter" }}>
          <ModsViewer />
        </LocalizationContext.Provider>
      </Provider>,
    );

    store.dispatch(requestOpenPackTab(packA));
    await waitFor(() => expect(screen.getByRole("button", { name: "A", exact: true })).toBeInTheDocument());
    fireEvent.click(screen.getByTestId(`open-table-${packA}`));
    await waitFor(() => expect(screen.getByText(/units_tables\/data__/)).toBeInTheDocument());

    store.dispatch(requestOpenPackTab(packB));
    await waitFor(() => expect(screen.getByRole("button", { name: "B", exact: true })).toBeInTheDocument());
    expect(screen.queryByText(/units_tables\/data__/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "A", exact: true }));
    expect(screen.getByText(/units_tables\/data__/)).toBeInTheDocument();

    const getPackDataCallsBeforeReopen = getPackData.mock.calls.length;
    store.dispatch(requestOpenPackTab(packA));
    await waitFor(() => expect(screen.getByRole("button", { name: "A", exact: true })).toBeInTheDocument());
    expect(getPackData).toHaveBeenCalledTimes(getPackDataCallsBeforeReopen);

    await user.click(screen.getByRole("button", { name: "B", exact: true }));
    store.dispatch(setUnsavedPacksData({ packPath: packB, unsavedFileData: [file("db\\units_tables\\data__")] }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save Pack" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Save Pack" }));
    expect(savePackWithUnsavedFiles).toHaveBeenCalledWith(packB);

    await user.click(screen.getByRole("button", { name: "Close A" }));
    await waitFor(() => expect(store.getState().app.packsData[packA]).toBeUndefined());
    expect(viewerClosedPack).toHaveBeenCalledWith(packA);
    expect(screen.getByRole("button", { name: "B", exact: true })).toBeInTheDocument();
  });

  it("waits for confirmation before purging a dirty pack", async () => {
    const user = userEvent.setup();
    const packPath = "A:\\mods\\dirty.pack";
    const viewerClosedPack = vi.fn();
    window.api = {
      viewerClosedPack,
      setViewerActivePack: vi.fn(),
    } as unknown as NonNullable<Window["api"]>;
    const store = configureStore({
      reducer: { app: appReducer },
      preloadedState: {
        app: {
          ...initialState,
          packsData: { [packPath]: pack(packPath, "Dirty") },
          unsavedPacksData: { [packPath]: [file("whmmflows\\dirty.json")] },
        },
      },
    });

    render(
      <Provider store={store}>
        <LocalizationContext.Provider value={{ filter: "Filter" }}>
          <ModsViewer />
        </LocalizationContext.Provider>
      </Provider>,
    );
    store.dispatch(requestOpenPackTab(packPath));
    await waitFor(() => expect(screen.getByRole("button", { name: "Close Dirty" })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Close Dirty" }));
    expect(screen.getByText("whmmflows\\dirty.json")).toBeInTheDocument();
    expect(store.getState().app.packsData[packPath]).toBeDefined();
    expect(viewerClosedPack).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Discard and Close" }));
    await waitFor(() => expect(store.getState().app.packsData[packPath]).toBeUndefined());
    expect(viewerClosedPack).toHaveBeenCalledWith(packPath);
  });

  it("handles consecutive open requests as separate pack tabs", async () => {
    window.api = { setViewerActivePack: vi.fn() } as unknown as NonNullable<Window["api"]>;
    const packA = "A:\\mods\\consecutive-a.pack";
    const packB = "B:\\mods\\consecutive-b.pack";
    const store = configureStore({
      reducer: { app: appReducer },
      preloadedState: {
        app: {
          ...initialState,
          packsData: { [packA]: pack(packA, "Consecutive A"), [packB]: pack(packB, "Consecutive B") },
        },
      },
    });

    render(
      <Provider store={store}>
        <LocalizationContext.Provider value={{ filter: "Filter" }}>
          <ModsViewer />
        </LocalizationContext.Provider>
      </Provider>,
    );
    store.dispatch(requestOpenPackTab(packA));
    store.dispatch(requestOpenPackTab(packB));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Consecutive A", exact: true })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Consecutive B", exact: true })).toBeInTheDocument();
    });
  });

  it("opens the default main units table only once", async () => {
    const user = userEvent.setup();
    const packPath = "A:\\mods\\default-table.pack";
    const getPackData = vi.fn();
    window.api = { getPackData, setViewerActivePack: vi.fn() } as unknown as NonNullable<Window["api"]>;
    const store = configureStore({
      reducer: { app: appReducer },
      preloadedState: {
        app: {
          ...initialState,
          packsData: {
            [packPath]: {
              ...pack(packPath, "Default Table"),
              tables: ["db\\main_units_tables\\data__"],
            },
          },
        },
      },
    });

    render(
      <Provider store={store}>
        <LocalizationContext.Provider value={{ filter: "Filter" }}>
          <ModsViewer />
        </LocalizationContext.Provider>
      </Provider>,
    );

    store.dispatch(requestOpenPackTab(packPath));

    await waitFor(() => expect(screen.getAllByText(/main_units_tables\/data__/)).toHaveLength(1));
    expect(getPackData).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 400));
    await user.click(screen.getByRole("button", { name: /^Close main_units_tables\/data__/ }));
    await waitFor(() => expect(screen.getByText("No files open")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /^Close main_units_tables\/data__/ })).not.toBeInTheDocument();
    expect(getPackData).toHaveBeenCalledTimes(1);
  });

  it("offers no save actions until a pack tab is open", async () => {
    const user = userEvent.setup();
    const packPath = "A:\\mods\\savegate.pack";
    window.api = {
      getPackData: vi.fn(),
      savePackWithUnsavedFiles: vi.fn(),
      savePackAsWithUnsavedFiles: vi.fn(),
      getDataFolder: vi.fn().mockResolvedValue("C:\\data"),
      viewerClosedPack: vi.fn(),
      setViewerActivePack: vi.fn(),
    } as unknown as NonNullable<Window["api"]>;

    const store = configureStore({
      reducer: { app: appReducer },
      preloadedState: { app: { ...initialState, packsData: { [packPath]: pack(packPath, "SaveGate") } } },
    });

    render(
      <Provider store={store}>
        <LocalizationContext.Provider value={{ filter: "Filter" }}>
          <ModsViewer />
        </LocalizationContext.Provider>
      </Provider>,
    );

    // Nothing is open, so the Redux fallback pack path must not be offered up for saving.
    expect(screen.queryByRole("button", { name: "Save As" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save Pack" })).not.toBeInTheDocument();

    store.dispatch(requestOpenPackTab(packPath));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save As" })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Close SaveGate" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save As" })).not.toBeInTheDocument());
  });

  it("groups new pack and new flow under the File menu", async () => {
    const user = userEvent.setup();
    window.api = { setViewerActivePack: vi.fn() } as unknown as NonNullable<Window["api"]>;
    const packPath = "A:\\mods\\file-menu.pack";
    const store = configureStore({
      reducer: { app: appReducer },
      preloadedState: {
        app: {
          ...initialState,
          isFeaturesForModdersEnabled: true,
          packsData: { [packPath]: pack(packPath, "File Menu") },
        },
      },
    });

    render(
      <Provider store={store}>
        <LocalizationContext.Provider value={{ filter: "Filter" }}>
          <ModsViewer />
        </LocalizationContext.Provider>
      </Provider>,
    );

    const fileButton = screen.getByRole("button", { name: "File", exact: true });
    expect(screen.queryByRole("button", { name: "New Pack", exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add New Flow", exact: true })).not.toBeInTheDocument();

    await user.click(fileButton);
    expect(fileButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitem", { name: "New Pack", exact: true })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Add New Flow", exact: true })).toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: "Add New Flow", exact: true }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.click(fileButton);
    await user.click(screen.getByRole("menuitem", { name: "New Pack", exact: true }));
    expect(screen.getByText("Create New Pack")).toBeInTheDocument();
  });

  it("opens the DB pack from the File menu and disables it once open", async () => {
    const user = userEvent.setup();
    const requestOpenModInViewer = vi.fn();
    const dbPackPath = "C:\\game\\data\\db.pack";
    window.api = {
      requestOpenModInViewer,
      setViewerActivePack: vi.fn(),
    } as unknown as NonNullable<Window["api"]>;

    const store = configureStore({
      reducer: { app: appReducer },
      preloadedState: {
        app: {
          ...initialState,
          isFeaturesForModdersEnabled: true,
          packsData: { [dbPackPath]: pack(dbPackPath, "db.pack") },
        },
      },
    });

    render(
      <Provider store={store}>
        <LocalizationContext.Provider value={{ filter: "Filter" }}>
          <ModsViewer />
        </LocalizationContext.Provider>
      </Provider>,
    );

    await user.click(screen.getByRole("button", { name: "File", exact: true }));
    const openDBPack = screen.getByRole("menuitem", { name: "open db.pack", exact: true });
    expect(openDBPack).not.toBeDisabled();
    await user.click(openDBPack);
    expect(requestOpenModInViewer).toHaveBeenCalledWith("db.pack");

    store.dispatch(requestOpenPackTab(dbPackPath));
    await waitFor(() => expect(screen.getByRole("button", { name: "db.pack", exact: true })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "File", exact: true }));
    expect(screen.getByRole("menuitem", { name: "open db.pack", exact: true })).toBeDisabled();
  });

  it("asks before overwriting an existing destination file during copy", async () => {
    const user = userEvent.setup();
    const packA = "A:\\mods\\copy-source.pack";
    const packB = "B:\\mods\\copy-target.pack";
    const copyPackedFileToPack = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        overwriteRequired: true,
        targetPackPath: packB,
        filePath: "scripts\\same.lua",
      })
      .mockResolvedValueOnce({ success: true, targetPackPath: packB, filePath: "scripts\\same.lua" });
    window.api = {
      copyPackedFileToPack,
      getPackData: vi.fn(),
      setViewerActivePack: vi.fn(),
    } as unknown as NonNullable<Window["api"]>;

    const store = configureStore({
      reducer: { app: appReducer },
      preloadedState: {
        app: {
          ...initialState,
          packsData: { [packA]: pack(packA, "Copy Source"), [packB]: pack(packB, "Copy Target") },
        },
      },
    });

    render(
      <Provider store={store}>
        <LocalizationContext.Provider value={{ filter: "Filter" }}>
          <ModsViewer />
        </LocalizationContext.Provider>
      </Provider>,
    );

    store.dispatch(requestOpenPackTab(packA));
    store.dispatch(requestOpenPackTab(packB));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Copy Source", exact: true })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Copy Target", exact: true })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Copy Source", exact: true }));
    await user.click(screen.getByTestId(`copy-file-${packA}`));

    await waitFor(() => expect(screen.getByText("File Already Exists")).toBeInTheDocument());
    expect(screen.getByText("scripts\\same.lua")).toBeInTheDocument();
    expect(copyPackedFileToPack).toHaveBeenCalledWith(packA, "scripts\\same.lua", packB, false);

    await user.click(screen.getByRole("button", { name: "Overwrite", exact: true }));
    await waitFor(() => expect(copyPackedFileToPack).toHaveBeenCalledWith(packA, "scripts\\same.lua", packB, true));
    expect(screen.queryByText("File Already Exists")).not.toBeInTheDocument();
  });

  it("offers a new table name when copying into a pack that already has the table", async () => {
    const user = userEvent.setup();
    const packA = "A:\\mods\\table-copy-source.pack";
    const packB = "B:\\mods\\table-copy-target.pack";
    const copyPackedFileToPack = vi.fn().mockResolvedValue({
      success: true,
      targetPackPath: packB,
      filePath: "db\\copied_units_tables\\data__",
    });
    window.api = {
      copyPackedFileToPack,
      getPackData: vi.fn(),
      setViewerActivePack: vi.fn(),
    } as unknown as NonNullable<Window["api"]>;

    const store = configureStore({
      reducer: { app: appReducer },
      preloadedState: {
        app: {
          ...initialState,
          packsData: { [packA]: pack(packA, "Table Copy Source"), [packB]: pack(packB, "Table Copy Target") },
        },
      },
    });

    render(
      <Provider store={store}>
        <LocalizationContext.Provider value={{ filter: "Filter" }}>
          <ModsViewer />
        </LocalizationContext.Provider>
      </Provider>,
    );

    store.dispatch(requestOpenPackTab(packA));
    store.dispatch(requestOpenPackTab(packB));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Table Copy Source", exact: true })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Table Copy Source", exact: true }));
    await user.click(screen.getByTestId(`copy-table-${packA}`));

    expect(await screen.findByText("Table Already Exists")).toBeInTheDocument();
    const nameInput = screen.getByRole("textbox", { name: "New table name" });
    expect(nameInput).toHaveValue("units_tables");
    await user.clear(nameInput);
    await user.type(nameInput, "copied_units_tables");
    await user.click(screen.getByRole("button", { name: "Copy with New Name", exact: true }));

    await waitFor(() =>
      expect(copyPackedFileToPack).toHaveBeenCalledWith(
        packA,
        "db\\units_tables\\data__",
        packB,
        false,
        "db\\copied_units_tables\\data__",
      ),
    );
  });
});
