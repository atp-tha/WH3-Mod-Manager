import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@mongodb-js/zstd", () => ({
  compress: async (value: Uint8Array) => value,
  decompress: async (value: Uint8Array) => value,
}));

import appData from "../src/appData";
import { readPack, serializePackFileDataToBuffer, writePack } from "../src/packFileSerializer";
import { convertRpfmTsvToPackedFile } from "../src/utility/rpfmTsv";
import type { DBVersion, PackedFile } from "../src/packFileTypes";
import { DBNameToDBVersions } from "../src/schema";

const temporaryFolders: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryFolders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

const field = (name: string, field_type: DBVersion["fields"][number]["field_type"], is_key = false) => ({
  name,
  field_type,
  default_value: "",
  is_key,
  is_filename: false,
  is_reference: [],
  description: "",
  ca_order: 0,
  is_bitwise: 0,
  enum_values: {},
});

const schema: DBVersion = {
  version: 3,
  fields: [field("key", "StringU8", true), field("amount", "I32"), field("enabled", "Boolean")],
};

describe("importing an RPFM TSV and saving the pack", () => {
  /**
   * Both save handlers flatten an unsaved file with `file.buffer || Buffer.from(file.text || "")`
   * and drop schemaFields, so a staged table that carries only parsed rows is written out as a
   * zero-byte file. Staging has to serialize the payload up front.
   */
  it("writes the imported table's rows, not an empty file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "whmm-import-save-"));
    temporaryFolders.push(root);
    const packPath = path.join(root, "Imported.pack");

    const previousGame = appData.currentGame;
    appData.currentGame = "wh3";
    const previousSchemas = DBNameToDBVersions.wh3.example_tables;
    DBNameToDBVersions.wh3.example_tables = [schema];
    try {
      const tsv = [
        "key\tamount\tenabled",
        "#example_tables;3;db/example_tables/data__",
        "unit_a\t17\ttrue",
        "unit_b\t4\tfalse",
      ].join("\n");

      const converted = convertRpfmTsvToPackedFile(tsv, "data__.tsv", { example_tables: [schema] }, "data__.tsv");
      expect(converted?.schemaFields).toBeTruthy();

      // What applyPackImportFromDisk stages into appData.unsavedPacksData.
      const tableBuffer = serializePackFileDataToBuffer({
        name: converted!.name,
        schemaFields: converted!.schemaFields,
        tableSchema: converted!.tableSchema,
        version: converted!.version,
      });
      const staged: PackedFile = {
        name: converted!.name,
        version: converted!.version,
        tableSchema: converted!.tableSchema,
        schemaFields: converted!.schemaFields,
        buffer: tableBuffer,
        file_size: tableBuffer.length,
        start_pos: -1,
        is_compressed: false,
      };

      // What savePackWithUnsavedFiles / savePackAsWithUnsavedFiles then write.
      const buffer = staged.buffer || Buffer.from(staged.text || "");
      expect(buffer.length).toBeGreaterThan(0);
      await writePack([{ name: staged.name, buffer, file_size: buffer.length }], packPath);

      const saved = await readPack(packPath, { tablesToRead: ["db\\example_tables"] });
      const savedTable = saved.packedFiles.find((packedFile) => packedFile.name === "db\\example_tables\\data__");
      expect(savedTable?.file_size).toBeGreaterThan(0);
      expect(savedTable?.version).toBe(3);
      expect(savedTable?.schemaFields?.map((cell) => cell.fields.at(-1)?.val)).toEqual(["unit_a", 17, 1, "unit_b", 4, 0]);
    } finally {
      appData.currentGame = previousGame;
      if (previousSchemas) DBNameToDBVersions.wh3.example_tables = previousSchemas;
      else delete DBNameToDBVersions.wh3.example_tables;
    }
  });
});
