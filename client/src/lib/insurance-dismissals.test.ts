import test from "node:test";
import assert from "node:assert/strict";
import { isInsuranceAddressDismissed } from "./insurance-dismissals";

test("insurance detail tabs honor normalized-key dismissals", () => {
  const dismissed = new Set(["1521|12th street south||33705|fl"]);
  assert.equal(
    isInsuranceAddressDismissed(
      dismissed,
      "1521 12th St S, St. Petersburg, FL 33705, USA",
      "1521|12th street south||33705|fl",
    ),
    true,
  );
});

test("insurance detail tabs honor address fallback dismissals", () => {
  const address = "Unparsed Property Address";
  const dismissed = new Set([address.toLowerCase()]);
  assert.equal(isInsuranceAddressDismissed(dismissed, address, null), true);
  assert.equal(isInsuranceAddressDismissed(dismissed, "Another Address", null), false);
});