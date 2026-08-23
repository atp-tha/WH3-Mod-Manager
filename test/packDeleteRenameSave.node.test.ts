import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@mongodb-js/zstd", () => ({
  compress: async (value: Uint8Array) => value,
  decompress: async (value: Uint8Array) => value,
}));

import { readPack, writePack } from "../src/packFileSerializer";

const temporaryFolders: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryFolders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

const makeFiles = () => [
  { name: "keep.bin", buffer: Buffer.from("keep bytes"), file_size: 10 },
  { name: "remove.bin", buffer: Buffer.from("remove bytes"), file_size: 12 },
];

describe("staged packed-file removals during save", () => {
  it("removes an entry while preserving survivor bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "whmm-delete-save-"));
    temporaryFolders.push(root);
    const packPath = path.join(root, "source.pack");
    const files = makeFiles();
    await writePack(files, packPath);

    const original = await readPack(packPath, { skipParsingTables: true });
    await writePack([], packPath, original, true, [], ["remove.bin"]);

    const saved = await readPack(packPath, { skipParsingTables: true, filesToRead: ["keep.bin"] });
    expect(saved.packedFiles.map((file) => file.name)).toEqual(["keep.bin"]);
    expect(saved.packedFiles[0]?.buffer).toEqual(files[0].buffer);
  });

  it("writes a valid pack for a delete-only operation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "whmm-delete-only-"));
    temporaryFolders.push(root);
    const packPath = path.join(root, "delete-only.pack");
    await writePack(makeFiles(), packPath);

    const original = await readPack(packPath, { skipParsingTables: true });
    await writePack([], packPath, original, true, [], ["keep.bin", "remove.bin"]);

    const saved = await readPack(packPath, { skipParsingTables: true });
    expect(saved.packedFiles).toEqual([]);
  });
});
