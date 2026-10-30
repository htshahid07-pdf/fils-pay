import { chromium } from "playwright";
import fs from "node:fs";
const r = (f) => fs.readFileSync(f, "utf8").trim();
const browser = await chromium.launch();
async function login(email, mid) {
  const page = await browser.newPage(); const errs = [];
  page.on("pageerror", (e) => errs.push(e.message)); page.on("dialog", (d) => d.accept());
  await page.goto("http://localhost:5173/dashboard/login");
  const i = page.locator("form input"); await i.nth(0).fill(mid); await i.nth(1).fill(email); await i.nth(2).fill("FilsPaySeed!2026");
  await page.locator("form button[type=submit]").click();
  const code = await page.locator("code").first().textContent({ timeout: 10000 });
  await page.locator("form input").first().fill(code.trim()); await page.locator("form button[type=submit]").click();
  await page.waitForURL(/dashboard\/(transactions|overview)/, { timeout: 10000 });
  return { page, errs };
}
// support user: no Refund button, and the API refuses a direct call
{ const { page } = await login("support@betadigital.example", r("/tmp/beta.mid"));
  await page.goto(`http://localhost:5173/dashboard/transactions/${r("/tmp/beta.txn")}`); await page.waitForTimeout(1500);
  console.log("support sees Refund button:", await page.getByRole("button", { name: "Refund" }).count() > 0);
  const status = await page.evaluate(async (t) => (await fetch("/v1/refunds", { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ transactionId: t }) })).status, r("/tmp/beta.txn"));
  console.log("support direct POST /v1/refunds ->", status); await page.close(); }
// finance user can refund via session
{ const { page } = await login("finance@betadigital.example", r("/tmp/beta.mid"));
  await page.goto(`http://localhost:5173/dashboard/transactions/${r("/tmp/beta.txn")}`); await page.waitForTimeout(1500);
  console.log("finance sees Refund button:", await page.getByRole("button", { name: "Refund" }).count() > 0); await page.close(); }
// every page renders for the owner without a crash
{ const { page, errs } = await login("owner@alpharetail.example", r("/tmp/alpha.mid"));
  for (const p of ["transactions", "payment-links", "webhooks", "settlement", "reconciliation", "overview"]) {
    await page.goto(`http://localhost:5173/dashboard/${p}`); await page.waitForTimeout(1500);
    const txt = await page.locator("main, section, body").first().innerText();
    const err = await page.locator(".dash-error").allInnerTexts();
    console.log(`page ${p}: ${txt.length > 50 ? "renders" : "EMPTY"}${err.length ? " | error banner: " + err.join(" / ") : ""}`);
    if (p === "settlement" || p === "reconciliation") await page.screenshot({ path: `/mnt/user-data/outputs/ui/3-${p}.png`, fullPage: true });
  }
  console.log("page crashes:", errs.length ? errs : "none"); }
await browser.close();
