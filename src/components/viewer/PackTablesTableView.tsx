import React, { useCallback, useEffect, useMemo, useRef, memo, useState } from "react";
import { useAppDispatch, useAppSelector } from "../../hooks";
import { AgGridReact } from "ag-grid-react";
import type {
  CellContextMenuEvent,
  CellMouseDownEvent,
  CellMouseOverEvent,
  CellValueChangedEvent,
  ColDef,
} from "ag-grid-community";
import { AllCommunityModule, ModuleRegistry } from "ag-grid-community";
import { getDBPackedFilePath, getPackNameFromPath } from "../../utility/packFileHelpers";
import { buildDefaultCellValue, buildDefaultRowSchemaFields, parseEditedCellValue } from "../../utility/dbRowCells";
import { AmendedSchemaField, DBVersion, Field, PackedFile, SCHEMA_FIELD_TYPE } from "../../packFileTypes";
import { setDeepCloneTarget } from "@/src/appSlice";
import { dataFromBackend } from "./packDataStore";
import debounce from "just-debounce-it";
import {
  clearPreparedTableForPackedFile,
  ColumnWidthHint,
  getPreparedTable,
  PreparedTableData,
  PreparedRowData,
  setPreparedTable,
  TableCellValue,
} from "./tablePrepCache";
import type { ShowViewerDialog } from "./viewerDialogs";
import { pickWidestValue, type WidestValue } from "./viewerHelpers";
import { makeSelectCurrentPackData, makeSelectCurrentPackUnsavedFiles } from "./viewerSelectors";
import { vanillaPackNames } from "@/src/supportedGames";
import { isDBCloneTableIgnored } from "@/src/utility/dbCloneTableRouting";
import CopyIntoSubmenu from "./CopyIntoSubmenu";
import type { CopyIntoSource, ViewerPackTarget } from "./PackTablesTreeView";
import { getRowsForCopy, getSelectedRowIndices } from "./copyRows";

const BIG_TABLE_ROW_THRESHOLD = 20000;
const BIG_TABLE_CELL_THRESHOLD = 2000000;
// Line box plus the space around it, at the 17.6px cells render at.
const BIG_TABLE_ROW_HEIGHT = 23 + 8;
const NORMAL_TABLE_ROW_HEIGHT = 28 + 8;
/** Floor for a numeric column; above this they are sized to their widest value like text ones. */
const NUMERIC_COLUMN_MIN_WIDTH_PX = 56;
const BIG_TABLE_CHECKBOX_COL_WIDTH = 36;
const FIXED_SIZING_ROW_THRESHOLD = 1000;
const TABLE_PREP_CACHE_VERSION = 5;
const ROW_INDEX_COLUMN_MIN_WIDTH = 50;
const ROW_INDEX_COLUMN_PADDING_PX = 20;
const SELECTION_AUTO_SCROLL_EDGE_PX = 32;
/** How far the pointer leaves the middle-button anchor before the table starts moving. */
const MIDDLE_AUTO_SCROLL_DEAD_ZONE_PX = 12;
const MIDDLE_AUTO_SCROLL_SPEED = 0.18;
const MIDDLE_AUTO_SCROLL_MAX_STEP_PX = 40;
/**
 * Narrower than this and hiding columns is not worth offering: the table already fits, and dropping
 * a column the reader can see would cost more than the width it saves. Above it, hiding is on
 * unless it is turned off, since a table this wide is the case the toggle exists for.
 */
const HIDE_DEFAULT_COLUMNS_MIN_COLUMN_COUNT = 12;
/** Enough hidden columns named in the tooltip to be useful without turning it into a wall of text. */
const HIDDEN_COLUMN_TOOLTIP_LIMIT = 30;
/** Below this the middle button counts as a click, which leaves auto-scroll running after the release. */
const MIDDLE_AUTO_SCROLL_DRAG_THRESHOLD_PX = 8;
const SELECTION_AUTO_SCROLL_MAX_STEP_PX = 24;
// Cells render at `.ag-cell { font-size: 1.1rem }` from index.css, which is 17.6px. Measuring them
// at anything smaller makes every column narrower than its contents, which shows up as ellipsised
// values in whichever column holds the longest text - usually a key column.
const GRID_CELL_FONT = '400 17.6px "Roboto", "Inter", Arial, sans-serif';
const ROW_INDEX_GRID_CELL_FONT = GRID_CELL_FONT;
/** Upper bound on one glyph's advance at GRID_CELL_FONT, generous enough to cover full-width ones. */
const GRID_CELL_MAX_GLYPH_WIDTH_PX = 24;
const TEXT_COLUMN_WIDTH_CHAR_PX = 9;
/**
 * Space a cell needs around its value: twice the `--ag-cell-horizontal-padding` set on the grid in
 * index.css, plus the cell's 1px borders and a little slack.
 */
const CELL_CONTENT_PADDING_PX = 24;
/**
 * Fallback for the space a header puts around its text, used for the first paint only - after that
 * the real figure is measured off a rendered header. Deliberately generous: too small clips headers,
 * too large only wastes width for one frame.
 *
 * It is not worth deriving by hand. The gutters come from the header cell's padding, a negative
 * margin and a padding on the label inside it, and whatever the theme adds around those, and every
 * attempt to add that up from the stylesheets got a different answer than the browser did.
 */
const HEADER_CHROME_FALLBACK_PX = 64;
/** Ignore a measurement outside this range: the grid was not laid out yet, or the DOM moved on. */
const HEADER_CHROME_PLAUSIBLE_RANGE_PX = { min: 4, max: 200 };
const TEXT_COLUMN_WIDTH_MIN_PX = 110;
const GRID_HEADER_FONT = '500 14px "Roboto", "Inter", Arial, sans-serif';
const KEY_HEADER_ICON_WIDTH_PX = 22;
const COLUMN_HEADER_DISPLAY_NAMES: Record<string, string> = {
  "additional building requirement": "building req.",
  "campaign cap": "camp. cap",
  "create time": "creation time",
  "multiplayer cap": "MP cap",
  "multiplayer cost": "MP cost",
  "num men": "men",
  "num ships": "ships",
};

const AG_GRID_MODULES_KEY = "__whmmAgGridModulesRegistered";
const globalAny = globalThis as unknown as Record<string, unknown>;
if (!globalAny[AG_GRID_MODULES_KEY]) {
  ModuleRegistry.registerModules([AllCommunityModule]);
  globalAny[AG_GRID_MODULES_KEY] = true;
}

type RowData = PreparedRowData;
type SelectionRange = { startRow: number; endRow: number; startCol: number; endCol: number };
type DragSelectionState = {
  mode: "cells" | "row";
  anchorRow: number;
  anchorCol: number;
  baseRanges: SelectionRange[];
};

let textMeasureContext: CanvasRenderingContext2D | undefined;

const getColumnFieldKey = (colIndex: number): string => String(colIndex);

const measureTextWidth = (text: string, font: string): number => {
  if (text.length === 0) return 0;
  if (typeof document === "undefined") {
    return Math.ceil(text.length * TEXT_COLUMN_WIDTH_CHAR_PX);
  }

  if (!textMeasureContext) {
    textMeasureContext = document.createElement("canvas").getContext("2d") ?? undefined;
  }

  if (!textMeasureContext) {
    return Math.ceil(text.length * TEXT_COLUMN_WIDTH_CHAR_PX);
  }

  textMeasureContext.font = font;
  return Math.ceil(textMeasureContext.measureText(text).width);
};

const measureGridCellText = (text: string): number => measureTextWidth(text, GRID_CELL_FONT);

/**
 * Measured once per session, then reused: the header chrome is the same for every grid.
 */
let measuredHeaderChromePx: number | undefined;

/**
 * How much of a header cell's width is taken by everything other than its text, read off the
 * rendered grid.
 *
 * An unsorted header specifically, because a sorted one widens its left gutter for the arrow and
 * would have every column reserving space for a sort that is not there. Spelled as "not sorted
 * either way" rather than looking for `ag-header-cell-sorted-none`, which ag-grid does not put on a
 * header until that header has been sorted once.
 */
const measureHeaderChrome = (gridRoot: HTMLElement): number | undefined => {
  const headerCell = gridRoot.querySelector<HTMLElement>(
    ".pack-table-header:not(.ag-header-cell-sorted-asc):not(.ag-header-cell-sorted-desc)",
  );
  // The text element is flex-sized to whatever the label leaves it, so the difference is the chrome.
  const headerText = headerCell?.querySelector<HTMLElement>(".ag-header-cell-text");
  if (!headerCell || !headerText) return undefined;

  const chrome = Math.ceil(headerCell.getBoundingClientRect().width - headerText.getBoundingClientRect().width);
  if (chrome < HEADER_CHROME_PLAUSIBLE_RANGE_PX.min) return undefined;
  if (chrome > HEADER_CHROME_PLAUSIBLE_RANGE_PX.max) return undefined;
  return chrome;
};

const fieldTypeToCellType = (fieldType: SCHEMA_FIELD_TYPE): "numeric" | "checkbox" | "text" => {
  switch (fieldType) {
    case "I64":
    case "F32":
    case "I32":
    case "I16":
    case "F64":
      return "numeric";
    case "Boolean":
      return "checkbox";
    default:
      return "text";
  }
};

const resolveCellValue = (cell: AmendedSchemaField): TableCellValue => {
  if (cell.type === "Boolean") {
    return cell.resolvedKeyValue !== "0";
  }
  if (cell.type === "OptionalStringU8" && cell.resolvedKeyValue === "0") {
    return "";
  }
  return cell.resolvedKeyValue;
};

const formatFloatDisplayValue = (value: TableCellValue | null | undefined): string => {
  if (typeof value !== "string") return value == null ? "" : String(value);

  const normalizedValue = value.trim();
  if (!/^-?\d+\.0+$/.test(normalizedValue)) return value;

  return normalizedValue.replace(/\.0+$/, "");
};

/**
 * A cell value reduced to the string the grid draws, so two of them can be compared. Floats go
 * through the display formatter because the schema default for one is written "0" while the stored
 * cell reads "0.0" - the same value, and the same thing on screen.
 */
const toComparableCellValue = (value: TableCellValue | null | undefined, fieldType: SCHEMA_FIELD_TYPE): string => {
  if (typeof value === "boolean") return value ? "1" : "0";
  const text = value == null ? "" : String(value);
  return fieldType === "F32" || fieldType === "F64" ? formatFloatDisplayValue(text) : text;
};

/**
 * What each column holds where nobody has set anything: exactly what Add Row would put there, since
 * both go through buildDefaultCellValue.
 */
const getColumnDefaultValues = (currentSchema: DBVersion): string[] =>
  currentSchema.fields.map((field) =>
    toComparableCellValue(
      resolveCellValue(buildDefaultCellValue(field.name, field.field_type, field.default_value ?? "", field.is_key)),
      field.field_type,
    ),
  );

/**
 * Columns where every row still holds the schema default. Most tables in a mod touch a handful of
 * columns and leave dozens untouched, and those dozens are what makes the table unreadably wide.
 *
 * Key columns are never reported, whatever they hold: they are what identifies the row, so hiding
 * one would leave the rows it names anonymous. An empty table reports nothing either - every column
 * of it is trivially all-default, and hiding the lot would leave nothing to add a row to.
 */
const findAllDefaultColumnIndexes = (
  rows: RowData[],
  currentSchema: DBVersion,
  keyColumnNamesUnderscore: string[],
): Set<number> => {
  const allDefaultColumns = new Set<number>();
  if (rows.length === 0) return allDefaultColumns;

  const columnDefaultValues = getColumnDefaultValues(currentSchema);
  const keyColumnSet = new Set(keyColumnNamesUnderscore);

  for (let colIndex = 0; colIndex < currentSchema.fields.length; colIndex++) {
    const field = currentSchema.fields[colIndex];
    if (!field || keyColumnSet.has(field.name)) continue;

    const fieldKey = getColumnFieldKey(colIndex);
    const defaultValue = columnDefaultValues[colIndex];
    const isAllDefault = rows.every((row) => toComparableCellValue(row[fieldKey], field.field_type) === defaultValue);
    if (isAllDefault) allDefaultColumns.add(colIndex);
  }

  return allDefaultColumns;
};

const NO_HIDDEN_COLUMNS: ReadonlySet<number> = new Set<number>();

const toggleButtonClass = (isActive: boolean): string =>
  "px-2 py-1 text-sm rounded border " +
  (isActive
    ? "bg-blue-700 border-blue-500 text-white hover:bg-blue-600"
    : "bg-gray-700 border-gray-600 text-gray-200 hover:bg-gray-600");

const getDisplayColumnHeader = (headerName: string): string => {
  return COLUMN_HEADER_DISPLAY_NAMES[headerName] ?? headerName;
};

/**
 * What the header alone needs, with no floor of its own.
 *
 * A floor here would apply to every column type, which is what made a checkbox column as wide as a
 * column of text. The per-type floor belongs with the content width instead.
 */
const getHeaderMinWidth = (headerName: string, hasKeyIcon: boolean, chromePx: number): number => {
  const iconWidth = hasKeyIcon ? KEY_HEADER_ICON_WIDTH_PX : 0;
  if (headerName.length === 0) return chromePx + iconWidth;

  const words = headerName.split(/\s+/).filter(Boolean);
  // The header wraps onto two lines, so it has to fit whichever is wider: its longest single word,
  // or half of the whole thing.
  const longestWordWidth = words.reduce((maxWidth, word) => {
    return Math.max(maxWidth, measureTextWidth(word, GRID_HEADER_FONT));
  }, 0);
  const fullHeaderWidth = measureTextWidth(headerName, GRID_HEADER_FONT);
  const twoLineWidth = Math.ceil(fullHeaderWidth / 2);

  return Math.ceil(Math.max(longestWordWidth, twoLineWidth) + chromePx + iconWidth);
};

const buildTableCacheKey = (
  packPath: string,
  packedFilePath: string,
  packFile: PackedFile,
  schema: DBVersion,
): string => {
  return [
    TABLE_PREP_CACHE_VERSION,
    packPath,
    packedFilePath,
    packFile.file_size,
    packFile.start_pos,
    schema.version,
    packFile.schemaFields?.length ?? 0,
  ].join("|");
};

const prepareTableData = (
  packFile: PackedFile,
  currentSchema: DBVersion,
  keyColumnNamesUnderscore: string[],
): PreparedTableData => {
  const schemaFields = (packFile.schemaFields as AmendedSchemaField[] | undefined) || [];
  const columnCount = currentSchema.fields.length;
  const rowCount = columnCount > 0 ? Math.ceil(schemaFields.length / columnCount) : 0;

  const keyColumnNames = currentSchema.fields
    .filter((field) => keyColumnNamesUnderscore.includes(field.name))
    .map((field) => field.name.replaceAll("_", " "));

  const columnHeaders = currentSchema.fields.map((field) => field.name.replaceAll("_", " "));
  const columns = currentSchema.fields.map((field) => ({ type: fieldTypeToCellType(field.field_type) }));
  const keyColumnNameSet = new Set(keyColumnNames);

  const columnFilterOptions = [...columnHeaders]
    .map((header, index) => ({ header, index }))
    .sort((first, second) => {
      const isFirstKey = keyColumnNameSet.has(first.header);
      const isSecondKey = keyColumnNameSet.has(second.header);
      if (isFirstKey === isSecondKey) return first.index - second.index;
      return isFirstKey ? -1 : 1;
    })
    .map(({ header }) => header);

  const chunkedTable: AmendedSchemaField[][] = Array.from({ length: rowCount }, () => []);
  const data: RowData[] = Array.from({ length: rowCount }, (_value, rowIndex) => ({ __rowId: String(rowIndex) }));
  const lowerCaseColumnValues: string[][] = Array.from({ length: columnCount }, () => new Array(rowCount));
  const textNonEmptyCounts = new Array(columnCount).fill(0);
  const textMaxLengths = new Array(columnCount).fill(0);
  const textWidestValues = new Array<string>(columnCount).fill("");
  const textWidestWidths = new Array<number>(columnCount).fill(0);
  const isKeyTextColumn = currentSchema.fields.map(
    (field, colIndex) => columns[colIndex]?.type === "text" && keyColumnNamesUnderscore.includes(field.name),
  );

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    for (let colIndex = 0; colIndex < columnCount; colIndex++) {
      const fieldIndex = rowIndex * columnCount + colIndex;
      const cell = schemaFields[fieldIndex];
      if (!cell) continue;

      chunkedTable[rowIndex].push(cell);
      const cellValue = resolveCellValue(cell);
      data[rowIndex][getColumnFieldKey(colIndex)] = cellValue;
      lowerCaseColumnValues[colIndex][rowIndex] = String(cell.resolvedKeyValue).toLowerCase();

      // Checkboxes are a fixed size; everything else is sized from its values.
      if (columns[colIndex]?.type === "checkbox") continue;
      const value = String(cellValue ?? "");
      if (value.length === 0) continue;

      textNonEmptyCounts[colIndex]++;
      if (isKeyTextColumn[colIndex]) {
        // A key column has to fit exactly, so it is sized off its widest value rather than its
        // longest one.
        const widest = pickWidestValue(
          { value: textWidestValues[colIndex], width: textWidestWidths[colIndex] },
          value,
          measureGridCellText,
          GRID_CELL_MAX_GLYPH_WIDTH_PX,
        );
        textWidestValues[colIndex] = widest.value;
        textWidestWidths[colIndex] = widest.width;
        textMaxLengths[colIndex] = Math.max(textMaxLengths[colIndex], value.length);
      } else if (value.length > textMaxLengths[colIndex]) {
        // Every other column goes by the longest value, which costs one measurement per column
        // rather than one per cell.
        textMaxLengths[colIndex] = value.length;
        textWidestValues[colIndex] = value;
      }
    }
  }

  const columnWidthHints: Array<ColumnWidthHint | undefined> = columns.map((column, colIndex) => {
    if (column.type === "checkbox") return undefined;

    const nonEmptyCount = textNonEmptyCounts[colIndex];
    const maxLength = textMaxLengths[colIndex];
    if (nonEmptyCount === 0 || maxLength === 0) {
      return { maxLength: 0, nonEmptyCount: 0, widestValue: "" };
    }

    return { maxLength, nonEmptyCount, widestValue: textWidestValues[colIndex] ?? "" };
  });

  return {
    chunkedTable,
    data,
    columnHeaders,
    columns,
    columnWidthHints,
    columnFilterOptions,
    keyColumnNames,
    lowerCaseColumnValues,
  };
};

const getResolvedCellLowerCase = (value: string): string => value.toLowerCase();

const getUpdatedTextColumnWidthHint = (
  preparedTableData: PreparedTableData,
  columnIndex: number,
): ColumnWidthHint | undefined => {
  if (preparedTableData.columns[columnIndex]?.type === "checkbox") return undefined;

  // Both lists hold the space-separated display name, so this is the same test prepareTableData makes.
  const isKeyTextColumn =
    preparedTableData.columns[columnIndex]?.type === "text" &&
    preparedTableData.keyColumnNames.includes(preparedTableData.columnHeaders[columnIndex] ?? "");

  let nonEmptyCount = 0;
  let widest: WidestValue = { value: "", width: 0 };
  let maxLength = 0;

  for (const row of preparedTableData.data) {
    const rawValue = row[getColumnFieldKey(columnIndex)];
    const value = rawValue == null ? "" : String(rawValue);
    if (value.length === 0) continue;
    nonEmptyCount++;
    if (isKeyTextColumn) {
      // By width rather than length, so an edited key column still fits exactly.
      widest = pickWidestValue(widest, value, measureGridCellText, GRID_CELL_MAX_GLYPH_WIDTH_PX);
      maxLength = Math.max(maxLength, value.length);
    } else if (value.length > maxLength) {
      maxLength = value.length;
      widest = { value, width: 0 };
    }
  }

  return { maxLength, nonEmptyCount, widestValue: widest.value };
};

const updatePreparedTableDataCell = (
  preparedTableData: PreparedTableData,
  rowIndex: number,
  colIndex: number,
  nextValue: TableCellValue,
  resolvedKeyValue: string,
): PreparedTableData => {
  const nextRow = {
    ...preparedTableData.data[rowIndex],
    [getColumnFieldKey(colIndex)]: nextValue,
  };
  const nextData = [...preparedTableData.data];
  nextData[rowIndex] = nextRow;

  const nextChunkedRow = [...preparedTableData.chunkedTable[rowIndex]];
  const previousCell = nextChunkedRow[colIndex];
  if (previousCell) {
    nextChunkedRow[colIndex] = {
      ...previousCell,
      resolvedKeyValue,
    };
  }
  const nextChunkedTable = [...preparedTableData.chunkedTable];
  nextChunkedTable[rowIndex] = nextChunkedRow;

  const nextLowerCaseColumn = [...(preparedTableData.lowerCaseColumnValues[colIndex] || [])];
  nextLowerCaseColumn[rowIndex] = getResolvedCellLowerCase(resolvedKeyValue);
  const nextLowerCaseColumnValues = [...preparedTableData.lowerCaseColumnValues];
  nextLowerCaseColumnValues[colIndex] = nextLowerCaseColumn;

  const nextColumnWidthHints = [...preparedTableData.columnWidthHints];
  nextColumnWidthHints[colIndex] = getUpdatedTextColumnWidthHint(
    {
      ...preparedTableData,
      data: nextData,
      chunkedTable: nextChunkedTable,
      lowerCaseColumnValues: nextLowerCaseColumnValues,
    },
    colIndex,
  );

  return {
    ...preparedTableData,
    data: nextData,
    chunkedTable: nextChunkedTable,
    lowerCaseColumnValues: nextLowerCaseColumnValues,
    columnWidthHints: nextColumnWidthHints,
  };
};

const appendPreparedTableDataRow = (
  preparedTableData: PreparedTableData,
  appendedRowFields: AmendedSchemaField[],
): PreparedTableData => {
  const nextRowIndex = preparedTableData.data.length;
  const nextRow: RowData = { __rowId: String(nextRowIndex) };
  appendedRowFields.forEach((cell, colIndex) => {
    nextRow[getColumnFieldKey(colIndex)] = resolveCellValue(cell);
  });

  const nextData = [...preparedTableData.data, nextRow];
  const nextChunkedTable = [...preparedTableData.chunkedTable, appendedRowFields];
  const nextLowerCaseColumnValues = preparedTableData.lowerCaseColumnValues.map((columnValues, colIndex) => [
    ...columnValues,
    getResolvedCellLowerCase(appendedRowFields[colIndex]?.resolvedKeyValue ?? ""),
  ]);
  const nextPreparedTableData = {
    ...preparedTableData,
    data: nextData,
    chunkedTable: nextChunkedTable,
    lowerCaseColumnValues: nextLowerCaseColumnValues,
  };
  const nextColumnWidthHints = preparedTableData.columnWidthHints.map((_hint, colIndex) =>
    getUpdatedTextColumnWidthHint(nextPreparedTableData, colIndex),
  );

  return {
    ...nextPreparedTableData,
    columnWidthHints: nextColumnWidthHints,
  };
};

const copyTextToClipboard = async (text: string): Promise<void> => {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Fallback for environments where `navigator.clipboard` is unavailable/blocked.
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "true");
    el.style.position = "fixed";
    el.style.top = "0";
    el.style.left = "0";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.focus();
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
  }
};

const normalizeSelectionRange = (
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): SelectionRange => ({
  startRow: Math.min(startRow, endRow),
  endRow: Math.max(startRow, endRow),
  startCol: Math.min(startCol, endCol),
  endCol: Math.max(startCol, endCol),
});

const appendSelectionRange = (ranges: SelectionRange[], nextRange: SelectionRange): SelectionRange[] => {
  const normalizedRange = normalizeSelectionRange(
    nextRange.startRow,
    nextRange.startCol,
    nextRange.endRow,
    nextRange.endCol,
  );
  const alreadyPresent = ranges.some(
    (range) =>
      range.startRow === normalizedRange.startRow &&
      range.endRow === normalizedRange.endRow &&
      range.startCol === normalizedRange.startCol &&
      range.endCol === normalizedRange.endCol,
  );

  return alreadyPresent ? ranges : [...ranges, normalizedRange];
};

const filterFullColumnSelections = (ranges: SelectionRange[], rowCount: number): SelectionRange[] => {
  if (rowCount <= 0) return [];
  return ranges.filter((range) => range.startRow === 0 && range.endRow === rowCount - 1);
};

const hasAdditiveSelectionModifier = (event?: Pick<MouseEvent, "shiftKey" | "ctrlKey" | "metaKey"> | null): boolean =>
  !!event && (event.shiftKey || event.ctrlKey || event.metaKey);

/**
 * Scrolling the table sideways from outside ag-grid. The centre viewport is the one that actually
 * moves; the fake scrollbar under it is mirrored so the scrollbar thumb keeps up, which is the same
 * pair the drag-selection auto-scroll drives.
 */
const scrollGridHorizontally = (gridRoot: HTMLElement, delta: number): void => {
  const centerViewport = gridRoot.querySelector<HTMLElement>(".ag-center-cols-viewport");
  if (!centerViewport || delta === 0) return;

  const maxScrollLeft = Math.max(0, centerViewport.scrollWidth - centerViewport.clientWidth);
  const nextScrollLeft = Math.min(maxScrollLeft, Math.max(0, centerViewport.scrollLeft + delta));
  if (nextScrollLeft === centerViewport.scrollLeft) return;

  centerViewport.scrollLeft = nextScrollLeft;
  const horizontalViewport = gridRoot.querySelector<HTMLElement>(".ag-body-horizontal-scroll-viewport");
  if (horizontalViewport) horizontalViewport.scrollLeft = nextScrollLeft;
};

const scrollGridVertically = (gridRoot: HTMLElement, delta: number): void => {
  const bodyViewport = gridRoot.querySelector<HTMLElement>(".ag-body-viewport");
  if (!bodyViewport || delta === 0) return;

  const maxScrollTop = Math.max(0, bodyViewport.scrollHeight - bodyViewport.clientHeight);
  const nextScrollTop = Math.min(maxScrollTop, Math.max(0, bodyViewport.scrollTop + delta));
  if (nextScrollTop !== bodyViewport.scrollTop) bodyViewport.scrollTop = nextScrollTop;
};

/** One frame of middle-button auto-scroll: still inside the dead zone, or faster the further out. */
const getMiddleAutoScrollStep = (distance: number): number => {
  const magnitude = Math.abs(distance) - MIDDLE_AUTO_SCROLL_DEAD_ZONE_PX;
  if (magnitude <= 0) return 0;

  const step = Math.min(MIDDLE_AUTO_SCROLL_MAX_STEP_PX, magnitude * MIDDLE_AUTO_SCROLL_SPEED);
  return distance < 0 ? -step : step;
};

const getAutoScrollDelta = (pointer: number, start: number, end: number): number => {
  const distanceToStart = pointer - start;
  if (distanceToStart < SELECTION_AUTO_SCROLL_EDGE_PX) {
    const intensity = (SELECTION_AUTO_SCROLL_EDGE_PX - distanceToStart) / SELECTION_AUTO_SCROLL_EDGE_PX;
    return -Math.ceil(SELECTION_AUTO_SCROLL_MAX_STEP_PX * Math.min(Math.max(intensity, 0), 1));
  }

  const distanceToEnd = end - pointer;
  if (distanceToEnd < SELECTION_AUTO_SCROLL_EDGE_PX) {
    const intensity = (SELECTION_AUTO_SCROLL_EDGE_PX - distanceToEnd) / SELECTION_AUTO_SCROLL_EDGE_PX;
    return Math.ceil(SELECTION_AUTO_SCROLL_MAX_STEP_PX * Math.min(Math.max(intensity, 0), 1));
  }

  return 0;
};

const AgGridWrapper = memo(
  ({
    rowData,
    columns,
    columnHeaders,
    columnWidthHints,
    canEditTable,
    canDeepCloneTable,
    onCellValueChangedCallback,
    onContextMenuCallback,
    onCopyRowsInto,
    otherOpenPacks,
    showDialog,
    sourcePackPath,
    keyColumnNamesUnderscore,
    currentSchema,
    isBigTable,
    rowCount,
    tableSelectionKey,
    hiddenColumnIndexes,
    pinFirstKeyColumn,
  }: {
    rowData: RowData[];
    columns: Array<{ type: "numeric" | "checkbox" | "text" }>;
    columnHeaders: string[];
    columnWidthHints: Array<ColumnWidthHint | undefined>;
    canEditTable: boolean;
    canDeepCloneTable: boolean;
    onCellValueChangedCallback: (event: CellValueChangedEvent<RowData>) => void;
    onContextMenuCallback: (row: number, col: number) => void;
    onCopyRowsInto?: (displayedRows: number[], targetPackPath: string, openAfterCopy: boolean) => void | Promise<void>;
    otherOpenPacks?: ViewerPackTarget[];
    showDialog: ShowViewerDialog;
    sourcePackPath: string;
    keyColumnNamesUnderscore: string[];
    currentSchema: DBVersion;
    isBigTable: boolean;
    rowCount: number;
    tableSelectionKey: string;
    hiddenColumnIndexes: ReadonlySet<number>;
    pinFirstKeyColumn: boolean;
  }) => {
    const keyColumnSet = useMemo(() => new Set(keyColumnNamesUnderscore), [keyColumnNamesUnderscore]);
    const gridRef = useRef<AgGridReact<RowData>>(null);
    const gridRootRef = useRef<HTMLDivElement | null>(null);
    const [selectionRanges, setSelectionRanges] = useState<SelectionRange[]>([]);
    const selectionRangesRef = useRef<SelectionRange[]>([]);
    const dragSelectionRef = useRef<DragSelectionState | null>(null);
    const dragPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
    const autoScrollFrameRef = useRef<number | null>(null);
    const middleAutoScrollRef = useRef<{
      anchorX: number;
      anchorY: number;
      pointerX: number;
      pointerY: number;
      startedAt: number;
      hasDragged: boolean;
      frame: number;
    } | null>(null);
    const [middleAutoScrollAnchor, setMiddleAutoScrollAnchor] = useState<{
      clientX: number;
      clientY: number;
    } | null>(null);

    const [headerChromePx, setHeaderChromePx] = useState(measuredHeaderChromePx ?? HEADER_CHROME_FALLBACK_PX);

    // Read the real header chrome off the grid once it has been laid out, and size columns from that
    // instead of a constant. Two frames because the first one can land before ag-grid has drawn the
    // header, and the measurement is cached, so this settles on the first table opened.
    useEffect(() => {
      if (measuredHeaderChromePx != null) return;

      let secondFrame = 0;
      const firstFrame = requestAnimationFrame(() => {
        secondFrame = requestAnimationFrame(() => {
          const gridRoot = gridRootRef.current;
          if (!gridRoot) return;

          const measured = measureHeaderChrome(gridRoot);
          if (measured == null) return;
          measuredHeaderChromePx = measured;
          setHeaderChromePx(measured);
        });
      });

      return () => {
        cancelAnimationFrame(firstFrame);
        cancelAnimationFrame(secondFrame);
      };
    }, []);

    /**
     * Horizontal wheel over a pinned column. ag-grid gives the pinned sections their own viewports
     * and only the centre one scrolls sideways, so with the mouse over the pinned columns a
     * horizontal wheel - or shift+wheel, which Chromium reports as one - is swallowed and the table
     * looks stuck. The pinned section is the left edge of the grid, which is exactly where a hand
     * ends up, so this is the common case rather than an edge one.
     *
     * Registered natively because React makes wheel listeners passive, and this one has to
     * preventDefault to stop the scroll going to the page instead.
     */
    useEffect(() => {
      const gridRoot = gridRootRef.current;
      if (!gridRoot) return;

      const onWheel = (event: WheelEvent) => {
        const delta = event.deltaX !== 0 ? event.deltaX : event.shiftKey ? event.deltaY : 0;
        if (delta === 0) return;

        const target = event.target as Element | null;
        if (!target?.closest(".ag-pinned-left-cols-container, .ag-pinned-right-cols-container")) return;

        scrollGridHorizontally(gridRoot, delta);
        event.preventDefault();
      };

      gridRoot.addEventListener("wheel", onWheel, { passive: false });
      return () => gridRoot.removeEventListener("wheel", onWheel);
    }, []);

    const stopMiddleAutoScroll = useCallback(() => {
      const autoScroll = middleAutoScrollRef.current;
      if (!autoScroll) return;

      if (autoScroll.frame !== 0) cancelAnimationFrame(autoScroll.frame);
      middleAutoScrollRef.current = null;
      setMiddleAutoScrollAnchor(null);
    }, []);

    /**
     * Middle-button auto-scroll, taken over for the whole grid body.
     *
     * ag-grid splits the two axes across two elements - `.ag-body-viewport` scrolls vertically and
     * wraps everything, `.ag-center-cols-viewport` scrolls horizontally and wraps only the unpinned
     * columns - while the browser's auto-scroll latches onto a single scroller for the whole
     * gesture, whichever one first matched the direction the pointer moved. Neither of them scrolls
     * both ways, so the gesture ends up locked to the axis it started on; and over a pinned column,
     * where the horizontal scroller is not even an ancestor, sideways does nothing at all.
     *
     * Driving both axes ourselves is what unlocks the diagonal. It is modelled on what the browser
     * does so it does not feel like a different gesture: the table moves faster the further the
     * pointer is from where the button went down, a release after an actual drag ends it, and a
     * release without one leaves it running until the next click or Esc. The anchor marker stands
     * in for the one the browser would have drawn.
     */
    const startMiddleAutoScroll = useCallback(
      (event: React.MouseEvent<HTMLDivElement>): boolean => {
        const gridRoot = gridRootRef.current;
        if (!gridRoot) return false;

        // Already running: a second press ends it rather than re-anchoring, as it would in the browser.
        if (middleAutoScrollRef.current) {
          event.preventDefault();
          stopMiddleAutoScroll();
          return true;
        }

        // The rows, pinned and unpinned alike. Not the header, which has nothing to scroll to.
        if (!(event.target as Element | null)?.closest(".ag-body-viewport")) return false;

        // Without this the browser starts its own, axis-locked auto-scroll on top of ours.
        event.preventDefault();

        const autoScroll = {
          anchorX: event.clientX,
          anchorY: event.clientY,
          pointerX: event.clientX,
          pointerY: event.clientY,
          startedAt: event.nativeEvent.timeStamp,
          hasDragged: false,
          frame: 0,
        };

        const runFrame = () => {
          if (middleAutoScrollRef.current !== autoScroll) return;

          scrollGridHorizontally(gridRoot, getMiddleAutoScrollStep(autoScroll.pointerX - autoScroll.anchorX));
          scrollGridVertically(gridRoot, getMiddleAutoScrollStep(autoScroll.pointerY - autoScroll.anchorY));
          autoScroll.frame = requestAnimationFrame(runFrame);
        };

        middleAutoScrollRef.current = autoScroll;
        setMiddleAutoScrollAnchor({ clientX: event.clientX, clientY: event.clientY });
        autoScroll.frame = requestAnimationFrame(runFrame);
        return true;
      },
      [stopMiddleAutoScroll],
    );

    useEffect(() => {
      const onWindowMouseMove = (event: MouseEvent) => {
        const autoScroll = middleAutoScrollRef.current;
        if (!autoScroll) return;

        autoScroll.pointerX = event.clientX;
        autoScroll.pointerY = event.clientY;
        if (
          Math.abs(event.clientX - autoScroll.anchorX) > MIDDLE_AUTO_SCROLL_DRAG_THRESHOLD_PX ||
          Math.abs(event.clientY - autoScroll.anchorY) > MIDDLE_AUTO_SCROLL_DRAG_THRESHOLD_PX
        ) {
          autoScroll.hasDragged = true;
        }
      };

      const onWindowMouseUp = () => {
        // A release that ends a drag stops it; a release that ends a plain click does not, which is
        // the browser's own rule.
        if (middleAutoScrollRef.current?.hasDragged) stopMiddleAutoScroll();
      };

      const onWindowMouseDown = (event: MouseEvent) => {
        // Not the press that started it: that one is still propagating when this listener is added.
        if (middleAutoScrollRef.current && event.timeStamp !== middleAutoScrollRef.current.startedAt) {
          stopMiddleAutoScroll();
        }
      };

      const onWindowKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") stopMiddleAutoScroll();
      };

      window.addEventListener("mousemove", onWindowMouseMove);
      window.addEventListener("mouseup", onWindowMouseUp);
      window.addEventListener("mousedown", onWindowMouseDown);
      window.addEventListener("keydown", onWindowKeyDown);
      window.addEventListener("blur", stopMiddleAutoScroll);

      return () => {
        window.removeEventListener("mousemove", onWindowMouseMove);
        window.removeEventListener("mouseup", onWindowMouseUp);
        window.removeEventListener("mousedown", onWindowMouseDown);
        window.removeEventListener("keydown", onWindowKeyDown);
        window.removeEventListener("blur", stopMiddleAutoScroll);
        stopMiddleAutoScroll();
      };
    }, [stopMiddleAutoScroll]);

    // Only the row height still varies with table size; column widths come from the contents either
    // way now.
    const isDenseTable = isBigTable || rowCount >= FIXED_SIZING_ROW_THRESHOLD;
    const rowHeight = isDenseTable ? BIG_TABLE_ROW_HEIGHT : NORMAL_TABLE_ROW_HEIGHT;
    const rowIndexColumnWidth = useMemo(() => {
      const maxRowNumberWidth = measureTextWidth(String(Math.max(rowCount, 1)), ROW_INDEX_GRID_CELL_FONT);
      return Math.max(ROW_INDEX_COLUMN_MIN_WIDTH, Math.ceil(maxRowNumberWidth + ROW_INDEX_COLUMN_PADDING_PX));
    }, [rowCount]);

    const columnDefaultValues = useMemo(() => getColumnDefaultValues(currentSchema), [currentSchema]);

    const firstKeyColumnIndex = useMemo(() => {
      if (keyColumnSet.size === 0) return -1;
      return currentSchema.fields.findIndex((field) => keyColumnSet.has(field.name));
    }, [currentSchema.fields, keyColumnSet]);

    /**
     * What the column's values need. The header is not considered here - getHeaderMinWidth covers
     * it, and it knows the header wraps onto two lines, so folding the unwrapped header width in
     * here as well would size every column for a header that is never drawn on one line.
     */
    const getContentWidth = useCallback(
      (columnIndex: number) => {
        const widestValue = columnWidthHints[columnIndex]?.widestValue ?? "";
        if (widestValue.length === 0) return 0;
        return Math.ceil(measureTextWidth(widestValue, GRID_CELL_FONT) + CELL_CONTENT_PADDING_PX);
      },
      [columnWidthHints],
    );

    const getColumnWidth = useCallback(
      (columnIndex: number) => {
        const columnType = columns[columnIndex]?.type;
        // A checkbox is the same size whatever the value, so its content width is a constant.
        if (columnType === "checkbox") return BIG_TABLE_CHECKBOX_COL_WIDTH;
        if (columnType === "numeric") {
          return Math.max(NUMERIC_COLUMN_MIN_WIDTH_PX, getContentWidth(columnIndex));
        }
        return Math.max(TEXT_COLUMN_WIDTH_MIN_PX, getContentWidth(columnIndex));
      },
      [columns, getContentWidth],
    );

    const defaultColDef = useMemo<ColDef<RowData>>(
      () => ({
        editable: canEditTable,
        sortable: true,
        filter: true,
        resizable: true,
        suppressHeaderMenuButton: true,
        suppressMovable: true,
        // autoHeaderHeight: true,
        // wrapHeaderText: true,
      }),
      [canEditTable],
    );

    const isCellSelected = useCallback((rowIndex: number, colIndex: number) => {
      return selectionRangesRef.current.some(
        (range) =>
          rowIndex >= range.startRow &&
          rowIndex <= range.endRow &&
          colIndex >= range.startCol &&
          colIndex <= range.endCol,
      );
    }, []);

    const isRowSelected = useCallback(
      (rowIndex: number) => {
        const lastColumnIndex = currentSchema.fields.length - 1;
        if (lastColumnIndex < 0) return false;

        return selectionRangesRef.current.some(
          (range) =>
            rowIndex >= range.startRow &&
            rowIndex <= range.endRow &&
            range.startCol === 0 &&
            range.endCol === lastColumnIndex,
        );
      },
      [currentSchema.fields.length],
    );

    const selectedColumnSignature = useMemo(() => {
      if (rowCount <= 0) return "";

      const selectedColumns = new Set<number>();
      for (const range of selectionRanges) {
        if (range.startRow !== 0 || range.endRow !== rowCount - 1) continue;
        for (let colIndex = range.startCol; colIndex <= range.endCol; colIndex++) {
          selectedColumns.add(colIndex);
        }
      }

      return Array.from(selectedColumns)
        .sort((a, b) => a - b)
        .join(",");
    }, [rowCount, selectionRanges]);

    const columnDefs = useMemo<Array<ColDef<RowData>>>(() => {
      const defs: Array<ColDef<RowData>> = [
        {
          headerName: "",
          colId: "__rowIndex",
          editable: false,
          width: rowIndexColumnWidth,
          minWidth: rowIndexColumnWidth,
          resizable: false,
          pinned: "left",
          sortable: false,
          filter: false,
          suppressMovable: true,
          valueGetter: (p) => (typeof p.node?.rowIndex === "number" ? p.node.rowIndex + 1 : ""),
          cellClass: (p) => {
            const rowIndex = p.node?.rowIndex;
            const classes = ["pack-table-row-index-cell", "text-right", "tabular-nums"];
            if (typeof rowIndex === "number" && isRowSelected(rowIndex)) {
              classes.push("pack-table-row-index-selected");
            }
            return classes;
          },
        },
      ];

      for (let colIndex = 0; colIndex < currentSchema.fields.length; colIndex++) {
        const field = currentSchema.fields[colIndex];
        const colType = columns[colIndex]?.type;
        const isFloatColumn = field?.field_type === "F32" || field?.field_type === "F64";
        const isKey = !!field && keyColumnSet.has(field.name);
        const fullHeaderName = columnHeaders[colIndex] ?? "";
        const displayHeaderName = getDisplayColumnHeader(fullHeaderName);
        const headerName = (isKey ? "🔑 " : "") + displayHeaderName;

        const width = Math.max(getColumnWidth(colIndex), getHeaderMinWidth(displayHeaderName, isKey, headerChromePx));
        const columnDefaultValue = columnDefaultValues[colIndex];
        defs.push({
          headerName,
          headerTooltip: fullHeaderName,
          hide: hiddenColumnIndexes.has(colIndex),
          // Beside the row number, so a row keeps its name however far right the table is scrolled.
          //
          // `null` rather than `undefined` for the unpinned case: on a column definition update
          // ag-grid only re-applies `pinned` when it is not undefined (updateSomeColumnState),
          // so leaving it off the def keeps whatever pinning the column already had - which made
          // the toggle a one-way trip.
          pinned: pinFirstKeyColumn && colIndex === firstKeyColumnIndex ? "left" : null,
          autoHeaderHeight: true,
          wrapHeaderText: true,
          headerClass: colType === "numeric" ? "pack-table-header pack-table-header-right" : "pack-table-header",
          colId: String(colIndex),
          cellDataType: colType === "checkbox" ? "boolean" : undefined,
          editable: canEditTable,
          // Sized to its contents, never stretched to fill the window. Text columns used to take a
          // flex share of the leftover space, which on a two-column table made one column as wide as
          // the window with its values stranded at the far left of it.
          width,
          cellRenderer: colType === "checkbox" ? "agCheckboxCellRenderer" : undefined,
          cellEditor: colType === "checkbox" ? "agCheckboxCellEditor" : undefined,
          field: getColumnFieldKey(colIndex),
          valueFormatter: isFloatColumn ? (p) => formatFloatDisplayValue(p.value) : undefined,
          cellStyle:
            colType === "checkbox"
              ? {
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }
              : undefined,
          cellClass: (p) => {
            const rowIndex = p.node?.rowIndex;
            const classes: string[] = [];
            if (colType === "numeric") classes.push("text-right", "tabular-nums");
            if (colType === "checkbox") classes.push("text-center");
            // Untouched cells are most of a dense table and none of what the reader is looking for,
            // so they are dimmed to let the values somebody actually set carry the eye.
            if (field && toComparableCellValue(p.value, field.field_type) === columnDefaultValue) {
              classes.push("pack-table-cell-default");
            }
            if (typeof rowIndex === "number" && isCellSelected(rowIndex, colIndex)) {
              classes.push("pack-table-cell-selected");
            }
            return classes;
          },
        });
      }

      return defs;
    }, [
      columnHeaders,
      columns,
      currentSchema.fields,
      getColumnWidth,
      headerChromePx,
      canEditTable,
      keyColumnSet,
      rowIndexColumnWidth,
      isCellSelected,
      isRowSelected,
      columnDefaultValues,
      firstKeyColumnIndex,
      hiddenColumnIndexes,
      pinFirstKeyColumn,
    ]);

    const [menuState, setMenuState] = useState<
      | {
          clientX: number;
          clientY: number;
          row: number;
          col: number;
          label?: string;
          copyRows: number[];
        }
      | undefined
    >(undefined);
    const menuRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
      if (!menuState) return;

      const onWindowMouseDown = (ev: MouseEvent) => {
        const target = ev.target as Node | null;
        if (target && menuRef.current && menuRef.current.contains(target)) return;
        setMenuState(undefined);
      };
      const onWindowKeyDown = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") setMenuState(undefined);
      };
      window.addEventListener("mousedown", onWindowMouseDown);
      window.addEventListener("keydown", onWindowKeyDown);
      return () => {
        window.removeEventListener("mousedown", onWindowMouseDown);
        window.removeEventListener("keydown", onWindowKeyDown);
      };
    }, [menuState]);

    useEffect(() => {
      selectionRangesRef.current = selectionRanges;
      const api = gridRef.current?.api;
      if (!api) return;
      api.refreshCells({ force: true });
    }, [selectionRanges]);

    useEffect(() => {
      const root = gridRootRef.current;
      if (!root) return;

      const selectedColumnIds = new Set(selectedColumnSignature === "" ? [] : selectedColumnSignature.split(","));
      const headerCells = root.querySelectorAll(".ag-header-cell[col-id]");
      headerCells.forEach((headerCell) => {
        const rawColId = headerCell.getAttribute("col-id") ?? "";
        const isSelected = rawColId !== "__rowIndex" && selectedColumnIds.has(rawColId);
        headerCell.classList.toggle("pack-table-header-selected", isSelected);
      });
    }, [selectedColumnSignature]);

    useEffect(() => {
      dragSelectionRef.current = null;
      dragPointerRef.current = null;
      if (autoScrollFrameRef.current != null) {
        window.cancelAnimationFrame(autoScrollFrameRef.current);
        autoScrollFrameRef.current = null;
      }
      setSelectionRanges([]);
    }, [tableSelectionKey]);

    useEffect(() => {
      const onWindowMouseUp = () => {
        dragSelectionRef.current = null;
        dragPointerRef.current = null;
        if (autoScrollFrameRef.current != null) {
          window.cancelAnimationFrame(autoScrollFrameRef.current);
          autoScrollFrameRef.current = null;
        }
      };

      window.addEventListener("mouseup", onWindowMouseUp);
      return () => {
        window.removeEventListener("mouseup", onWindowMouseUp);
      };
    }, []);

    const updateDragSelection = useCallback(
      (rowIndex: number, colIndex: number) => {
        const dragSelection = dragSelectionRef.current;
        if (!dragSelection) return;
        if (rowIndex < 0 || currentSchema.fields.length === 0) return;

        const nextRange =
          dragSelection.mode === "row"
            ? normalizeSelectionRange(dragSelection.anchorRow, 0, rowIndex, currentSchema.fields.length - 1)
            : normalizeSelectionRange(dragSelection.anchorRow, dragSelection.anchorCol, rowIndex, colIndex);

        setSelectionRanges(appendSelectionRange(dragSelection.baseRanges, nextRange));
      },
      [currentSchema.fields.length],
    );

    const updateDragSelectionFromPoint = useCallback(
      (clientX: number, clientY: number) => {
        const target = document.elementFromPoint(clientX, clientY);
        if (!(target instanceof Element)) return;

        const cellElement = target.closest(".ag-cell[col-id]");
        if (!(cellElement instanceof HTMLElement)) return;

        const rowElement = cellElement.closest(".ag-row[row-index]");
        if (!(rowElement instanceof HTMLElement)) return;

        const rowIndex = Number(rowElement.getAttribute("row-index"));
        if (!Number.isFinite(rowIndex) || rowIndex < 0) return;

        const rawColId = cellElement.getAttribute("col-id") ?? "";
        const colIndex = rawColId === "__rowIndex" ? 0 : Number(rawColId);
        if (!Number.isFinite(colIndex) || colIndex < 0) return;

        updateDragSelection(rowIndex, colIndex);
      },
      [updateDragSelection],
    );

    const stopAutoScroll = useCallback(() => {
      if (autoScrollFrameRef.current != null) {
        window.cancelAnimationFrame(autoScrollFrameRef.current);
        autoScrollFrameRef.current = null;
      }
    }, []);

    const runAutoScroll = useCallback(() => {
      autoScrollFrameRef.current = null;

      const dragSelection = dragSelectionRef.current;
      const pointer = dragPointerRef.current;
      const root = gridRootRef.current;
      if (!dragSelection || !pointer || !root) return;

      const bodyViewport = root.querySelector(".ag-body-viewport") as HTMLElement | null;
      const centerViewport = root.querySelector(".ag-center-cols-viewport") as HTMLElement | null;
      const horizontalViewport = root.querySelector(".ag-body-horizontal-scroll-viewport") as HTMLElement | null;
      if (!bodyViewport) return;

      const bodyRect = bodyViewport.getBoundingClientRect();
      const deltaY = getAutoScrollDelta(pointer.clientY, bodyRect.top, bodyRect.bottom);
      const deltaX = centerViewport ? getAutoScrollDelta(pointer.clientX, bodyRect.left, bodyRect.right) : 0;

      let didScroll = false;

      if (deltaY !== 0) {
        const nextScrollTop = Math.max(0, bodyViewport.scrollTop + deltaY);
        if (nextScrollTop !== bodyViewport.scrollTop) {
          bodyViewport.scrollTop = nextScrollTop;
          didScroll = true;
        }
      }

      if (deltaX !== 0 && centerViewport) {
        const maxScrollLeft = Math.max(0, centerViewport.scrollWidth - centerViewport.clientWidth);
        const nextScrollLeft = Math.min(maxScrollLeft, Math.max(0, centerViewport.scrollLeft + deltaX));
        if (nextScrollLeft !== centerViewport.scrollLeft) {
          centerViewport.scrollLeft = nextScrollLeft;
          if (horizontalViewport) {
            horizontalViewport.scrollLeft = nextScrollLeft;
          }
          didScroll = true;
        }
      }

      if (didScroll) {
        updateDragSelectionFromPoint(pointer.clientX, pointer.clientY);
      }

      autoScrollFrameRef.current = window.requestAnimationFrame(runAutoScroll);
    }, [updateDragSelectionFromPoint]);

    const startAutoScroll = useCallback(() => {
      if (autoScrollFrameRef.current != null) return;
      autoScrollFrameRef.current = window.requestAnimationFrame(runAutoScroll);
    }, [runAutoScroll]);

    useEffect(() => {
      const onWindowMouseMove = (event: MouseEvent) => {
        if (!dragSelectionRef.current) return;

        if ((event.buttons & 1) !== 1) {
          dragSelectionRef.current = null;
          dragPointerRef.current = null;
          stopAutoScroll();
          return;
        }

        dragPointerRef.current = { clientX: event.clientX, clientY: event.clientY };
      };

      window.addEventListener("mousemove", onWindowMouseMove);
      return () => {
        window.removeEventListener("mousemove", onWindowMouseMove);
      };
    }, [stopAutoScroll]);

    const onCellContextMenu = useCallback(
      (ev: CellContextMenuEvent<RowData>) => {
        ev.event?.preventDefault();
        ev.event?.stopPropagation();

        if ((!canDeepCloneTable || keyColumnSet.size === 0) && !onCopyRowsInto) {
          setMenuState(undefined);
          return;
        }

        const displayedRowIndex = ev.node?.rowIndex;
        if (typeof displayedRowIndex !== "number" || displayedRowIndex < 0) {
          setMenuState(undefined);
          return;
        }

        const rawColId = ev.column?.getColId() ?? "";
        const clickedColIndex = rawColId === "__rowIndex" ? -1 : Number(rawColId);
        const clickedField = Number.isFinite(clickedColIndex) ? currentSchema.fields[clickedColIndex] : undefined;

        const deepCloneColIndex =
          clickedField && keyColumnSet.has(clickedField.name) ? clickedColIndex : firstKeyColumnIndex;
        const canShowDeepClone = canDeepCloneTable && keyColumnSet.size > 0 && deepCloneColIndex !== -1;
        const deepCloneValue = canShowDeepClone ? ev.data?.[getColumnFieldKey(deepCloneColIndex)] : undefined;
        const label = canShowDeepClone ? `Deep clone ${deepCloneValue ?? ""}`.trimEnd() : undefined;
        const mouse = ev.event as MouseEvent | undefined;
        setMenuState({
          clientX: mouse?.clientX ?? 0,
          clientY: mouse?.clientY ?? 0,
          row: displayedRowIndex,
          col: deepCloneColIndex === -1 ? 0 : deepCloneColIndex,
          label,
          copyRows: getSelectedRowIndices(selectionRangesRef.current, displayedRowIndex),
        });
      },
      [canDeepCloneTable, currentSchema.fields, firstKeyColumnIndex, keyColumnSet, onCopyRowsInto],
    );

    const onCellMouseDown = useCallback(
      (event: CellMouseDownEvent<RowData>) => {
        const mouseEvent = event.event as MouseEvent | null;
        if (!mouseEvent || mouseEvent.button !== 0) return;

        const rowIndex = event.node?.rowIndex;
        if (typeof rowIndex !== "number" || rowIndex < 0 || currentSchema.fields.length === 0) return;

        const colId = event.column?.getColId() ?? "";
        const isRowHeader = colId === "__rowIndex";
        const colIndex = isRowHeader ? 0 : Number(colId);
        if (!isRowHeader && (!Number.isFinite(colIndex) || colIndex < 0)) return;

        const baseRanges = hasAdditiveSelectionModifier(mouseEvent) ? selectionRangesRef.current : [];
        const nextRange = isRowHeader
          ? normalizeSelectionRange(rowIndex, 0, rowIndex, currentSchema.fields.length - 1)
          : normalizeSelectionRange(rowIndex, colIndex, rowIndex, colIndex);

        dragSelectionRef.current = {
          mode: isRowHeader ? "row" : "cells",
          anchorRow: rowIndex,
          anchorCol: isRowHeader ? 0 : colIndex,
          baseRanges,
        };
        dragPointerRef.current = { clientX: mouseEvent.clientX, clientY: mouseEvent.clientY };
        setSelectionRanges(appendSelectionRange(baseRanges, nextRange));
        startAutoScroll();

        if (isRowHeader) {
          mouseEvent.preventDefault();
        }
      },
      [currentSchema.fields, startAutoScroll],
    );

    const onCellMouseOver = useCallback(
      (event: CellMouseOverEvent<RowData>) => {
        const dragSelection = dragSelectionRef.current;
        if (!dragSelection) return;

        const mouseEvent = event.event as MouseEvent | null;
        if (!mouseEvent || (mouseEvent.buttons & 1) !== 1) {
          dragSelectionRef.current = null;
          dragPointerRef.current = null;
          stopAutoScroll();
          return;
        }

        dragPointerRef.current = { clientX: mouseEvent.clientX, clientY: mouseEvent.clientY };
        const rowIndex = event.node?.rowIndex;
        if (typeof rowIndex !== "number" || rowIndex < 0) return;

        const colId = event.column?.getColId() ?? "";
        const hoveredColIndex = colId === "__rowIndex" ? dragSelection.anchorCol : Number(colId);
        if (!Number.isFinite(hoveredColIndex) || hoveredColIndex < 0) return;

        updateDragSelection(rowIndex, hoveredColIndex);
      },
      [stopAutoScroll, updateDragSelection],
    );

    const onKeyDownCapture = useCallback(
      async (ev: React.KeyboardEvent) => {
        const isCopy = (ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === "c";
        if (!isCopy) return;

        const api = gridRef.current?.api;
        if (!api) return;

        if (selectionRangesRef.current.length > 0) {
          const rangeGroups = new Map<string, SelectionRange[]>();
          for (const range of selectionRangesRef.current) {
            const key = `${range.startRow}:${range.endRow}`;
            const existingRanges = rangeGroups.get(key);
            if (existingRanges) {
              existingRanges.push(range);
            } else {
              rangeGroups.set(key, [range]);
            }
          }

          const rangeBlocks = Array.from(rangeGroups.entries())
            .sort(([firstKey], [secondKey]) => {
              const [firstStartRow, firstEndRow] = firstKey.split(":").map(Number);
              const [secondStartRow, secondEndRow] = secondKey.split(":").map(Number);
              if (firstStartRow !== secondStartRow) return firstStartRow - secondStartRow;
              return firstEndRow - secondEndRow;
            })
            .map(([, groupedRanges]) => {
              const startRow = Math.min(...groupedRanges.map((range) => range.startRow));
              const endRow = Math.max(...groupedRanges.map((range) => range.endRow));
              const selectedColumns = new Set<number>();
              for (const range of groupedRanges) {
                for (let colIndex = range.startCol; colIndex <= range.endCol; colIndex++) {
                  selectedColumns.add(colIndex);
                }
              }

              const orderedColumns = Array.from(selectedColumns).sort((first, second) => first - second);
              if (orderedColumns.length === 0) return "";

              const lines: string[] = [];
              for (let rowIndex = startRow; rowIndex <= endRow; rowIndex++) {
                const rowNode = api.getDisplayedRowAtIndex(rowIndex);
                const row = rowNode?.data;
                if (!row) continue;

                const cells = orderedColumns.map((colIndex) => {
                  if (colIndex < 0 || colIndex >= currentSchema.fields.length) {
                    return "";
                  }
                  const value = row[getColumnFieldKey(colIndex)];
                  return value == null ? "" : String(value);
                });
                lines.push(cells.join("\t"));
              }

              return lines.join("\n");
            })
            .filter((block) => block !== "");

          if (rangeBlocks.length > 0) {
            await copyTextToClipboard(rangeBlocks.join("\n\n"));
            ev.preventDefault();
            return;
          }
        }

        const focused = api.getFocusedCell();
        if (!focused) return;

        const rowNode = api.getDisplayedRowAtIndex(focused.rowIndex);
        const row = rowNode?.data;
        if (!row) return;

        const colId = focused.column.getColId();
        if (colId === "__rowIndex") return;
        const colIndex = Number(colId);
        if (!Number.isFinite(colIndex)) return;

        const value = row[getColumnFieldKey(colIndex)];
        await copyTextToClipboard(value == null ? "" : String(value));
        ev.preventDefault();
      },
      [currentSchema.fields.length],
    );

    return (
      <div
        ref={gridRootRef}
        className="ag-theme-material-dark pack-tables-grid"
        style={{ height: "100%", width: "100%" }}
        onKeyDownCapture={onKeyDownCapture}
        onMouseDownCapture={(ev) => {
          if (ev.button === 1) {
            ev.stopPropagation();
            if (startMiddleAutoScroll(ev)) return;
          }

          if (!hasAdditiveSelectionModifier(ev) || rowCount <= 0) return;
          if ((ev.target as Element | null)?.closest(".ag-header-cell-resize")) return;
          if ((ev.target as Element | null)?.closest(".ag-header-cell-menu-button, .ag-header-cell-filter-button"))
            return;

          const headerCell = (ev.target as Element | null)?.closest(".ag-header-cell[col-id]");
          if (!(headerCell instanceof HTMLElement)) return;

          const rawColId = headerCell.getAttribute("col-id") ?? "";
          if (rawColId === "__rowIndex") return;

          const colIndex = Number(rawColId);
          if (!Number.isFinite(colIndex) || colIndex < 0) return;

          setSelectionRanges((currentRanges) =>
            appendSelectionRange(
              filterFullColumnSelections(currentRanges, rowCount),
              normalizeSelectionRange(0, colIndex, rowCount - 1, colIndex),
            ),
          );
          ev.preventDefault();
          ev.stopPropagation();
        }}
        onContextMenu={(ev) => ev.preventDefault()}
      >
        <AgGridReact<RowData>
          ref={gridRef}
          theme="legacy"
          rowData={rowData}
          getRowId={(params) => params.data.__rowId}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          rowHeight={rowHeight}
          headerHeight={rowHeight}
          animateRows={false}
          columnHoverHighlight={true}
          onCellMouseDown={onCellMouseDown}
          onCellMouseOver={onCellMouseOver}
          onCellContextMenu={onCellContextMenu}
          onCellValueChanged={onCellValueChangedCallback}
        />

        {middleAutoScrollAnchor && (
          <div
            aria-hidden="true"
            className="pack-table-autoscroll-anchor"
            style={{
              position: "fixed",
              left: middleAutoScrollAnchor.clientX,
              top: middleAutoScrollAnchor.clientY,
            }}
          >
            ↔
          </div>
        )}

        {menuState && (
          <div
            ref={menuRef}
            style={{
              position: "fixed",
              left: menuState.clientX,
              top: menuState.clientY,
              zIndex: 9999,
              minWidth: 200,
            }}
            className="rounded-md border border-gray-600 bg-gray-800 text-gray-100 shadow-lg overflow-hidden"
            onMouseDownCapture={(e) => e.stopPropagation()}
          >
            {menuState.label && (
              <button
                type="button"
                className="w-full text-left px-3 py-2 text-sm hover:bg-gray-700"
                onClick={() => {
                  onContextMenuCallback(menuState.row, menuState.col);
                  setMenuState(undefined);
                }}
              >
                {menuState.label}
              </button>
            )}
            {onCopyRowsInto && (
              <CopyIntoSubmenu
                sourcePackPath={sourcePackPath}
                otherOpenPacks={otherOpenPacks}
                showDialog={showDialog}
                label="Copy rows into"
                onSelectTarget={(targetPackPath, openAfterCopy) => {
                  const selectedRows = menuState.copyRows;
                  setMenuState(undefined);
                  void onCopyRowsInto(selectedRows, targetPackPath, openAfterCopy);
                }}
              />
            )}
          </div>
        )}
      </div>
    );
  },
);

type PackTablesTableViewProps = {
  showDialog: ShowViewerDialog;
  otherOpenPacks?: ViewerPackTarget[];
  onCopyInto?: (source: CopyIntoSource, targetPackPath: string, openAfterCopy: boolean) => void | Promise<void>;
};

const PackTablesTableView = memo(({ showDialog, otherOpenPacks, onCopyInto }: PackTablesTableViewProps) => {
  const dispatch = useAppDispatch();
  const currentDBTableSelection = useAppSelector((state) => state.app.currentDBTableSelection);
  const isFeaturesForModdersEnabled = useAppSelector((state) => state.app.isFeaturesForModdersEnabled);
  const startArgs = useAppSelector((state) => state.app.startArgs);

  const [keyFilter, setKeyFilter] = useState<string>("");
  const [pinFirstKeyColumn, setPinFirstKeyColumn] = useState(false);
  const [hideDefaultColumns, setHideDefaultColumns] = useState(true);
  const [tableFilterInput, setTableFilterInput] = useState<string>("");
  const [tableFilter, setTableFilter] = useState<string>("");
  const selectCurrentPackData = useMemo(makeSelectCurrentPackData, []);
  const selectCurrentPackUnsavedFiles = useMemo(makeSelectCurrentPackUnsavedFiles, []);

  const setTableFilterDebounced = useMemo(
    () =>
      debounce((value: string) => {
        setTableFilter(value.toLowerCase());
      }, 250),
    [],
  );

  useEffect(() => {
    return () => {
      (setTableFilterDebounced as unknown as { cancel?: () => void }).cancel?.();
    };
  }, [setTableFilterDebounced]);

  useEffect(() => {
    if (!startArgs.includes("-testDBClone")) return;

    const autoDispatchTimer = setTimeout(() => {
      dispatch(setDeepCloneTarget({ row: 3, col: 14 }));
    }, 2000);

    return () => {
      clearTimeout(autoDispatchTimer);
    };
  }, [dispatch, startArgs]);

  const packPath = currentDBTableSelection?.packPath ?? "";
  const packData = useAppSelector((state) => selectCurrentPackData(state, packPath));
  const unsavedFiles = useAppSelector((state) => selectCurrentPackUnsavedFiles(state, packPath));

  const packedFilePath = useMemo(() => {
    if (!currentDBTableSelection) return "";
    return getDBPackedFilePath(currentDBTableSelection);
  }, [currentDBTableSelection]);

  const selectedPackFile = useMemo(() => {
    if (!packedFilePath) return undefined;

    const unsavedDirectMatch = unsavedFiles.find((file) => file.name === packedFilePath);
    if (unsavedDirectMatch) return unsavedDirectMatch;

    const unsavedPrefixMatch = unsavedFiles.find((file) => file.name.startsWith(packedFilePath));
    if (unsavedPrefixMatch) return unsavedPrefixMatch;

    if (!packData || !packData.packedFiles) return undefined;

    const directMatch = packData.packedFiles[packedFilePath];
    if (directMatch) return directMatch;

    for (const [iterPackedFilePath, iterPackedFile] of Object.entries(packData.packedFiles)) {
      if (iterPackedFilePath.startsWith(packedFilePath)) {
        return iterPackedFile;
      }
    }

    return undefined;
  }, [packData, packedFilePath, unsavedFiles]);

  const [workingPackFile, setWorkingPackFile] = useState<PackedFile | undefined>(undefined);
  const keyColumnNamesUnderscore = useMemo(() => {
    if (!currentDBTableSelection) return [];
    return dataFromBackend.referencedColums[currentDBTableSelection.dbName] || [];
  }, [currentDBTableSelection]);

  const currentSchema = selectedPackFile?.tableSchema;
  const packName = getPackNameFromPath(packPath) ?? packPath;
  const canEditTable = isFeaturesForModdersEnabled && !vanillaPackNames.includes(packName);
  const openedTableKey = packedFilePath ? `${packPath}|${packedFilePath}` : "";

  const tableCacheKey = useMemo(() => {
    if (!selectedPackFile || !currentSchema || !packedFilePath || !packPath) return "";
    return buildTableCacheKey(packPath, packedFilePath, selectedPackFile, currentSchema);
  }, [packPath, packedFilePath, selectedPackFile, currentSchema]);

  const preparedTableData = useMemo(() => {
    if (!selectedPackFile || !currentSchema || !tableCacheKey) return undefined;

    const cached = getPreparedTable(tableCacheKey);
    if (cached) return cached;

    const prepared = prepareTableData(selectedPackFile, currentSchema, keyColumnNamesUnderscore);
    setPreparedTable(tableCacheKey, prepared);
    return prepared;
  }, [tableCacheKey, selectedPackFile, currentSchema, keyColumnNamesUnderscore]);

  const [workingPreparedTableData, setWorkingPreparedTableData] = useState<PreparedTableData | undefined>(undefined);
  const historyPastRef = useRef<PackedFile[]>([]);
  const historyFutureRef = useRef<PackedFile[]>([]);
  const hydratedTableKeyRef = useRef<string | null>(null);
  const [historySize, setHistorySize] = useState({ past: 0, future: 0 });

  const syncHistorySize = useCallback(() => {
    setHistorySize({
      past: historyPastRef.current.length,
      future: historyFutureRef.current.length,
    });
  }, []);

  useEffect(() => {
    if (!openedTableKey) {
      hydratedTableKeyRef.current = null;
      setWorkingPackFile(undefined);
      setWorkingPreparedTableData(undefined);
      return;
    }

    if (!selectedPackFile || !preparedTableData) return;

    const isNewTable = hydratedTableKeyRef.current !== openedTableKey;
    const isUninitialized = !workingPackFile || !workingPreparedTableData;
    if (!isNewTable && !isUninitialized) return;

    hydratedTableKeyRef.current = openedTableKey;
    setWorkingPackFile(selectedPackFile);
    setWorkingPreparedTableData(preparedTableData);
  }, [openedTableKey, preparedTableData, selectedPackFile, workingPackFile, workingPreparedTableData]);

  useEffect(() => {
    historyPastRef.current = [];
    historyFutureRef.current = [];
    setHistorySize({ past: 0, future: 0 });
  }, [openedTableKey]);

  const activePackFile = workingPackFile ?? selectedPackFile;
  const activePreparedTableData = workingPreparedTableData ?? preparedTableData;

  useEffect(() => {
    if (!activePreparedTableData || activePreparedTableData.columnFilterOptions.length === 0) return;
    if (keyFilter !== "" && activePreparedTableData.columnFilterOptions.includes(keyFilter)) return;
    setKeyFilter(activePreparedTableData.columnFilterOptions[0]);
  }, [activePreparedTableData, keyFilter]);

  const onFilterInputChange = (value: string) => {
    setTableFilterInput(value);
    setTableFilterDebounced(value);
  };

  const keyFilterOrDefault = keyFilter !== "" ? keyFilter : (activePreparedTableData?.columnFilterOptions[0] ?? "");
  const indexOfFilteredColumn = activePreparedTableData?.columnHeaders.indexOf(keyFilterOrDefault) ?? -1;
  const normalizedTableFilter = tableFilter.trim();
  const rowCount = activePreparedTableData?.data.length ?? 0;
  const colCount = activePreparedTableData?.columnHeaders.length ?? 0;
  const isBigTable = rowCount >= BIG_TABLE_ROW_THRESHOLD || rowCount * colCount >= BIG_TABLE_CELL_THRESHOLD;

  const filteredRowIndices = useMemo(() => {
    if (!activePreparedTableData) return [];
    if (indexOfFilteredColumn === -1 || normalizedTableFilter === "") {
      return activePreparedTableData.data.map((_row, rowIndex) => rowIndex);
    }

    const lowerCaseColumn = activePreparedTableData.lowerCaseColumnValues[indexOfFilteredColumn] || [];
    const filteredIndices: number[] = [];
    for (let rowIndex = 0; rowIndex < lowerCaseColumn.length; rowIndex++) {
      const value = lowerCaseColumn[rowIndex];
      if (value && value.includes(normalizedTableFilter)) {
        filteredIndices.push(rowIndex);
      }
    }

    return filteredIndices;
  }, [activePreparedTableData, indexOfFilteredColumn, normalizedTableFilter]);

  const filteredData = useMemo(() => {
    if (!activePreparedTableData) return [];
    return filteredRowIndices.map((rowIndex) => activePreparedTableData.data[rowIndex]);
  }, [activePreparedTableData, filteredRowIndices]);

  const canHideDefaultColumns = colCount > HIDE_DEFAULT_COLUMNS_MIN_COLUMN_COUNT;

  /**
   * Scanned over the whole table rather than the filtered rows: which columns are hidden should not
   * change under you as you type in the filter box. Only computed while the toggle is on and the
   * table is wide enough to offer it, since it is a pass over every cell.
   */
  const hiddenColumnIndexes = useMemo(() => {
    if (!hideDefaultColumns || !canHideDefaultColumns || !activePreparedTableData || !currentSchema) {
      return NO_HIDDEN_COLUMNS;
    }
    return findAllDefaultColumnIndexes(activePreparedTableData.data, currentSchema, keyColumnNamesUnderscore);
  }, [activePreparedTableData, canHideDefaultColumns, currentSchema, hideDefaultColumns, keyColumnNamesUnderscore]);

  /** Which columns went missing, named, so the toggle can say what it took away. */
  const hiddenColumnsTooltip = useMemo(() => {
    if (hiddenColumnIndexes.size === 0 || !activePreparedTableData) {
      return "Hide columns where every row still holds the schema default";
    }

    const hiddenNames = [...hiddenColumnIndexes]
      .sort((first, second) => first - second)
      .map((colIndex) => activePreparedTableData.columnHeaders[colIndex] ?? String(colIndex));
    const namedColumns = hiddenNames.slice(0, HIDDEN_COLUMN_TOOLTIP_LIMIT).join("\n");
    const remaining = hiddenNames.length - HIDDEN_COLUMN_TOOLTIP_LIMIT;

    return `Hidden columns:\n${namedColumns}` + (remaining > 0 ? `\n+${remaining} more` : "");
  }, [activePreparedTableData, hiddenColumnIndexes]);

  const handleContextMenuCallback = useCallback(
    (row: number, col: number) => {
      const unfilteredRowIndex = filteredRowIndices[row] ?? row;
      dispatch(setDeepCloneTarget({ row: unfilteredRowIndex, col }));
    },
    [dispatch, filteredRowIndices],
  );

  const handleCopyRowsInto = useCallback(
    (displayedRows: number[], targetPackPath: string, openAfterCopy: boolean) => {
      if (!onCopyInto || !currentDBTableSelection || !activePackFile || !currentSchema) return;

      const columnCount = currentSchema.fields.length;
      if (columnCount === 0 || !activePackFile.schemaFields) return;

      const sourceSchemaFields = activePackFile.schemaFields as AmendedSchemaField[];
      const unfilteredRows = [
        ...new Set(displayedRows.map((row) => filteredRowIndices[row]).filter((row) => row != null)),
      ];
      const rows = getRowsForCopy(sourceSchemaFields, unfilteredRows, columnCount);
      if (rows.length === 0) return;

      const source: CopyIntoSource = {
        packPath,
        filePath: activePackFile.name || packedFilePath,
        kind: "dbRows",
        dbSelection: currentDBTableSelection,
        rows,
        tableSchema: currentSchema,
        version: activePackFile.version,
      };
      void onCopyInto(source, targetPackPath, openAfterCopy);
    },
    [activePackFile, currentDBTableSelection, currentSchema, filteredRowIndices, onCopyInto, packPath, packedFilePath],
  );

  const applyPackFileLocally = useCallback(
    (nextPackFile: PackedFile, nextPreparedTableData?: PreparedTableData) => {
      const resolvedPreparedTableData =
        nextPreparedTableData ?? prepareTableData(nextPackFile, currentSchema!, keyColumnNamesUnderscore);
      clearPreparedTableForPackedFile(packPath, nextPackFile.name);
      setWorkingPackFile(nextPackFile);
      setWorkingPreparedTableData(resolvedPreparedTableData);
      return resolvedPreparedTableData;
    },
    [currentSchema, keyColumnNamesUnderscore, packPath],
  );

  const commitPackFileChange = useCallback(
    async (
      nextPackFile: PackedFile,
      previousPackFile: PackedFile,
      previousPreparedTableData: PreparedTableData,
      nextPreparedTableData?: PreparedTableData,
      historyMode: "push" | "undo" | "redo" | "none" = "push",
    ) => {
      if (!currentSchema) {
        return false;
      }

      applyPackFileLocally(nextPackFile, nextPreparedTableData);

      try {
        const result = await window.api?.saveDBTableEdits(packPath, nextPackFile);
        if (!result?.success) {
          throw new Error(result?.error || "Failed to store DB table edits");
        }

        if (historyMode === "push") {
          historyPastRef.current.push(previousPackFile);
          if (historyPastRef.current.length > 100) {
            historyPastRef.current.shift();
          }
          historyFutureRef.current = [];
          syncHistorySize();
        } else if (historyMode === "undo") {
          historyPastRef.current.pop();
          historyFutureRef.current.push(previousPackFile);
          syncHistorySize();
        } else if (historyMode === "redo") {
          historyFutureRef.current.pop();
          historyPastRef.current.push(previousPackFile);
          syncHistorySize();
        }

        return true;
      } catch (error) {
        clearPreparedTableForPackedFile(packPath, previousPackFile.name);
        setWorkingPackFile(previousPackFile);
        setWorkingPreparedTableData(previousPreparedTableData);
        showDialog(`Failed to save DB table edits: ${error instanceof Error ? error.message : "Unknown error"}`, {
          title: "Save Failed",
        });
        return false;
      }
    },
    [applyPackFileLocally, currentSchema, packPath, showDialog, syncHistorySize],
  );

  const handleCellValueChangedCallback = useCallback(
    async (event: CellValueChangedEvent<RowData>) => {
      if (!canEditTable || !activePackFile?.schemaFields || !currentSchema || !activePreparedTableData) {
        return;
      }
      if (event.newValue === event.oldValue) return;

      const displayedRowIndex = event.node?.rowIndex;
      if (typeof displayedRowIndex !== "number" || displayedRowIndex < 0) return;

      const colId = event.column?.getColId() ?? "";
      if (colId === "__rowIndex") return;

      const colIndex = Number(colId);
      if (!Number.isFinite(colIndex) || colIndex < 0) return;

      const unfilteredRowIndex = filteredRowIndices[displayedRowIndex];
      if (unfilteredRowIndex == null) return;

      const fieldDefinition = currentSchema.fields[colIndex];
      if (!fieldDefinition) return;

      const parsedCellValue = parseEditedCellValue(fieldDefinition.field_type, event.newValue);
      if (!parsedCellValue) {
        event.node?.setDataValue(colId, event.oldValue);
        return;
      }

      const previousPackFile = activePackFile;
      const previousPreparedTableData = activePreparedTableData;
      const nextSchemaFields = [...(activePackFile.schemaFields as AmendedSchemaField[])];
      const flatFieldIndex = unfilteredRowIndex * currentSchema.fields.length + colIndex;
      const previousCell = nextSchemaFields[flatFieldIndex] as AmendedSchemaField | undefined;
      if (!previousCell) {
        event.node?.setDataValue(colId, event.oldValue);
        return;
      }

      nextSchemaFields[flatFieldIndex] = {
        ...previousCell,
        fields: parsedCellValue.fields,
        resolvedKeyValue: parsedCellValue.resolvedKeyValue,
      };

      const nextPackFile = {
        ...activePackFile,
        schemaFields: nextSchemaFields,
      } as PackedFile;
      const nextPreparedTableData = updatePreparedTableDataCell(
        previousPreparedTableData,
        unfilteredRowIndex,
        colIndex,
        parsedCellValue.value,
        parsedCellValue.resolvedKeyValue,
      );
      const didSave = await commitPackFileChange(
        nextPackFile,
        previousPackFile,
        previousPreparedTableData,
        nextPreparedTableData,
        "push",
      );
      if (!didSave) {
        event.node?.setDataValue(colId, event.oldValue);
      }
    },
    [activePackFile, activePreparedTableData, canEditTable, commitPackFileChange, currentSchema, filteredRowIndices],
  );

  const handleAddRow = useCallback(async () => {
    if (!canEditTable || !activePackFile || !currentSchema || !activePreparedTableData) {
      return;
    }

    const previousPackFile = activePackFile;
    const previousPreparedTableData = activePreparedTableData;
    const appendedRowFields = buildDefaultRowSchemaFields(currentSchema);
    const nextPackFile = {
      ...activePackFile,
      schemaFields: [
        ...((activePackFile.schemaFields as AmendedSchemaField[] | undefined) || []),
        ...appendedRowFields,
      ],
    } as PackedFile;
    const nextPreparedTableData = appendPreparedTableDataRow(previousPreparedTableData, appendedRowFields);

    await commitPackFileChange(
      nextPackFile,
      previousPackFile,
      previousPreparedTableData,
      nextPreparedTableData,
      "push",
    );
  }, [activePackFile, activePreparedTableData, canEditTable, commitPackFileChange, currentSchema]);

  const handleUndo = useCallback(async () => {
    if (!canEditTable || !activePackFile || !activePreparedTableData) {
      return;
    }

    const previousSnapshot = historyPastRef.current[historyPastRef.current.length - 1];
    if (!previousSnapshot) return;

    await commitPackFileChange(previousSnapshot, activePackFile, activePreparedTableData, undefined, "undo");
  }, [activePackFile, activePreparedTableData, canEditTable, commitPackFileChange]);

  const handleRedo = useCallback(async () => {
    if (!canEditTable || !activePackFile || !activePreparedTableData) {
      return;
    }

    const nextSnapshot = historyFutureRef.current[historyFutureRef.current.length - 1];
    if (!nextSnapshot) return;

    await commitPackFileChange(nextSnapshot, activePackFile, activePreparedTableData, undefined, "redo");
  }, [activePackFile, activePreparedTableData, canEditTable, commitPackFileChange]);

  useEffect(() => {
    if (!canEditTable) return;

    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.altKey) return;

      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "input, textarea, select, [contenteditable='true'], .ag-cell-inline-editing, .ag-rich-select, .ag-popup-editor",
        )
      ) {
        return;
      }

      const key = event.key.toLowerCase();
      if (!event.shiftKey && key === "z") {
        if (historyPastRef.current.length === 0) return;
        event.preventDefault();
        void handleUndo();
        return;
      }

      if (key === "y" || (event.shiftKey && key === "z")) {
        if (historyFutureRef.current.length === 0) return;
        event.preventDefault();
        void handleRedo();
      }
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [canEditTable, handleRedo, handleUndo]);

  if (!currentDBTableSelection || !packData || !activePackFile || !currentSchema || !activePreparedTableData) {
    return <></>;
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div id="packTablesTableParent" className="flex-1 min-h-0 w-full overflow-hidden bg-gray-900">
        <AgGridWrapper
          rowData={filteredData}
          columns={activePreparedTableData.columns}
          columnHeaders={activePreparedTableData.columnHeaders}
          columnWidthHints={activePreparedTableData.columnWidthHints}
          canEditTable={canEditTable}
          canDeepCloneTable={!isDBCloneTableIgnored(currentDBTableSelection.dbName)}
          onCellValueChangedCallback={handleCellValueChangedCallback}
          onContextMenuCallback={handleContextMenuCallback}
          onCopyRowsInto={onCopyInto ? handleCopyRowsInto : undefined}
          otherOpenPacks={otherOpenPacks}
          showDialog={showDialog}
          sourcePackPath={packPath}
          keyColumnNamesUnderscore={keyColumnNamesUnderscore}
          currentSchema={currentSchema}
          isBigTable={isBigTable}
          rowCount={rowCount}
          tableSelectionKey={`${currentDBTableSelection.packPath}|${currentDBTableSelection.dbName}|${currentDBTableSelection.dbSubname}`}
          hiddenColumnIndexes={hiddenColumnIndexes}
          pinFirstKeyColumn={pinFirstKeyColumn}
        />
      </div>
      <div className="mt-3 px-2 flex gap-4 shrink-0 items-center flex-wrap">
        {canEditTable && (
          <>
            <button
              type="button"
              onClick={() => void handleAddRow()}
              className="px-3 py-2 text-sm rounded bg-blue-600 hover:bg-blue-700 text-white"
            >
              Add Row
            </button>
            <button
              type="button"
              onClick={() => void handleUndo()}
              disabled={historySize.past === 0}
              title="Undo (Ctrl/Cmd+Z)"
              className="px-3 py-2 text-sm rounded bg-gray-700 hover:bg-gray-600 text-white disabled:opacity-50 disabled:hover:bg-gray-700"
            >
              Undo
            </button>
            <button
              type="button"
              onClick={() => void handleRedo()}
              disabled={historySize.future === 0}
              title="Redo (Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z)"
              className="px-3 py-2 text-sm rounded bg-gray-700 hover:bg-gray-600 text-white disabled:opacity-50 disabled:hover:bg-gray-700"
            >
              Redo
            </button>
          </>
        )}
        <select
          value={keyFilterOrDefault}
          onChange={(e) => setKeyFilter(e.target.value)}
          className="px-2 py-1 text-sm border border-gray-300 rounded dark:border-gray-600 dark:bg-gray-700 dark:text-white"
        >
          {activePreparedTableData.columnFilterOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <input
          value={tableFilterInput}
          placeholder={"filter by selected column"}
          onChange={(e) => onFilterInputChange(e.target.value)}
          className="bg-gray-50 w-48 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block px-2 py-1 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white dark:focus:ring-blue-500 dark:focus:border-blue-500 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => setPinFirstKeyColumn((isPinned) => !isPinned)}
          aria-pressed={pinFirstKeyColumn}
          title="Keep the first key column beside the row numbers when scrolling right"
          className={toggleButtonClass(pinFirstKeyColumn)}
        >
          Pin key column
        </button>
        {canHideDefaultColumns && (
          <button
            type="button"
            onClick={() => setHideDefaultColumns((isHidden) => !isHidden)}
            aria-pressed={hideDefaultColumns}
            title={hiddenColumnsTooltip}
            className={toggleButtonClass(hideDefaultColumns)}
          >
            {hideDefaultColumns && hiddenColumnIndexes.size > 0
              ? `Empty columns hidden (${hiddenColumnIndexes.size})`
              : "Hide empty columns"}
          </button>
        )}
      </div>
    </div>
  );
});

export default PackTablesTableView;
