import React from "react";
import { configureStore } from "@reduxjs/toolkit";
import { Provider } from "react-redux";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import appReducer from "../src/appSlice";
import initialState from "../src/initialAppState";
import SkillsTreeView from "../src/components/skillsViewer/SkillsTreeView";

const nodeSetKeys = [
  "wh_main_skill_node_set_emp_karl_franz",
  "wh_main_skill_node_set_emp_balthasar_gelt",
  "wh_main_skill_node_emp_teclis_magic",
  "wh_main_skill_node_lzd_kroq_gar",
  "wh_main_skill_node_dwf_thorgrim",
  "wh_main_skill_node_vmp_mannfred",
];

const skillsData = {
  currentSubtype: "wh_main_emp_karl_franz",
  currentSubtypeIndex: 0,
  currentSkills: [],
  subtypeToNumSets: Object.fromEntries(nodeSetKeys.map((_, index) => [`subtype_${index}`, 1])),
  subtypesToSet: Object.fromEntries(nodeSetKeys.map((nodeSetKey, index) => [`subtype_${index}`, [nodeSetKey]])),
  nodeLinks: {},
  nodeRequirements: {},
  icons: {},
  subtypes: nodeSetKeys.map((_, index) => `subtype_${index}`),
  subtypesToLocalizedNames: {},
  nodeToSkillLocks: {},
  abilityTooltipsByKey: {},
  effectToUnitAbilityEnables: {},
} as SkillsData;

describe("SkillsTreeView", () => {
  it("also hides the repeated set marker in node-set mode", () => {
    const store = configureStore({
      reducer: { app: appReducer },
      preloadedState: {
        app: {
          ...initialState,
          isShowingSkillNodeSetNames: true,
          skillsData,
        },
      },
    });

    render(
      <Provider store={store}>
        <SkillsTreeView tableFilter="" />
      </Provider>,
    );

    expect(screen.getByText("emp_karl_franz")).toBeInTheDocument();
    expect(screen.queryByText("set_emp_karl_franz")).not.toBeInTheDocument();
  });
});
