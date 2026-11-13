import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { withAdminTaxParamsDefaults } from "./admin-property-tax-params";
import { PropertyTaxExemptionControls } from "../components/property-tax-exemption-controls";

test("admin defaults use county estimator, keep Manatee's additional $25,000, and leave Amendment 3 off", () => {
  const row = {county:"manatee",school_hx_exemption:25000,non_school_additional_hx:25000,
    source_name:"Saved county source",tax_year:2026,rates_year:2025,label:"Rough estimate · 2025 millage"};
  const draft = withAdminTaxParamsDefaults(row);
  assert.equal(draft.exemption_mode,"county_estimator");
  assert.equal(draft.amendment3_2027,false);
  assert.equal(draft.non_school_additional_hx,25000);
  assert.equal(draft.school_hx_exemption,25000);
  for(const key of ["source_name","tax_year","rates_year","label"] as const) assert.equal(draft[key],row[key]);
  assert.equal(withAdminTaxParamsDefaults({county:"manatee"}).non_school_additional_hx,25000);
  assert.equal(withAdminTaxParamsDefaults({county:"collier"}).non_school_additional_hx,null);
});

test("explicit statutory mode, Amendment 3 selection, and edited amounts are not silently reset", () => {
  const draft = withAdminTaxParamsDefaults({county:"manatee",exemption_mode:"statutory_2026",
    amendment3_2027:true,non_school_additional_hx:26411});
  assert.equal(draft.exemption_mode,"statutory_2026");
  assert.equal(draft.amendment3_2027,true);
  assert.equal(draft.non_school_additional_hx,26411);
  assert.equal(withAdminTaxParamsDefaults({county:"manatee",non_school_additional_hx:0}).non_school_additional_hx,0);
});

test("admin controls expose a labeled select, editable amount, default-off checkbox, and unresolved-policy notes", () => {
  const html = renderToStaticMarkup(React.createElement(PropertyTaxExemptionControls,{
    value:withAdminTaxParamsDefaults({county:"manatee"}),onChange:()=>{},disabled:false,
  }));
  assert.match(html,/<select[^>]*aria-describedby=/);
  assert.match(html,/<option value="county_estimator" selected="">/);
  assert.match(html,/<option value="statutory_2026">Statutory/);
  assert.match(html,/<input[^>]*type="number"[^>]*value="25000"/);
  assert.doesNotMatch(html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0]??"",/checked/);
  for(const text of ["$50,000","$51,411","undecided","$150,000","$25,000",
    "Eligibility and residency exceptions have not been determined",
    "nonhomestead assessment cap from purchase price alone","Source and millage years"]) assert.ok(html.includes(text),text);
});
