import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import multer from "multer";
import { request } from "node:http";
import { once } from "node:events";
import { createAiAuthentication } from "./ai-auth";
import { aiUsageStore, reserveAi, withAiUser } from "./ai-usage";

test("verified identity survives delayed multipart chunks on both document endpoints", async t => {
  const reserve = t.mock.method(aiUsageStore, "reserve", async userId => ({ id: "test", userId, day: "2026-10-13" }));
  const app = express();
  const auth = createAiAuthentication(async token => token === "synthetic-token" ? "verified-user" : null);
  const upload = multer({ storage: multer.memoryStorage() });
  for (const path of ["/api/analyze-statement", "/api/analyze-closing-disclosure"]) {
    app.post(path, auth, upload.single("file"), async (req, res) => {
      try {
        assert.equal(req.file?.buffer.toString(), "synthetic document");
        const admitted = await withAiUser(res.locals.aiUserId, () => reserveAi("document"));
        res.json({ userId: admitted.userId });
      } catch { res.status(500).end(); }
    });
  }
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address() as { port: number };
  for (const path of ["/api/analyze-statement", "/api/analyze-closing-disclosure"]) {
    const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1", port: address.port, path, method: "POST",
        headers: { authorization: "Bearer synthetic-token", "content-type": "multipart/form-data; boundary=synthetic-boundary" },
      }, res => {
        let body = "";
        res.on("data", chunk => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      });
      req.on("error", reject);
      req.flushHeaders();
      setTimeout(() => {
        req.write('--synthetic-boundary\r\nContent-Disposition: form-data; name="file"; filename="test.txt"\r\nContent-Type: text/plain\r\n\r\n');
        setTimeout(() => {
          req.write("synthetic document");
          setTimeout(() => req.end("\r\n--synthetic-boundary--\r\n"), 25);
        }, 25);
      }, 25);
    });
    const result = await response;
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body), { userId: "verified-user" });
  }
  assert.equal(reserve.mock.callCount(), 2);
  assert.ok(reserve.mock.calls.every(c => c.arguments[0] === "verified-user"));
});
