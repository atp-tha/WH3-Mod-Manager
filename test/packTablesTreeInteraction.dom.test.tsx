import React from "react";
import { configureStore } from "@reduxjs/toolkit";
import { fireEvent, render, screen } from "@testing-library/react";
import { Provider } from "react-redux";
import { describe, expect, it, vi } from "vitest";

import appReducer from "../src/appSlice";
import PackTablesTreeView from "../src/components/viewer/PackTablesTreeView";
import initialState from "../src/initialAppState";

describe("pack table tree interactions", () => {
  const renderPackTree = (tables: string[], preferredTab: "db" | "files" = "db") => {
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
});
