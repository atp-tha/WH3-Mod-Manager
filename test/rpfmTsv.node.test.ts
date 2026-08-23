import { describe, expect, it } from "vitest";

import { buildRowFromValues } from "../src/utility/dbRowCells";
import {
  buildRpfmTsvContent,
  convertRpfmTsvToPackedFile,
  formatRpfmTsvCell,
  getRpfmTsvExportPath,
} from "../src/utility/rpfmTsv";
import { LocVersion, type DBVersion } from "../src/packFileTypes";

const schema: DBVersion = {
  version: 3,
  fields: [
    {
      name: "key",
      field_type: "StringU8",
      default_value: "",
      is_key: true,
      is_filename: false,
      is_reference: [],
      description: "",
      ca_order: 0,
      is_bitwise: 0,
      enum_values: {},
    },
    {
      name: "amount",
      field_type: "I32",
      default_value: "0",
      is_key: false,
      is_filename: false,
      is_reference: [],
      description: "",
      ca_order: 0,
      is_bitwise: 0,
      enum_values: {},
    },
    {
      name: "enabled",
      field_type: "Boolean",
      default_value: "false",
      is_key: false,
      is_filename: false,
      is_reference: [],
      description: "",
      ca_order: 0,
      is_bitwise: 0,
      enum_values: {},
    },
  ],
};

describe("RPFM TSV serialization", () => {
  it("formats Boolean and empty optional-string cells", () => {
    expect(formatRpfmTsvCell("Boolean", { resolvedKeyValue: "0" })).toBe("false");
    expect(formatRpfmTsvCell("Boolean", { resolvedKeyValue: "1" })).toBe("true");
    expect(formatRpfmTsvCell("OptionalStringU8", { resolvedKeyValue: "0" })).toBe("");
    expect(formatRpfmTsvCell("StringU8", { resolvedKeyValue: "a\tb\nc" })).toBe("a b c");
  });

  it("round-trips an ordinary table with its real path", () => {
    const rows = [buildRowFromValues(schema, { key: "unit_a", amount: "17", enabled: "true" })];
    const content = buildRpfmTsvContent({
      packedFilePath: "db\\example_tables\\data__",
      tableName: "example_tables",
      version: schema.version,
      schema,
      rows,
    });

    expect(content.split("\n")[1]).toBe("#example_tables;3;db/example_tables/data__");
    const packedFile = convertRpfmTsvToPackedFile(content, "fallback.tsv", { example_tables: [schema] }, "test.tsv");
    expect(packedFile?.name).toBe("db\\example_tables\\data__");
    expect(packedFile?.schemaFields?.map((cell) => cell.fields[0]?.val)).toEqual(["unit_a".length, 17, 1]);
  });

  it("keeps unused-table paths and uses the fixed Loc schema", () => {
    const spareContent = buildRpfmTsvContent({
      packedFilePath: "unusedtables\\example_tables\\data__",
      tableName: "example_tables",
      version: 3,
      schema,
      rows: [],
    });
    expect(spareContent.split("\n")[1]).toBe("#example_tables;3;unusedtables/example_tables/data__");

    const locContent = buildRpfmTsvContent({
      packedFilePath: "text\\db\\abilities__.loc",
      tableName: "db",
      version: 99,
      schema: LocVersion,
      rows: [buildRowFromValues(LocVersion, { key: "k", text: "Text", tooltip: "false" })],
    });
    expect(locContent.split("\n")[1]).toBe("#Loc;1;text/db/abilities__.loc");
    expect(getRpfmTsvExportPath("text\\db\\abilities__.loc")).toBe("text/db/abilities__.loc.tsv");
    const packedLoc = convertRpfmTsvToPackedFile(locContent, "abilities__.loc.tsv", {}, "abilities__.loc.tsv");
    expect(packedLoc?.name).toBe("text\\db\\abilities__.loc");
    expect(packedLoc?.tableSchema).toBe(LocVersion);
  });
});
