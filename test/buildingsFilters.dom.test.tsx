import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import BuildingsFilters from "../src/components/buildings/BuildingsFilters";
import localizationContext from "../src/localizationContext";
import enTranslation from "../locales/en/translation.json";
import type { BuildingsCatalog, BuildingsRegionQuery } from "../src/buildingsData/types";

const catalog = {
  campaigns: [{ key: "camp", localizedName: "Campaign" }],
  regions: [{ key: "region", localizedName: "Region", campaigns: ["camp"] }],
  cultures: [
    { key: "kho", localizedName: "Khorne" },
    { key: "emp", localizedName: "Empire" },
  ],
  subcultures: [
    { key: "kho_sub", localizedName: "Khornates", culture: "kho" },
    { key: "emp_sub", localizedName: "Empire folk", culture: "emp" },
  ],
  factions: [],
  settlementTypes: [],
  foreignSlotTypes: [
    {
      key: "CULT",
      localizedName: "CULT",
      slotTemplates: ["tmpl_cult"],
      cultures: ["kho"],
      subcultures: ["kho_sub"],
      factions: [],
    },
  ],
} as unknown as BuildingsCatalog;

const renderFilters = (query: Partial<BuildingsRegionQuery>) => {
  const onQueryChange = vi.fn();
  render(
    <localizationContext.Provider value={enTranslation}>
      <BuildingsFilters
        catalog={catalog}
        query={{ campaign: "camp", region: "region", ...query }}
        settlementTypeOptions={[]}
        settlementTypeDisabled={false}
        zoom={1}
        onQueryChange={onQueryChange}
        onZoomChange={vi.fn()}
        onOpenMap={vi.fn()}
      />
    </localizationContext.Provider>,
  );
  return { onQueryChange };
};

/** react-select opens its menu on ArrowDown, and renders every option once it is open. */
const openMenu = (label: string) => {
  const input = screen.getByLabelText(label, { selector: "input" });
  fireEvent.keyDown(input, { key: "ArrowDown", code: "ArrowDown" });
  return input;
};

describe("BuildingsFilters foreign slot types", () => {
  it("says the buildings are not tied to a region and locks the region picker", () => {
    renderFilters({ foreignSlotType: "CULT" });

    expect(screen.getByText(/CULT slots are granted by a slot set, not by a region/)).toBeInTheDocument();
    expect(screen.getByLabelText("Choose region on map")).toBeDisabled();
    expect(screen.getByLabelText("Region", { selector: "input" })).toBeDisabled();
  });

  it("offers only the cultures and subcultures the type's buildings name", () => {
    renderFilters({ foreignSlotType: "CULT" });

    openMenu("Culture");
    expect(screen.getByText("Khorne")).toBeInTheDocument();
    expect(screen.queryByText("Empire")).toBeNull();

    openMenu("Subculture");
    expect(screen.getByText("Khornates")).toBeInTheDocument();
    expect(screen.queryByText("Empire folk")).toBeNull();
  });

  it("keeps every culture while no type is selected", () => {
    renderFilters({});

    expect(screen.queryByText(/not by a region/)).toBeNull();
    expect(screen.getByLabelText("Region", { selector: "input" })).not.toBeDisabled();
    openMenu("Culture");
    expect(screen.getByText("Khorne")).toBeInTheDocument();
    expect(screen.getByText("Empire")).toBeInTheDocument();
  });

  it("drops filters the newly selected type never mentions", () => {
    const { onQueryChange } = renderFilters({ culture: "emp", subculture: "emp_sub" });

    openMenu("Foreign slot type");
    fireEvent.click(screen.getByText("CULT"));

    expect(onQueryChange).toHaveBeenCalledWith({
      foreignSlotType: "CULT",
      settlementType: undefined,
      culture: undefined,
      subculture: undefined,
      faction: undefined,
    });
  });
});
