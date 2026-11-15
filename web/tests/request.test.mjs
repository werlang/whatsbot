import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { Request } from "../public/js/helpers/request.js";

/**
 * Serves headers immediately but delays the body beyond the request deadline.
 */
async function startSlowBodyServer(status) {
    const server = http.createServer((req, res) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.flushHeaders();
        const timer = setTimeout(() => res.end('{"message":"late body"}'), 300);
        res.on("close", () => clearTimeout(timer));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return server;
}

for (const status of [200, 500]) {
    test(`Request times out a stalled ${status} response body after headers arrive`, async () => {
        const server = await startSlowBodyServer(status);
        try {
            const request = new Request({ timeout: 80 });
            await assert.rejects(request.get(`http://127.0.0.1:${server.address().port}`), /Request timeout/);
        } finally {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
    });
}

test("Request returns a parsed successful body and preserves HTTP error data", async () => {
    const server = http.createServer((req, res) => {
        res.writeHead(req.url === "/failure" ? 400 : 200, { "Content-Type": "application/json" });
        res.end('{"message":"response body"}');
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
        const request = new Request({ timeout: 1000 });
        const url = `http://127.0.0.1:${server.address().port}`;
        assert.deepEqual(await request.get(url), { message: "response body" });
        await assert.rejects(request.get(url + "/failure"), error => {
            assert.equal(error.status, 400);
            assert.deepEqual(error.data, { message: "response body" });
            return true;
        });
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});
