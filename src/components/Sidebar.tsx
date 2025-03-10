import Creatable from "react-select/creatable";
import Select, { ActionMeta, SingleValue } from "react-select";
import React, { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useAppDispatch, useAppSelector } from "../hooks";
import {
  addPreset,
  deletePreset,
  replacePreset,
  selectPreset,
  setFilter,
  createOnGameStartPreset,
  setIsHelpOpen,
} from "../appSlice";
import { Tooltip } from "flowbite-react";
import { UpdateNotification } from "./UpdateNotification";
import OptionsDrawer from "./OptionsDrawer";
import selectStyle from "../styles/selectStyle";
import SaveGames from "./SaveGames";
import { faXmark } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import CompatScreen from "./CompatScreen";
import RequiredMods from "./RequiredMods";
import localizationContext from "../localizationContext";
import Help from "./Help";
import { gameToPackWithDBTablesName } from "../supportedGames";

type OptionType = {
  value: string;
  label: string;
};

const Sidebar = React.memo(() => {
  const dispatch = useAppDispatch();
  const isWH3Running = useAppSelector((state) => state.app.isWH3Running);
  const isMakeUnitsGeneralsEnabled = useAppSelector((state) => state.app.isMakeUnitsGeneralsEnabled);
  const isScriptLoggingEnabled = useAppSelector((state) => state.app.isScriptLoggingEnabled);
  const isSkipIntroMoviesEnabled = useAppSelector((state) => state.app.isSkipIntroMoviesEnabled);
  const isAutoStartCustomBattleEnabled = useAppSelector((state) => state.app.isAutoStartCustomBattleEnabled);
  const isClosedOnPlay = useAppSelector((state) => state.app.isClosedOnPlay);
  const packDataOverwrites = useAppSelector((state) => state.app.packDataOverwrites);
  const filter = useAppSelector((state) => state.app.filter);
  const overwrittenDataPackedFiles = useAppSelector((state) => state.app.overwrittenDataPackedFiles);
  const outdatedPackFiles = useAppSelector((state) => state.app.outdatedPackFiles);
  const dataModLastChangedLocal = useAppSelector((state) => state.app.dataModLastChangedLocal);
  const currentGame = useAppSelector((state) => state.app.currentGame);
  const removedModsData = useAppSelector((state) => state.app.removedModsData);

  const saves = [...useAppSelector((state) => state.app.saves)];
  saves.sort((first, second) => second.lastChanged - first.lastChanged);

  const [isEditPresetsPanelOpen, setIsEditPresetsPanelOpen] = useState<boolean>(false);
  const [isUpdateCheckDone, setIsUpdateCheckDone] = useState<boolean>(false);
  const [isUpdateAvailable, setIsUpdateAvailable] = useState<boolean>(false);
  const [downloadURL, setDownloadURL] = useState<string>("");
  const [releaseNotesURL, setReleaseNotesURL] = useState<string>("");
  const [isShowingSavedGames, setIsShowingSavedGames] = useState<boolean>(false);
  const [isShowingRequiredMods, setIsShowingRequiredMods] = useState<boolean>(false);

  const localized: Record<string, string> = useContext(localizationContext);

  const mods = useAppSelector((state) => state.app.currentPreset.mods);
  const allMods = useAppSelector((state) => state.app.allMods);
  const alwaysEnabledMods = useAppSelector((state) => state.app.alwaysEnabledMods);
  const lastSelectedPreset: Preset | null = useAppSelector((state) => state.app.lastSelectedPreset);
  const areModsInOrder = useAppSelector((state) => state.app.currentPreset.version) != undefined;

  const playDelayTimeoutId = useRef<NodeJS.Timeout | undefined>(undefined);

  const playGameClicked = async () => {
    console.log("playGameClicked: play game clicked");
    if (removedModsData.some((removedModData) => Date.now() - removedModData.time < 3000)) {
      console.log(
        `playGameClicked: An enabled mod was recently removed. Waiting 3.5 seconds before starting.`,
        Date.now()
      );
      if (!playDelayTimeoutId.current) {
        playDelayTimeoutId.current = setTimeout(() => {
          console.log("playGameClicked: triggering delayed plya game", Date.now());
          playDelayTimeoutId.current = undefined;
          dispatch(createOnGameStartPreset());
          window.api?.startGame(mods, areModsInOrder, {
            isMakeUnitsGeneralsEnabled,
            isSkipIntroMoviesEnabled,
            isScriptLoggingEnabled,
            isAutoStartCustomBattleEnabled,
            isClosedOnPlay,
            packDataOverwrites,
          });
        }, 3500);
      }
      return;
    }
    dispatch(createOnGameStartPreset());
    window.api?.startGame(mods, areModsInOrder, {
      isMakeUnitsGeneralsEnabled,
      isSkipIntroMoviesEnabled,
      isScriptLoggingEnabled,
      isAutoStartCustomBattleEnabled,
      isClosedOnPlay,
      packDataOverwrites,
    });
  };

  const options: OptionType[] = useAppSelector((state) =>
    state.app.presets.map((preset) => {
      return { value: preset.name, label: preset.name };
    })
  );

  const newPresetMade = (name: string) => {
    dispatch(addPreset({ name: name, mods: mods }));
    console.log(name);
  };

  let isShiftDown = false;
  let isControlDown = false;

  const onChange = (newValue: SingleValue<OptionType>, actionMeta: ActionMeta<OptionType>) => {
    if (!newValue) return;
    console.log(`label: ${newValue.label}, value: ${newValue.value}, action: ${actionMeta.action}`);
    if (actionMeta.action !== "select-option") return;

    let selectOperation = "unary" as SelectOperation;
    if (isControlDown) selectOperation = "subtraction" as SelectOperation;
    else if (isShiftDown) selectOperation = "addition" as SelectOperation;

    dispatch(selectPreset([newValue.value, selectOperation]));
  };

  const onDeleteChange = (newValue: SingleValue<OptionType>, actionMeta: ActionMeta<OptionType>) => {
    if (!newValue) return;
    console.log(`label: ${newValue.label}, value: ${newValue.value}, action: ${actionMeta.action}`);
    if (actionMeta.action === "select-option") dispatch(deletePreset(newValue.value));
  };

  const onReplaceChange = (newValue: SingleValue<OptionType>, actionMeta: ActionMeta<OptionType>) => {
    if (!newValue) return;
    console.log(`label: ${newValue.label}, value: ${newValue.value}, action: ${actionMeta.action}`);
    if (actionMeta.action === "select-option") dispatch(replacePreset(newValue.value));
  };

  const defaultOption =
    (lastSelectedPreset != null && options.filter((option) => option.value === lastSelectedPreset.name)[0]) ||
    null;

  const onFilterChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    dispatch(setFilter(e.target.value));
  };

  const onMissingDependenciesClicked = () => {
    setIsShowingRequiredMods(true);
  };

  const onContinueGameClicked = () => {
    window.api?.startGame(
      mods,
      areModsInOrder,
      {
        isMakeUnitsGeneralsEnabled,
        isSkipIntroMoviesEnabled,
        isScriptLoggingEnabled,
        isAutoStartCustomBattleEnabled,
        isClosedOnPlay,
        packDataOverwrites,
      },
      saves[0]?.name
    );
  };
  const onShowSavedGamesClicked = () => {
    setIsShowingSavedGames(true);
  };

  const clearFilter = () => {
    dispatch(setFilter(""));
  };

  const getUpdateData = async () => {
    try {
      const appUpdateData = await window.api?.getUpdateData();
      if (!appUpdateData) return;
      if (appUpdateData.updateExists && appUpdateData.downloadURL) {
        console.log("UPDATE EXITS");
        setIsUpdateAvailable(true);
        setDownloadURL(appUpdateData.downloadURL);

        if (appUpdateData.releaseNotesURL) {
          setReleaseNotesURL(appUpdateData.releaseNotesURL);
        }

        setTimeout(() => {
          setIsUpdateAvailable(false);
        }, 15000);
      }
    } catch (err) {
      console.log(err);
    }
  };
  useEffect(() => {
    if (!isUpdateCheckDone) {
      setIsUpdateCheckDone(true);
      getUpdateData();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "f") {
        const filterInput = document.getElementById("filterInput");
        filterInput?.focus();
      }

      if (e.key === "Shift") isShiftDown = true;
      if (e.key === "Control") isControlDown = true;
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") isShiftDown = false;
      if (e.key === "Control") isControlDown = false;
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
    };
  });

  const enabledMods = mods.filter(
    (iterMod) => iterMod.isEnabled || alwaysEnabledMods.find((mod) => mod.name === iterMod.name)
  );

  const isDependencyEnabledByPackName = useCallback(
    (reqId: string): boolean => {
      const modInAllById = allMods.find((mod) => mod.workshopId == reqId);
      if (!modInAllById) return false;
      return enabledMods.some((enabledMod) => enabledMod.name == modInAllById.name);
    },
    [allMods, enabledMods]
  );

  const missingModDependencies = enabledMods
    .filter((mod) => mod.reqModIdToName && mod.reqModIdToName.length > 0)
    .map((mod) => mod as ModWithDefinedReqModIdToName)
    .map(
      (mod) =>
        [
          mod,
          mod.reqModIdToName.filter(
            ([reqId]) =>
              !isDependencyEnabledByPackName(reqId) &&
              !enabledMods.some((enabledMod) => enabledMod.workshopId == reqId)
          ),
        ] as [Mod, [string, string][]]
    )
    .filter((member) => member[1].length > 0);

  const outdatedMergedPacks = enabledMods
    .filter((mod) => mod.mergedModsData)
    .map((mod) => mod as ModWithDefinedMergedModsData)
    .filter((mod) =>
      mod.mergedModsData.some((mergedModData) => {
        const enabledMod = enabledMods.find((enabledMod) => enabledMod.path == mergedModData.path);
        // if (enabledMod) {
        //   console.log(enabledMod.path);
        //   console.log(enabledMod.lastChanged);
        //   console.log(enabledMod.lastChangedLocal);
        //   console.log(mergedModData.lastChanged);
        //   if (
        //     enabledMod.lastChanged != mergedModData.lastChanged &&
        //     enabledMod.lastChangedLocal != mergedModData.lastChanged
        //   )
        //     console.log("THIS ONE");
        // }
        return (
          enabledMod &&
          enabledMod.lastChanged != mergedModData.lastChanged &&
          enabledMod.lastChangedLocal != mergedModData.lastChanged
        );
      })
    );

  const timeCheckedOverwrittenDataPackedFiles: typeof overwrittenDataPackedFiles = {};
  if (dataModLastChangedLocal) {
    for (const [packName, data] of Object.entries(overwrittenDataPackedFiles)) {
      const mod = enabledMods.find((iterMod) => !iterMod.isInData && iterMod.name == packName);
      if (mod && mod.lastChanged && mod.lastChanged < dataModLastChangedLocal) {
        timeCheckedOverwrittenDataPackedFiles[packName] = data;
      }
    }
  }

  return (
    <div>
      <SaveGames isOpen={isShowingSavedGames} setIsOpen={setIsShowingSavedGames} />
      <Help></Help>

      <RequiredMods
        isOpen={isShowingRequiredMods}
        setIsOpen={setIsShowingRequiredMods}
        modDependencies={missingModDependencies}
      />
      <div className="fixed h-[90vh]">
        <div id="presetSection">
          <Tooltip
            placement="left"
            style="light"
            content={
              <>
                <p>{localized.presetsTooltip1}</p>
                <p className="mt-3">{localized.presetsTooltip2}</p>
                <p>{localized.presetsTooltip3}</p>
                <p>{localized.presetsTooltip4}</p>
              </>
            }
          >
            <span className="text-slate-100 select-none">{localized.selectOrCreatePreset}</span>
          </Tooltip>
          <Creatable
            id="createOrSelectPreset"
            value={defaultOption}
            options={options}
            onChange={onChange}
            styles={selectStyle}
            onCreateOption={(name) => newPresetMade(name)}
          ></Creatable>
          <div
            className={
              "pb-1 border-slate-100-opacity-6 mt-5 w-full flex text-slate-100 items-center region-click cursor-pointer select-none icon-color-on-hover " +
              ((!isEditPresetsPanelOpen && "border-b-2") || "")
            }
            onClick={() => {
              setIsEditPresetsPanelOpen(!isEditPresetsPanelOpen);
            }}
          >
            <svg
              stroke="currentcolor"
              fill="currentcolor"
              strokeWidth="0"
              viewBox="0 0 24 24"
              height="0.9em"
              width="0.9em"
              xmlns="http://www.w3.org/2000/svg"
              style={{ marginTop: "1px" }}
            >
              {(isEditPresetsPanelOpen && (
                <path d="M11.178 19.569a.998.998 0 0 0 1.644 0l9-13A.999.999 0 0 0 21 5H3a1.002 1.002 0 0 0-.822 1.569l9 13z"></path>
              )) || (
                <path d="M5.536 21.886a1.004 1.004 0 0 0 1.033-.064l13-9a1 1 0 0 0 0-1.644l-13-9A1 1 0 0 0 5 3v18a1 1 0 0 0 .536.886z"></path>
              )}
            </svg>
            <span className="ml-1">{localized.editPresets}</span>
          </div>
          {isEditPresetsPanelOpen && (
            <div className="expandable-panel-rounded-border border-slate-100-opacity-6">
              <div className="">
                <span className="text-slate-100 select-none">{localized.replacePreset}</span>
                <Select
                  id="replacePreset"
                  options={options}
                  styles={selectStyle}
                  onChange={onReplaceChange}
                  value={null}
                ></Select>
              </div>
              <div className="mt-4">
                <span className="text-slate-100 select-none">{localized.deletePreset}</span>
                <Select
                  id="deletePreset"
                  options={options}
                  styles={selectStyle}
                  onChange={onDeleteChange}
                  value={null}
                ></Select>
              </div>
            </div>
          )}
        </div>

        <div className="mt-5 static">
          <span className="text-slate-100 select-none">{localized.filter}</span>
          <span className="relative">
            <input
              id="filterInput"
              type="text"
              onChange={(e) => onFilterChange(e)}
              value={filter}
              className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white dark:focus:ring-blue-500 dark:focus:border-blue-500"
            ></input>

            <span className="absolute right-[0.65rem] top-8 text-gray-400">
              <button onClick={() => clearFilter()}>
                <FontAwesomeIcon icon={faXmark} />
              </button>
            </span>
          </span>
        </div>

        <div className="absolute w-full bottom-0 z-10">
          {missingModDependencies.length > 0 && (
            <div className="text-center text-red-700 font-semibold mb-4">
              <div
                className="make-tooltip-w-full cursor-pointer"
                onClick={() => onMissingDependenciesClicked()}
              >
                <Tooltip
                  placement="left"
                  content={missingModDependencies.map(([mod, reqs]) => (
                    <div key={mod.path}>
                      <span className="">{mod.humanName + ` ${localized.missing}`}</span>
                      {
                        // eslint-disable-next-line @typescript-eslint/no-unused-vars
                        reqs.map(([reqId, reqHumanName]) => (
                          <div key={`${mod.path}_${reqHumanName}`} className="text-red-600">
                            {reqHumanName}
                          </div>
                        ))
                      }
                    </div>
                  ))}
                >
                  {localized.missingReqMods}
                </Tooltip>
              </div>
            </div>
          )}

          {currentGame == "wh3" && Object.keys(timeCheckedOverwrittenDataPackedFiles).length > 0 && (
            <div className="text-center text-red-700 font-semibold mb-4">
              <div className="make-tooltip-w-full">
                <Tooltip
                  placement="left"
                  content={
                    <>
                      <p className="cursor-default">{localized.outdatedOverwritingPacksTooltip}</p>
                      {Object.entries(timeCheckedOverwrittenDataPackedFiles).map(
                        ([packName, overwrittenFileNames]) => (
                          <div key={packName}>
                            <span className="">{packName + ` ${localized.overwrites}`}</span>
                            {overwrittenFileNames.map((packedFileName) => (
                              <div key={`${packName}_${packedFileName}`} className="text-red-600">
                                {packedFileName}
                              </div>
                            ))}
                          </div>
                        )
                      )}
                    </>
                  }
                >
                  <span className="cursor-default">{localized.outdatedOverwritingPacks}</span>
                </Tooltip>
              </div>
            </div>
          )}

          {currentGame == "wh3" && Object.keys(outdatedPackFiles).length > 0 && (
            <div className="text-center text-red-700 font-semibold mb-4">
              <div className="make-tooltip-w-full">
                <Tooltip
                  placement="left"
                  content={
                    <>
                      <p>{localized.packsWithOutdatedFiles}</p>
                      {Object.entries(outdatedPackFiles).map(([packName, overwrittenFileNames]) => (
                        <div key={packName}>
                          <span className="">{`${packName}:`}</span>
                          {overwrittenFileNames.map((packedFileName) => (
                            <div key={`${packName}_${packedFileName}`} className="text-red-600">
                              {`Patch ${packedFileName}`}
                            </div>
                          ))}
                        </div>
                      ))}
                    </>
                  }
                >
                  {localized.outdatedPacks}
                </Tooltip>
              </div>
            </div>
          )}

          {outdatedMergedPacks.length > 0 && (
            <div className="text-center text-red-700 font-semibold mb-4">
              <div className="make-tooltip-w-full">
                <Tooltip
                  placement="left"
                  content={
                    <>
                      <div>{localized.outdatedMergedModsTooltip}</div>
                      {outdatedMergedPacks.map((mod) => (
                        <div key={mod.path}>
                          <span className="">{mod.name + ` is not up to date`}</span>
                        </div>
                      ))}
                    </>
                  }
                >
                  {localized.outdatedMergedMods}
                </Tooltip>
              </div>
            </div>
          )}
          {enabledMods.length > 0 && (
            <div className="text-center text-slate-100 mb-4">
              <div className="make-tooltip-w-full">
                <Tooltip
                  placement="left"
                  content={enabledMods.map((mod) => (
                    <div key={mod.path}>{mod.name.replace(".pack", "")}</div>
                  ))}
                >
                  <span className="cursor-default">
                    {localized.enabledMods} {enabledMods.length}
                  </span>
                </Tooltip>
              </div>
            </div>
          )}
          <div className="flex flex-col items-center">
            <button
              id="playGame"
              disabled={isWH3Running}
              className={`bg-green-500 hover:bg-green-700 text-white font-bold py-2 px-4 rounded h-14 w-36 m-auto ${
                (isWH3Running &&
                  "bg-opacity-50 hover:bg-opacity-50 text-opacity-50 hover:text-opacity-50 cursor-not-allowed") ||
                ""
              }`}
              onClick={async () => await playGameClicked()}
            >
              {(isWH3Running && (
                <div className="make-tooltip-w-full">
                  <Tooltip placement="left" content={"Game is currently running!"}>
                    <div className="flex justify-center items-center gap-[0.4rem]">
                      <img
                        style={{ filter: "drop-shadow(0px 0px 7.5px black)" }}
                        className="aspect-square w-10"
                        src={require(`../assets/game_icons/${currentGame}.png`)}
                      />
                    </div>
                  </Tooltip>
                </div>
              )) || (
                <div className="flex justify-center items-center gap-[0.4rem]">
                  <img
                    style={{ filter: "drop-shadow(0px 0px 7.5px black)" }}
                    className="aspect-square w-10"
                    src={require(`../assets/game_icons/${currentGame}.png`)}
                  />
                  <span className="playButtonText uppercase">{localized.play}</span>
                </div>
              )}
            </button>

            <div className="mt-2 w-36 relative">
              <button
                id="continueGame"
                className={`bg-green-600 border-green-500 border-2 hover:bg-green-700 text-white font-medium text-sm px-4 rounded h-7 w-36 m-auto ${
                  (isWH3Running &&
                    "bg-opacity-50 hover:bg-opacity-50 text-opacity-50 hover:text-opacity-50 cursor-not-allowed") ||
                  ""
                }`}
                onClick={() => onContinueGameClicked()}
                disabled={saves.length < 1 || isWH3Running}
              >
                <div className="make-tooltip-w-full">
                  <Tooltip
                    placement="left"
                    content={(saves[0] && `Load ${saves[0].name}`) || "No saves found!"}
                  >
                    <span className="ml-[-25%]">{localized.continue}</span>
                  </Tooltip>
                </div>
              </button>
              <button
                id="showSaves"
                type="submit"
                className="absolute h-7 bottom-0 right-0 px-1 text-sm font-medium text-white bg-green-600 rounded-r-lg border-2 border-green-500 hover:bg-green-700 focus:ring-4 focus:outline-none focus:ring-blue-300 dark:bg-green-600 dark:hover:bg-green-700 dark:focus:ring-green-800"
                onClick={() => onShowSavedGamesClicked()}
                disabled={saves.length < 1}
              >
                <div className="make-tooltip-w-full">
                  <Tooltip placement="left" content={(saves[0] && `Show all saves`) || "No saves found!"}>
                    <svg
                      aria-hidden="true"
                      className="h-6 w-6"
                      fill="none"
                      stroke="currentColor"
                      overflow="visible"
                      viewBox="0 0 24 24"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 5l7 7-7 7"
                      ></path>
                    </svg>
                  </Tooltip>
                </div>
              </button>
            </div>
          </div>
        </div>

        <div className="mt-6">
          <OptionsDrawer />
        </div>
        <div className="mt-4">
          <CompatScreen />
        </div>
        {/* <div className="mt-4">
          <ModsMerger />
        </div> */}
        <div className="mt-4">
          <div className="text-center mt-4">
            <button
              onClick={() =>
                window.api?.requestOpenModInViewer(gameToPackWithDBTablesName[currentGame] || "db.pack")
              }
              className="w-36 text-white bg-blue-700 hover:bg-blue-800 focus:ring-4 focus:ring-blue-300 font-medium rounded-lg text-sm px-5 py-2.5 mx-2 mb-2 m-auto dark:bg-transparent dark:hover:bg-gray-700 dark:border-gray-600 dark:border-2 focus:outline-none dark:focus:ring-gray-800"
              type="button"
            >
              {localized.dbViewer}
            </button>
          </div>
        </div>

        <div className="mt-4">
          <div className="text-center mt-4">
            <button
              onClick={() => dispatch(setIsHelpOpen(true))}
              className="w-36 text-white bg-blue-700 hover:bg-blue-800 focus:ring-4 focus:ring-blue-300 font-medium rounded-lg text-sm px-5 py-2.5 mx-2 mb-2 m-auto dark:bg-transparent dark:hover:bg-gray-700 dark:border-gray-600 dark:border-2 focus:outline-none dark:focus:ring-gray-800"
              type="button"
            >
              {localized.faqAbbreviated}
            </button>
          </div>
        </div>
      </div>

      {isUpdateAvailable && (
        <div
          className={"dark fixed w-80 mx-auto inset-x-0 bottom-[1%] " + (isUpdateAvailable ? "" : "hidden")}
        >
          <UpdateNotification
            downloadURL={downloadURL}
            releaseNotesURL={releaseNotesURL}
          ></UpdateNotification>
        </div>
      )}
    </div>
  );
});

export default Sidebar;
