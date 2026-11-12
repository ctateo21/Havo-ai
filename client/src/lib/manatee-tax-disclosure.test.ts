import {test} from "node:test";
import assert from "node:assert/strict";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {OfficialTaxDisclosure} from "../components/official-tax-disclosure";
import {MANATEE_RATES_LABEL} from "../../../shared/manatee-property-tax";
import {composeOfficialTax} from "../../../shared/official-tax";
test("Manatee disclosure renders calculated source without official-estimator heading",()=>{
  const breakdown=composeOfficialTax({cents:530723,source:{name:MANATEE_RATES_LABEL,
    url:"https://www.manateepao.gov/",taxYear:2026,parcelId:"2051711709",
    fetchedAt:"2026-11-12T12:00:00Z",purchasePrice:400000,homestead:true}},{cents:28236});
  const html=renderToStaticMarkup(React.createElement(OfficialTaxDisclosure,{breakdown,loading:false}));
  assert.ok(html.includes(MANATEE_RATES_LABEL));
  assert.ok(html.includes("Ad valorem — calculated from official rates"));
  assert.ok(!html.includes("Ad valorem — county estimator"));
  assert.ok(html.includes("$5,589.59"));
});
