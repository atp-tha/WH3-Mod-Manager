import { describe, expect, it } from "vitest";

import { getRowsForCopy, getSelectedRowIndices } from "../src/components/viewer/copyRows";
import type { AmendedSchemaField } from "../src/packFileTypes";

const cell = (name: string, value: string): AmendedSchemaField => ({
  name,
  type: "StringU8",
  fields: [{ type: "String", val: value }],
  resolvedKeyValue: value,
});

describe("viewer row copying", () => {
  it("uses every row touched by a multi-cell selection when the context click is inside it", () => {
    expect(
      getSelectedRowIndices(
        [
          { startRow: 3, endRow: 3, startCol: 1, endCol: 1 },
          { startRow: 1, endRow: 1, startCol: 0, endCol: 2 },
        ],
        3,
      ),
    ).toEqual([1, 3]);
  });

  it("falls back to the row under the context click outside the selection", () => {
    expect(getSelectedRowIndices([{ startRow: 1, endRow: 2, startCol: 0, endCol: 0 }], 5)).toEqual([5]);
  });

  it("copies complete schema rows even when only cells were selected", () => {
    const fields = [cell("key", "one"), cell("value", "a"), cell("key", "two"), cell("value", "b")];

    expect(getRowsForCopy(fields, [1, 0, 1], 2)).toEqual([
      [fields[0], fields[1]],
      [fields[2], fields[3]],
    ]);
  });
});
