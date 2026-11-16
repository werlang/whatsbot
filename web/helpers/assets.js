import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HASH_LENGTH = 12;
const DEFAULT_ASSET_ROOTS = [
    fileURLToPath(new URL("../public/js/", import.meta.url)),
    fileURLToPath(new URL("../public/css/", import.meta.url)),
];

/**
 * Lists every file under one directory in a deterministic depth-first order.
 *
 * @param {string} directory Root directory to walk.
 * @param {typeof fs} fileSystem Injected filesystem, used by tests.
 * @returns {string[]} Absolute file paths.
 */
function listAssetFiles(directory, fileSystem) {
    let entries;

    try {
        entries = fileSystem.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
        if (error?.code === "ENOENT") {
            return [];
        }
        throw error;
    }

    const files = [];
    const orderedEntries = [...entries].sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of orderedEntries) {
        const entryPath = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            files.push(...listAssetFiles(entryPath, fileSystem));
            continue;
        }

        if (entry.isFile()) {
            files.push(entryPath);
        }
    }

    return files;
}

/**
 * Computes a short deterministic fingerprint over every browser asset under the given roots.
 *
 * The relative path and the file bytes are both hashed, so renaming a file or editing one byte
 * changes the version. Tests inject their own roots and never touch product files.
 *
 * @param {{ roots?: string[], fileSystem?: typeof fs }} [options] Injected roots or filesystem.
 * @returns {string} First 12 hex characters of the sha256 digest.
 */
function computeAssetVersion({ roots = DEFAULT_ASSET_ROOTS, fileSystem = fs } = {}) {
    const hash = crypto.createHash("sha256");

    for (const root of roots) {
        for (const filePath of listAssetFiles(root, fileSystem)) {
            const relativePath = path.relative(root, filePath).split(path.sep).join("/");
            hash.update(relativePath);
            hash.update("\0");
            hash.update(fileSystem.readFileSync(filePath));
            hash.update("\0");
        }
    }

    return hash.digest("hex").slice(0, HASH_LENGTH);
}

/**
 * Fingerprint computed once when this process starts. An asset edit requires a restart, which is
 * exactly what makes a stale browser copy impossible after a deployment.
 */
const assetVersion = computeAssetVersion();

export { assetVersion, computeAssetVersion };
