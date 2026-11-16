import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { computeAssetVersion } from "../helpers/assets.js";

/**
 * Creates one disposable asset tree with the supplied fixture files.
 *
 * @param {Record<string, string>} files Relative file paths and their bytes.
 * @returns {{ root: string, cleanup: () => void }} Temporary fixture.
 */
function createFixtureRoots(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "whatsbot-assets-"));

    for (const [relativePath, contents] of Object.entries(files)) {
        const filePath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents);
    }

    return {
        root,
        cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    };
}

test("asset helper returns a stable fingerprint for the same bytes", () => {
    const fixture = createFixtureRoots({
        "js/index.js": "export const value = 1;\n",
        "css/workspace.css": "body { color: black; }\n",
    });

    try {
        const first = computeAssetVersion({ roots: [path.join(fixture.root, "js"), path.join(fixture.root, "css")] });
        const second = computeAssetVersion({ roots: [path.join(fixture.root, "js"), path.join(fixture.root, "css")] });

        assert.match(first, /^[a-f0-9]{12}$/);
        assert.equal(first, second);
    } finally {
        fixture.cleanup();
    }
});

test("asset helper changes the fingerprint when a fixture byte changes", () => {
    const fixture = createFixtureRoots({
        "js/index.js": "export const value = 1;\n",
        "css/workspace.css": "body { color: black; }\n",
    });

    try {
        const roots = [path.join(fixture.root, "js"), path.join(fixture.root, "css")];
        const before = computeAssetVersion({ roots });

        fs.writeFileSync(path.join(fixture.root, "css", "workspace.css"), "body { color: white; }\n");
        const after = computeAssetVersion({ roots });

        assert.notEqual(before, after);

        fs.writeFileSync(path.join(fixture.root, "js", "fresh.js"), "export const fresh = true;\n");
        const withNewFile = computeAssetVersion({ roots });

        assert.notEqual(after, withNewFile);
    } finally {
        fixture.cleanup();
    }
});
