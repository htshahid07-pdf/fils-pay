import http from "node:http"; import { createHmac, timingSafeEqual } from "node:crypto"; import fs from "node:fs";
const secret = () => fs.readFileSync("/tmp/whsec", "utf8").trim();
http.createServer((req, res) => { let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
  const h = req.headers["webhook-signature"] ?? ""; const t = /t=(\d+)/.exec(h)?.[1]; const v1 = /v1=([0-9a-f]+)/.exec(h)?.[1] ?? "";
  const mine = createHmac("sha256", secret()).update(`${t}.${raw}`).digest("hex");
  const ok = v1.length === mine.length && timingSafeEqual(Buffer.from(v1), Buffer.from(mine));
  fs.appendFileSync("/tmp/received.jsonl", JSON.stringify({ type: JSON.parse(raw).type, signatureValid: ok, body: raw }) + "\n");
  res.writeHead(200); res.end("ok"); }); }).listen(4000, () => console.log("receiver on 4000"));
