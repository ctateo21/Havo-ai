export interface QuoteRushPropertyInputs {
  yearBuilt?: number;
  roofYear?: number;
  yearIdx?: number;
  roofIdx?: number;
  constIdx: number;
  windIdx: number;
  openingProtection?: boolean;
  secondaryWaterResistance?: "Yes" | "No" | "Unknown";
  roofShape?: "Hip" | "Flat" | "Gable";
  /** Present for current clients so untouched UI defaults are not facts. */
  windMitigationLocks?: {
    openingProtection?: boolean;
    secondaryWaterResistance?: boolean;
  };
}

export function resolveQuoteRushPropertyInputs(
  inputs: QuoteRushPropertyInputs,
  currentYear = new Date().getFullYear(),
) {
  if(!Number.isInteger(inputs.yearBuilt)||!inputs.yearBuilt)throw new Error("Year built is required");
  if(!Number.isInteger(inputs.roofYear)||inputs.roofYear!<2000||inputs.roofYear!>2027)throw new Error("Enter a whole year from 2000 to 2027.");

  const construction =
    inputs.constIdx === 0
      ? {
          constructionType: "Masonry",
          masonryConstruction: "Concrete Block",
          frameConstruction: "",
        }
      : inputs.constIdx === 2
        ? {
            constructionType: "Frame",
            masonryConstruction: "",
            // Stucco is an exterior finish, not a structural framing type.
            // Leave the QuoteRUSH subtype blank until a verified value exists.
            frameConstruction: "",
          }
        : {
            constructionType: "Mixed",
            masonryConstruction: "Concrete Block",
            frameConstruction: "",
          };

  const yearBuilt = inputs.yearBuilt!;
  // QuoteRUSH has verified mappings only for OpeningProtection and SWR.
  // Keep the roof-to-wall/deck posture as provenance/assumptions; never
  // invent unverified importer keys for it.
  const wind = yearBuilt < 2000
    ? { windMitForm: false, openingProtection: "None", secondaryWaterResistance: "No", windAssumption: "conservative/no-credit" }
    : yearBuilt < 2020
      ? { windMitForm: true, openingProtection: "None", secondaryWaterResistance: "No", windAssumption: "basic/clips where supported" }
      : { windMitForm: true, openingProtection: "Hurricane Protection", secondaryWaterResistance: "Yes", windAssumption: "strongest supported code-compliant values" };
  const legacyExactAnswers = inputs.windMitigationLocks === undefined;

  return {
    yearBuilt,
    roofYear:
      inputs.roofYear!,
    ...construction,
    ...wind,
    ...((legacyExactAnswers || inputs.windMitigationLocks?.openingProtection) &&
    inputs.openingProtection !== undefined
      ? {
          openingProtection: inputs.openingProtection
            ? "Hurricane Protection"
            : "None",
        }
      : {}),
    ...((legacyExactAnswers || inputs.windMitigationLocks?.secondaryWaterResistance) &&
    inputs.secondaryWaterResistance
      ? { secondaryWaterResistance: inputs.secondaryWaterResistance }
      : {}),
    roofShape: inputs.roofShape ?? "Gable",
  };
}