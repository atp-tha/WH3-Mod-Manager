import React from "react";
import { configureStore } from "@reduxjs/toolkit";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { describe, expect, it, vi } from "vitest";

import appReducer, { requestOpenPackTab, setUnsavedPacksData } from "../src/appSlice";
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
});
