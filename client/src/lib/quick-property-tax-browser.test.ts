import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act, useState } from "react";
import { JSDOM } from "jsdom";
import { useQuickPropertyTax } from "../hooks/use-quick-property-tax";
import { PropertyTaxRow } from "../components/property-tax-row";

const estimate = {
  key: "fixture-a", status: "area_estimate", annualTax: 4827.36, adValorem: 4827.36,
  nav: null, navPending: true, officialState: "pending", taxYear: 2026, ratesYear: 2026,
  district: "fixture-district", sourceName: "Fixture county rates",
  sourceUrl: "https://county.example/rates", label: "Area estimate from fixture rates",
};
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });

test("browser fixture: quick taxes are independent, tuple guarded, manually overridable, and bounded to three minutes", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost/" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const previousFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  const timers = new Map<number, () => void>();
  let timerId = -1;
  globalThis.setTimeout = ((callback: () => void, ms: number, ...args: unknown[]) => {
    if (ms !== 3000) return originalSetTimeout(callback, ms, ...args);
    const id = timerId--; timers.set(id, callback); return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: number | ReturnType<typeof setTimeout>) => {
    if (typeof id === "number" && timers.has(id)) { timers.delete(id); return; }
    originalClearTimeout(id as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  let statusReply: unknown = { key: estimate.key, status: "unavailable", annualTax: null, officialState: "failed", reason: "Fixture county timed out" };
  let quickReply: unknown = estimate;
  let deferred: ((value: Response) => void) | undefined;
  let deferNext = false;
  globalThis.fetch = (async (path, init) => {
    const url = String(path);
    calls.push({ path: url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    assert.equal(init?.credentials, "include");
    if (url === "/api/property-tax/quick") {
      if (deferNext) { deferNext = false; return await new Promise<Response>(resolve => { deferred = resolve; }); }
      return json(quickReply);
    }
    if (url.startsWith("/api/property-tax/official-status?key=")) return json(statusReply);
    throw new Error(`Unexpected request: ${url}. No live requests are allowed.`);
  }) as typeof fetch;
  let latest: ReturnType<typeof useQuickPropertyTax> | undefined;
  const props = { address: "118 Fixture Avenue, Tampa, FL", purchasePrice: 387421,
    isPrimaryResidence: true, scenarioId: "fixture-scenario-a", propertyUseSelected: false };
  function Fixture(input: typeof props) {
    const [manual, setManual] = useState<number | null>(null);
    const tax = useQuickPropertyTax({...input,manualOverride:manual!==null});
    latest = tax;
    return React.createElement(PropertyTaxRow, {
      result: tax.result, loading: tax.loading, reason: tax.reason,
      propertyUse: input.propertyUseSelected ? input.isPrimaryResidence ? "primary" : "investment" : undefined,
      annualTax: manual ?? tax.result?.annualTax ?? null, manual: manual !== null,
      onManualChange: setManual, onRefresh: tax.refresh,
    });
  }
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const render = async () => {
    await act(async () => { root.render(React.createElement(Fixture, { ...props })); });
  };
  const tick = async () => {
    const entry = timers.entries().next().value as [number, () => void] | undefined;
    assert.ok(entry, "a 3-second poll is scheduled");
    timers.delete(entry[0]); now += 3000;
    await act(async () => { entry[1](); });
  };
  try {
    await render();
    assert.equal(calls.length, 0, "Property Use gates all tax requests and figures");
    assert.doesNotMatch(container.textContent!, /\$0|\$4,827/);
    const trigger = () => container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    assert.equal(trigger().getAttribute("aria-expanded"), "false");
    assert.equal(container.querySelector("input"), null, "annual editor belongs inside the disclosure");
    props.propertyUseSelected = true;
    await render();
    assert.equal(calls[0].path, "/api/property-tax/quick");
    assert.equal(calls[0].body?.isPrimaryResidence, true);
    assert.match(container.textContent!, /\$402\.28\/mo/);
    assert.match(container.textContent!, /Est\. · updating/);
    assert.equal(calls.some(call => call.path.includes("/county")), false, "no slow county endpoint blocks the fast amount");
    await act(async () => trigger().click());
    assert.equal(trigger().getAttribute("aria-expanded"), "true");
    assert.match(container.textContent!, /Non-ad valoremPending/);
    assert.match(container.textContent!, /not a verified county bill/);
    assert.ok(container.querySelector('a[href="https://county.example/rates"]'));
    await tick();
    assert.match(container.textContent!, /\$402\.28\/mo/);
    assert.match(container.textContent!, /Official verification did not complete/);
    assert.equal(timers.size, 0, "failed official job stops polling but keeps the estimate");

    // React's native value setter exercises the controlled annual bill editor.
    const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "0");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.match(container.textContent!, /Your bill/);
    assert.match(container.textContent!, /\$0\.00\/mo/);
    const source = { name: "Fixture official estimator", url: "https://county.example/estimator",
      fetchedAt: "2026-06-03T15:24:17Z", taxYear: 2026, parcelId: "fixture-parcel" };
    const officialReply = { ...estimate, status: "official", annualTax: 5017.13, adValorem: 4827.36,
      nav: 189.77, navPending: false, officialState: "complete",
      breakdown: { adValorem: { cents: 482736, source }, nonAdValorem: { cents: 18977, source },
        total: { cents: 501713 }, warnings: [] } };
    quickReply = officialReply;
    await act(async () => { latest?.refresh(); });
    assert.match(container.textContent!, /Your bill/);
    assert.match(container.textContent!, /\$0\.00\/mo/, "official completion never overwrites an explicit manual zero");
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.match(container.textContent!, /Official/);
    assert.match(container.textContent!, /\$418\.09\/mo/);
    assert.equal(latest?.result?.status, "official");
    quickReply = estimate;
    await act(async () => { latest?.refresh(); });
    assert.equal(latest?.result?.status, "area_estimate");
    quickReply = { ...estimate, key: "fixture-b" };
    deferNext = true;
    props.purchasePrice += 17;
    await render();
    assert.equal(latest?.result, undefined, "price edits immediately hide stale results");
    props.isPrimaryResidence = false;
    await render();
    assert.equal(calls.at(-1)?.body?.isPrimaryResidence, false, "only primary residence sends homestead true");
    const currentKey = latest?.result?.key;
    await act(async () => { deferred?.(json({ ...estimate, key: "stale-job", annualTax: 9999.91 })); });
    assert.equal(latest?.result?.key, currentKey, "late prior-tuple responses are ignored");

    props.scenarioId = "fixture-scenario-b";
    await render();
    assert.equal(calls.at(-1)?.body?.scenarioId, "fixture-scenario-b");
    props.address = "120 Fixture Avenue, Tampa, FL";
    await render();
    assert.equal(calls.at(-1)?.body?.address, props.address);
    statusReply = { ...estimate, key: "fixture-b", officialState: "pending" };
    now += 180_001;
    await tick();
    assert.equal(latest?.result?.annualTax, 4827.36);
    assert.equal(latest?.result?.officialState, "failed");
    assert.equal(timers.size, 0);
    assert.match(latest?.reason ?? "", /timed out/);

    quickReply = { key: "setup-failed", status: "unavailable", annualTax: null, officialState: "failed", reason: "Rates migration awaiting approval or database unavailable" };
    await act(async () => { latest?.refresh(); });
    assert.equal(calls.at(-1)?.body?.refresh, true);
    // Same-tuple refresh deliberately retains the prior amount rather than fabricating a fallback.
    props.address = "122 Fixture Avenue, Tampa, FL";
    await render();
    assert.equal(latest?.result?.annualTax, null);
    assert.match(latest?.reason ?? "", /migration awaiting approval/);
    assert.equal(timers.size, 0);
    assert.doesNotMatch(trigger().textContent!, /\$\d/, "missing setup never fabricates a tax amount");

    quickReply = { key:"poll-job",status:"unavailable",annualTax:null,officialState:"pending",reason:"Checking county…" };
    props.address = "124 Fixture Avenue, Tampa, FL";
    await render();
    assert.equal(latest?.result?.annualTax, null);
    statusReply = {...estimate,key:"poll-job"};
    await tick();
    assert.match(trigger().textContent!, /\$402\.28\/mo/);
    assert.match(trigger().textContent!, /Est\. · updating/);
    statusReply = {...officialReply,key:"poll-job"};
    await tick();
    assert.match(trigger().textContent!, /\$418\.09\/mo/);
    assert.match(trigger().textContent!, /Official/);
    assert.equal(timers.size, 0, "official completion stops polling");
    await act(async () => trigger().click());
    assert.equal(trigger().getAttribute("aria-expanded"), "false");
    assert.equal(container.querySelector("input"), null, "evidence and manual controls collapse together");
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    Date.now = originalNow;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
