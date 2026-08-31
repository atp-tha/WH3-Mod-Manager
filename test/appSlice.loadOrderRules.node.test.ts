import { afterEach, beforeEach, describe, expect, it } from "vitest";

import appReducer, {
  addLoadOrderRule,
  removeLoadOrderRule,
  setLoadOrderRulePackDisabled,
  setModLoadOrderRuleDisabled,
  setModLoadOrderRules,
} from "../src/appSlice";
import initialState from "../src/initialAppState";
import { loadOrderRuleKey } from "../src/loadOrderRules";
import { getActiveLoadOrderEdges, resetActiveLoadOrderEdges, sortByNameAndLoadOrder } from "../src/modSortingHelpers";

const createMod = (name: string): Mod =>
  ({
    name,
    humanName: name,
    path: `/mods/${name}`,
    isEnabled: true,
    isInData: true,
    author: "",
    tags: [],
  }) as unknown as Mod;

const stateWithMods = (names: string[]): AppState => ({
  ...initialState,
  currentPreset: { ...initialState.currentPreset, mods: names.map(createMod) },
});

const reduceAll = (state: AppState, actions: { type: string; payload?: unknown }[]) =>
  actions.reduce((current, action) => appReducer(current, action as never), state);

describe("load order rule reducers", () => {
  beforeEach(() => resetActiveLoadOrderEdges());
  afterEach(() => resetActiveLoadOrderEdges());

  const base = () => stateWithMods(["a.pack", "b.pack", "c.pack"]);

  it("stores a user rule and puts it into effect", () => {
    const next = appReducer(base(), addLoadOrderRule({ before: "c.pack", after: "a.pack" }));

    expect(next.loadOrderRules).toEqual([{ before: "c.pack", after: "a.pack" }]);
    expect(next.loadOrderRulesResolution.rules).toHaveLength(1);
    expect(sortByNameAndLoadOrder(next.currentPreset.mods).map((mod) => mod.name)).toEqual([
      "b.pack",
      "c.pack",
      "a.pack",
    ]);
  });

  it("normalizes the pack names it is given", () => {
    const next = appReducer(base(), addLoadOrderRule({ before: "C", after: "a" }));
    expect(next.loadOrderRules).toEqual([{ before: "C.pack", after: "a.pack" }]);
  });

  it("replaces an existing rule about the same pair instead of contradicting it", () => {
    const next = reduceAll(base(), [
      addLoadOrderRule({ before: "a.pack", after: "b.pack" }),
      addLoadOrderRule({ before: "b.pack", after: "a.pack" }),
    ]);

    expect(next.loadOrderRules).toEqual([{ before: "b.pack", after: "a.pack" }]);
    expect(next.loadOrderRulesResolution.conflicts).toHaveLength(0);
  });

  it("ignores a rule pointing a pack at itself", () => {
    const next = appReducer(base(), addLoadOrderRule({ before: "a.pack", after: "A.PACK" }));
    expect(next.loadOrderRules).toEqual([]);
  });

  it("removes a rule regardless of how the name is spelled", () => {
    const next = reduceAll(base(), [
      addLoadOrderRule({ before: "a.pack", after: "b.pack" }),
      removeLoadOrderRule({ before: "A", after: "B.PACK" }),
    ]);

    expect(next.loadOrderRules).toEqual([]);
    expect(next.loadOrderRulesResolution.rules).toHaveLength(0);
  });

  it("publishes the edges to the ambient registry for callers outside react", () => {
    expect(getActiveLoadOrderEdges().edgeCount).toBe(0);
    appReducer(base(), addLoadOrderRule({ before: "c.pack", after: "a.pack" }));
    expect(getActiveLoadOrderEdges().edgeCount).toBe(1);
  });

  describe("mod-supplied rules", () => {
    const withModRules = () =>
      appReducer(
        base(),
        setModLoadOrderRules({ "c.pack": [{ before: "c.pack", after: "a.pack", sourcePackName: "c.pack" }] }),
      );

    it("applies them without the user doing anything", () => {
      const next = withModRules();
      expect(next.loadOrderRulesResolution.rules).toHaveLength(1);
      expect(sortByNameAndLoadOrder(next.currentPreset.mods)[0].name).toBe("b.pack");
    });

    it("switches one off and keeps it listed so it can come back", () => {
      const rule = { before: "c.pack", after: "a.pack", sourcePackName: "c.pack" };
      const next = appReducer(withModRules(), setModLoadOrderRuleDisabled({ rule, isDisabled: true }));

      expect(next.disabledModLoadOrderRules).toEqual([loadOrderRuleKey(rule)]);
      expect(next.loadOrderRulesResolution.rules).toHaveLength(0);
      expect(next.loadOrderRulesResolution.disabledRules).toHaveLength(1);
      expect(sortByNameAndLoadOrder(next.currentPreset.mods).map((mod) => mod.name)).toEqual([
        "a.pack",
        "b.pack",
        "c.pack",
      ]);
    });

    it("switches one back on", () => {
      const rule = { before: "c.pack", after: "a.pack", sourcePackName: "c.pack" };
      const next = reduceAll(withModRules(), [
        setModLoadOrderRuleDisabled({ rule, isDisabled: true }),
        setModLoadOrderRuleDisabled({ rule, isDisabled: false }),
      ]);

      expect(next.disabledModLoadOrderRules).toEqual([]);
      expect(next.loadOrderRulesResolution.rules).toHaveLength(1);
    });

    it("refuses to disable a rule the user made, which is deleted instead", () => {
      const next = reduceAll(base(), [
        addLoadOrderRule({ before: "c.pack", after: "a.pack" }),
        setModLoadOrderRuleDisabled({ rule: { before: "c.pack", after: "a.pack" }, isDisabled: true }),
      ]);

      expect(next.disabledModLoadOrderRules).toEqual([]);
      expect(next.loadOrderRulesResolution.rules).toHaveLength(1);
    });

    it("mutes a whole pack, covering rules it adds afterwards", () => {
      const muted = appReducer(withModRules(), setLoadOrderRulePackDisabled({ packName: "c.pack", isDisabled: true }));
      expect(muted.loadOrderRulesResolution.rules).toHaveLength(0);

      const withNewerRule = appReducer(
        muted,
        setModLoadOrderRules({
          "c.pack": [
            { before: "c.pack", after: "a.pack", sourcePackName: "c.pack" },
            { before: "c.pack", after: "b.pack", sourcePackName: "c.pack" },
          ],
        }),
      );

      expect(withNewerRule.loadOrderRulesResolution.rules).toHaveLength(0);
      expect(withNewerRule.loadOrderRulesResolution.disabledRules).toHaveLength(2);
    });

    it("lets a user rule supersede a mod rule about the same pair", () => {
      const next = appReducer(withModRules(), addLoadOrderRule({ before: "a.pack", after: "c.pack" }));

      expect(next.loadOrderRulesResolution.rules).toEqual([
        expect.objectContaining({ before: "a.pack", after: "c.pack" }),
      ]);
      expect(next.loadOrderRulesResolution.supersededRules).toHaveLength(1);
    });
  });

  it("reports a rule naming a pack that is not installed", () => {
    const next = appReducer(base(), addLoadOrderRule({ before: "a.pack", after: "nowhere.pack" }));

    expect(next.loadOrderRulesResolution.rules).toHaveLength(0);
    expect(next.loadOrderRulesResolution.conflicts).toEqual([
      expect.objectContaining({ kind: "missingPack", packName: "nowhere.pack" }),
    ]);
  });
});
