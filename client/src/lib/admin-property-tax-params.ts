/** Editor defaults only. Tax calculations and source/year labels stay server-owned. */
export function withAdminTaxParamsDefaults(row: Record<string, unknown>): Record<string, unknown> {
  const manatee = String(row.county ?? "").trim().toLowerCase() === "manatee";
  return {
    ...row,
    exemption_mode: row.exemption_mode ?? "county_estimator",
    non_school_additional_hx: row.non_school_additional_hx ?? (manatee ? 25000 : null),
    amendment3_2027: row.amendment3_2027 ?? false,
  };
}
