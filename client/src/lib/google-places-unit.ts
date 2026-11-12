export interface ParsedPlacesUnit {
  /** The address sent to Google (which only needs to identify the building). */
  buildingInput: string;
  /** The user-entered unit identifier, without its designator. */
  unit?: string;
}

export interface PlacesAddressComponent {
  long_name: string;
  short_name: string;
  types: string[];
}

const UNIT_VALUE = String.raw`([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)`;
const COMPLETE_UNIT = new RegExp(
  String.raw`(?:^|(?<=\s)|(?<=,))(?:unit|apt|apartment)\.?\s*${UNIT_VALUE}(?=\s*(?:,|$))|(?:^|(?<=\s)|(?<=,))#\s*${UNIT_VALUE}(?=\s*(?:,|$))`,
  "i",
);
const INCOMPLETE_UNIT = /(?:^|(?<=\s)|(?<=,))(?:(?:unit|apt|apartment)\.?|#)\s*(?=,|$)/i;

function removeMatch(input: string, match: RegExpMatchArray): string {
  const start = match.index ?? 0;
  const before = input.slice(0, start);
  const after = input.slice(start + match[0].length);
  return `${before}${after}`
    .replace(/\s+,/g, ",")
    .replace(/,\s*,/g, ",")
    .replace(/,\s*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Separates a user-entered unit from the building address Google should search.
 * An unfinished designator is also omitted from the query so typing "Unit"
 * does not make otherwise useful building predictions disappear.
 */
export function parsePlacesUnit(input: string): ParsedPlacesUnit {
  const complete = input.match(COMPLETE_UNIT);
  if (complete) {
    return {
      buildingInput: removeMatch(input, complete),
      unit: complete[1] || complete[2],
    };
  }

  const incomplete = input.match(INCOMPLETE_UNIT);
  return {
    buildingInput: incomplete ? removeMatch(input, incomplete) : input.trim(),
  };
}

/** Adds a unit to Google's building address, always on the first street line. */
export function addressWithUnit(formattedAddress: string, unit?: string): string {
  if (!unit || !formattedAddress.trim()) return formattedAddress;
  const withoutUnit = parsePlacesUnit(formattedAddress).buildingInput;
  const comma = withoutUnit.indexOf(",");
  if (comma < 0) return `${withoutUnit} Unit ${unit}`;
  return `${withoutUnit.slice(0, comma).trim()} Unit ${unit}${withoutUnit.slice(comma)}`;
}

/**
 * Makes the selected place components agree with the user's unit. A typed unit
 * is authoritative over a subpremise unexpectedly returned for the building.
 */
export function componentsWithUnit(
  components: PlacesAddressComponent[] | undefined,
  unit?: string,
): PlacesAddressComponent[] | undefined {
  if (!unit) return components;
  const next = (components || []).filter(component => !component.types.includes("subpremise"));
  const component = { long_name: unit, short_name: unit, types: ["subpremise"] };
  const routeIndex = next.findIndex(item => item.types.includes("route"));
  next.splice(routeIndex < 0 ? 0 : routeIndex + 1, 0, component);
  return next;
}