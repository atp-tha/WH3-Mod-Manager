import React from "react";
import { configureStore } from "@reduxjs/toolkit";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { describe, expect, it, vi } from "vitest";

import appReducer from "../src/appSlice";
import initialState from "../src/initialAppState";
import LocalizationContext from "../src/localizationContext";
import LoadOrderRulesView from "../src/components/viewer/LoadOrderRulesView";

describe("load order rules viewer", () => {
  it("keeps the pack name input focused while typing", async () => {
    const user = userEvent.setup();
    const packPath = "C:\\mods\\rules.pack";
    const filePath = "whmm\\load_order.whmm";
    const saveTextPackedFileEdits = vi.fn().mockResolvedValue({ success: true });
    window.api = { saveTextPackedFileEdits } as unknown as NonNullable<Window["api"]>;

    const store = configureStore({
      reducer: { app: appReducer },
      preloadedState: {
        app: {
          ...initialState,
          isFeaturesForModdersEnabled: true,
          currentPreset: {
            ...initialState.currentPreset,
            mods: [],
          },
          packsData: {
            [packPath]: {
              packName: "rules.pack",
              packPath,
              tables: [],
              packedFiles: {
                [filePath]: {
                  name: filePath,
                  file_size: 1,
                  start_pos: 0,
                  text: "BEFORE\tother.pack\n",
                },
              },
            },
          },
        },
      },
    });

    render(
      <Provider store={store}>
        <LocalizationContext.Provider value={{}}>
          <LoadOrderRulesView packPath={packPath} filePath={filePath} showDialog={vi.fn()} />
        </LocalizationContext.Provider>
      </Provider>,
    );

    const input = await screen.findByDisplayValue("other.pack");
    await user.type(input, "x");

    expect(input).toHaveValue("other.packx");
    expect(input).toHaveFocus();
  });
});
