import { Pack, PackCollisions } from "./packFileTypes";
import { SupportedGames, supportedGames } from "./supportedGames";

interface AppData {
  presets: Preset[];

  // gamePaths: Record<string, string>;
  // contentFolders: Record<string, string>;
  // dataFolders: Record<string, string>;
  gamesToGameFolderPaths: Record<string, GameFolderPaths>;
  gamesToSteamAppsFolderPaths: Record<string, string>;
  gameSaves: GameSave[];
  saveSetupDone: boolean;
  isMakeUnitsGeneralsEnabled: boolean;
  hasReadConfig: boolean;
  packsData: Pack[];
  compatData: PackCollisions;
  currentlyReadingModPaths: string[];
  vanillaPacks: Pack[];
  allVanillaPackNames: string[];
  overwrittenDataPackedFiles: Record<string, string[]>;
  outdatedPackFiles: Record<string, string[]>;
  enabledMods: Mod[];
  startArgs: string[];
  isAdmin: boolean;
  gameUpdates: GameUpdateData[];
  isWH3Running: boolean;
  currentGame: SupportedGames;
  gameToCurrentPreset: Record<SupportedGames, Preset | undefined>;
  gameToPresets: Record<SupportedGames, Preset[]>;
  vanillaPacksDBFileNames: string[];
  waitForModIds: string[];
  subscribedModIds: string[];
  isCompatCheckingVanillaPacks: boolean;
  modIdsToResubscribeTo: string[];
  isViewerReady: boolean;
  queuedViewerData: (PackViewData | undefined)[];
}

export type GameFolderPaths = {
  gamePath: string | undefined;
  contentFolder: string | undefined;
  dataFolder: string | undefined;
};

const appData = {
  presets: [],
  // gamePaths: {},
  // contentFolders: {},
  // dataFolders: {},
  gamesToGameFolderPaths: {},
  gamesToSteamAppsFolderPaths: {},
  gameSaves: [],
  saveSetupDone: false,
  isMakeUnitsGeneralsEnabled: false,
  hasReadConfig: false,
  packsData: [],
  compatData: {
    packTableCollisions: [],
    packFileCollisions: [],
    missingTableReferences: {},
    uniqueIdsCollisions: {},
    scriptListenerCollisions: {},
    packFileAnalysisErrors: {},
    missingFileRefs: {},
  },
  currentlyReadingModPaths: [],
  overwrittenDataPackedFiles: {},
  outdatedPackFiles: {},
  enabledMods: [],
  startArgs: [],
  isAdmin: false,
  gameUpdates: [],
  isWH3Running: false,
  currentGame: "wh3",
  vanillaPacks: [],
  allVanillaPackNames: [],
  vanillaPacksDBFileNames: [],
  waitForModIds: [],
  subscribedModIds: [],
  isCompatCheckingVanillaPacks: false,
  modIdsToResubscribeTo: [],
  isViewerReady: false,
  queuedViewerData: [],
} as Omit<AppData, "gameToCurrentPreset" | "gameToPresets">;
for (const supportedGame of supportedGames) {
  appData.gamesToGameFolderPaths[supportedGame] = {
    gamePath: undefined,
    dataFolder: undefined,
    contentFolder: undefined,
  };
}

(appData as AppData).gameToCurrentPreset = {
  wh2: undefined,
  wh3: undefined,
  threeKingdoms: undefined,
  attila: undefined,
  troy: undefined,
  pharaoh: undefined,
  dynasties: undefined,
};
(appData as AppData).gameToPresets = {
  wh2: [],
  wh3: [],
  threeKingdoms: [],
  attila: [],
  troy: [],
  pharaoh: [],
  dynasties: [],
};

export default appData as AppData;
