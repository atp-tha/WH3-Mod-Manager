import React from "react";
import { configureStore } from "@reduxjs/toolkit";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider } from "react-redux";
import { describe, expect, it, vi } from "vitest";

import appReducer from "../src/appSlice";
import PackTablesTreeView from "../src/components/viewer/PackTablesTreeView";
import initialState from "../src/initialAppState";

describe("pack table tree interactions", () => {
  const renderPackTree = (
    tables: string[],
    preferredTab: "db" | "files" = "db",
    extraProps: Record<string, unknown> = {},
  ) => {
    const packPath = "K:\\mods\\menu.pack";
    const store = configureStore({
      reducer: { app: appReducer },
      preloadedState: {
        app: {
          ...initialState,
          packsData: {
            [packPath]: {
              packName: "menu.pack",
              packPath,
              tables,
              packedFiles: {},
            },
          },
        },
      },
    });

    render(
      <Provider store={store}>
        <PackTablesTreeView
          packPath={packPath}
          preferredTab={preferredTab}
          tableFilter=""
          showDialog={vi.fn()}
          onOpenDBTable={vi.fn()}
          onOpenFlowFile={vi.fn()}
          onOpenPackedFile={vi.fn()}
          {...extraProps}
        />
      </Provider>,
    );

    return screen.getByTestId("pack-tables-tree");
  };

  it("expands a group label without selecting it and selects a table label", () => {
    const packPath = "K:\\mods\\example.pack";
    const store = configureStore({
      reducer: { app: appReducer },
      preloadedState: {
        app: {
          ...initialState,
          packsData: {
            [packPath]: {
              packName: "example.pack",
              packPath,
              tables: ["db\\units_tables\\first", "db\\units_tables\\second"],
              packedFiles: {},
            },
          },
        },
      },
    });

    render(
      <Provider store={store}>
        <PackTablesTreeView
          packPath={packPath}
          preferredTab="db"
          tableFilter=""
          showDialog={vi.fn()}
          onOpenDBTable={vi.fn()}
          onOpenFlowFile={vi.fn()}
          onOpenPackedFile={vi.fn()}
        />
      </Provider>,
    );

    const groupLabel = screen.getByText("units_tables");
    const groupNode = groupLabel.closest("[role='treeitem']");
    expect(groupNode).toHaveAttribute("aria-selected", "false");
    const wasExpanded = groupNode?.getAttribute("aria-expanded");

    fireEvent.click(groupLabel);

    expect(groupNode).toHaveAttribute("aria-selected", "false");
    expect(groupNode?.getAttribute("aria-expanded")).not.toBe(wasExpanded);

    // Ensure the children are visible whichever default expansion state the library started with.
    if (!screen.queryByText("first")) fireEvent.click(groupLabel);
    const tableLabel = screen.getByText("first");
    fireEvent.click(tableLabel);

    expect(tableLabel.closest("[role='treeitem']")).toHaveAttribute("aria-selected", "true");
  });

  it("hides the empty DB tab and offers both creation actions in Files", () => {
    const tree = renderPackTree(["variantmeshes\\variantmeshdefinitions\\unit.variantmeshdefinition"], "db");

    expect(screen.queryByRole("button", { name: "DB Tables", exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Files", exact: true })).toBeInTheDocument();

    fireEvent.contextMenu(tree);

    expect(screen.getByRole("button", { name: "Add New Table", exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add New Flow", exact: true })).toBeInTheDocument();
  });

  it("hides the empty Files tab and offers both creation actions in DB Tables", () => {
    const tree = renderPackTree(["db\\units_tables\\data__"], "files");

    expect(screen.getByRole("button", { name: "DB Tables", exact: true })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Files", exact: true })).not.toBeInTheDocument();

    fireEvent.contextMenu(tree);

    expect(screen.getByRole("button", { name: "Add New Table", exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add New Flow", exact: true })).toBeInTheDocument();
  });

  it("hides both tabs and offers both creation actions on an empty pack", () => {
    const tree = renderPackTree([]);

    expect(screen.queryByRole("button", { name: "DB Tables", exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Files", exact: true })).not.toBeInTheDocument();

    fireEvent.contextMenu(tree);

    expect(screen.getByRole("button", { name: "Add New Table", exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add New Flow", exact: true })).toBeInTheDocument();
  });

  it("offers active packs and a selectable mod catalog when copying a table", async () => {
    const copyInto = vi.fn();
    window.api = {
      getViewerPackCatalog: vi.fn().mockResolvedValue({
        success: true,
        packs: [
          {
            path: "K:\\mods\\menu.pack",
            name: "menu.pack",
            humanName: "Menu",
            isEnabled: true,
            isInData: false,
          },
          {
            path: "K:\\mods\\catalog.pack",
            name: "catalog.pack",
            humanName: "Catalog",
            isEnabled: false,
            isInData: false,
          },
        ],
      }),
    } as unknown as NonNullable<Window["api"]>;

    const tree = renderPackTree(["db\\units_tables\\data__"], "db", {
      otherOpenPacks: [{ packPath: "K:\\mods\\active.pack", label: "Active" }],
      onCopyInto: copyInto,
    });
    const tableLabel = screen.getByText("data__");

    fireEvent.contextMenu(tableLabel);
    fireEvent.click(screen.getByRole("button", { name: "Copy into", exact: true }));

    expect(screen.getByRole("button", { name: "Select Pack...", exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Active", exact: true })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /open pack and copied file/i })).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Active", exact: true }));
    expect(copyInto).toHaveBeenCalledWith(
      {
        packPath: "K:\\mods\\menu.pack",
        filePath: "db\\units_tables\\data__",
        kind: "db",
        dbSelection: {
          packPath: "K:\\mods\\menu.pack",
          dbFolder: "db",
          dbName: "units_tables",
          dbSubname: "data__",
        },
      },
      "K:\\mods\\active.pack",
      true,
    );

    // The picker is loaded lazily, but it still lists every mod returned by the manager catalog.
    fireEvent.contextMenu(tableLabel);
    fireEvent.click(screen.getByRole("button", { name: "Copy into", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Select Pack...", exact: true }));
    const picker = await waitFor(() => screen.getByRole("combobox", { name: "Select pack" }));
    expect(picker).toHaveTextContent("Catalog (catalog.pack)");
    fireEvent.change(picker, { target: { value: "K:\\mods\\catalog.pack" } });
    expect(copyInto).toHaveBeenLastCalledWith(expect.anything(), "K:\\mods\\catalog.pack", true);

    expect(tree).toBeInTheDocument();
  });

  it("offers the same copy action for a packed file", () => {
    const copyInto = vi.fn();
    const tree = renderPackTree(["scripts\\hello.lua"], "files", {
      otherOpenPacks: [{ packPath: "K:\\mods\\active.pack", label: "Active" }],
      onCopyInto: copyInto,
    });

    fireEvent.click(screen.getByText("scripts"));
    fireEvent.contextMenu(screen.getByText("hello.lua"));
    fireEvent.click(screen.getByRole("button", { name: "Copy into", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Active", exact: true }));

    expect(copyInto).toHaveBeenCalledWith(
      {
        packPath: "K:\\mods\\menu.pack",
        filePath: "scripts\\hello.lua",
        kind: "file",
      },
      "K:\\mods\\active.pack",
      true,
    );
    expect(tree).toBeInTheDocument();
  });
});
