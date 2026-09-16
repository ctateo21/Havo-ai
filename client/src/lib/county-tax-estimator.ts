// Florida county tax rates
// Source: user-provided county rate table
// homestead = primary residence rate
// nonHomestead = secondary / investment rate

interface CountyRates {
  homestead: number;     // % of taxable value for primary residences
  nonHomestead: number;  // % of taxable value for secondary / investment
}

const FL_COUNTY_RATES: Record<string, CountyRates> = {
  "alachua":       { homestead: 1.7138, nonHomestead: 2.09 },
  "baker":         { homestead: 1.1972, nonHomestead: 1.46 },
  "bay":           { homestead: 1.0414, nonHomestead: 1.27 },
  "bradford":      { homestead: 1.3612, nonHomestead: 1.66 },
  "brevard":       { homestead: 1.1316, nonHomestead: 1.38 },
  "broward":       { homestead: 1.6318, nonHomestead: 1.99 },
  "calhoun":       { homestead: 1.2546, nonHomestead: 1.53 },
  "charlotte":     { homestead: 1.2874, nonHomestead: 1.57 },
  "citrus":        { homestead: 1.2710, nonHomestead: 1.55 },
  "clay":          { homestead: 1.2546, nonHomestead: 1.53 },
  // Conservative fallback for unverified Collier parcels. Verified server
  // responses use the official ParcelJoin millage components.
  "collier":       { homestead: 0.8250, nonHomestead: 0.939 },
  "columbia":      { homestead: 1.2054, nonHomestead: 1.47 },
  "miami-dade":    { homestead: 1.5170, nonHomestead: 1.85 },
  "desoto":        { homestead: 1.3038, nonHomestead: 1.59 },
  "dixie":         { homestead: 1.6318, nonHomestead: 1.99 },
  "duval":         { homestead: 1.4678, nonHomestead: 1.79 },
  "escambia":      { homestead: 1.1562, nonHomestead: 1.41 },
  "flagler":       { homestead: 1.4104, nonHomestead: 1.72 },
  "franklin":      { homestead: 0.8692, nonHomestead: 1.06 },
  "gadsden":       { homestead: 1.3202, nonHomestead: 1.61 },
  "gilchrist":     { homestead: 1.2710, nonHomestead: 1.55 },
  "glades":        { homestead: 1.5088, nonHomestead: 1.84 },
  "gulf":          { homestead: 1.0004, nonHomestead: 1.22 },
  "hamilton":      { homestead: 1.2464, nonHomestead: 1.52 },
  "hardee":        { homestead: 1.1562, nonHomestead: 1.41 },
  "hendry":        { homestead: 1.4104, nonHomestead: 1.72 },
  "hernando":      { homestead: 1.1970, nonHomestead: 1.46 },
  "highlands":     { homestead: 1.1890, nonHomestead: 1.45 },
  "hillsborough":  { homestead: 1.5498, nonHomestead: 1.89 },
  "holmes":        { homestead: 1.2628, nonHomestead: 1.54 },
  "indian river":  { homestead: 1.1644, nonHomestead: 1.42 },
  "jackson":       { homestead: 1.1726, nonHomestead: 1.43 },
  "jefferson":     { homestead: 1.1398, nonHomestead: 1.39 },
  "lafayette":     { homestead: 1.3284, nonHomestead: 1.62 },
  "lake":          { homestead: 1.2792, nonHomestead: 1.56 },
  "lee":           { homestead: 1.1480, nonHomestead: 1.40 },
  "leon":          { homestead: 1.4596, nonHomestead: 1.78 },
  "levy":          { homestead: 1.3120, nonHomestead: 1.60 },
  "liberty":       { homestead: 1.2464, nonHomestead: 1.52 },
  "madison":       { homestead: 1.2464, nonHomestead: 1.52 },
  "manatee":       { homestead: 1.1970, nonHomestead: 1.46 },
  "marion":        { homestead: 1.3038, nonHomestead: 1.59 },
  "martin":        { homestead: 1.3202, nonHomestead: 1.61 },
  "monroe":        { homestead: 0.6724, nonHomestead: 0.82 },
  "nassau":        { homestead: 1.3202, nonHomestead: 1.61 },
  "okaloosa":      { homestead: 1.0086, nonHomestead: 1.23 },
  "okeechobee":    { homestead: 1.1808, nonHomestead: 1.44 },
  "orange":        { homestead: 1.4268, nonHomestead: 1.74 },
  "osceola":       { homestead: 1.2300, nonHomestead: 1.50 },
  "palm beach":    { homestead: 1.4350, nonHomestead: 1.75 },
  "pasco":         { homestead: 1.4100, nonHomestead: 1.72 },
  "pinellas":      { homestead: 1.5170, nonHomestead: 1.85 },
  "polk":          { homestead: 1.2630, nonHomestead: 1.54 },
  "putnam":        { homestead: 1.4514, nonHomestead: 1.77 },
  "st. johns":     { homestead: 1.1480, nonHomestead: 1.40 },
  "st johns":      { homestead: 1.1480, nonHomestead: 1.40 },
  "st. lucie":     { homestead: 1.7712, nonHomestead: 2.16 },
  "st lucie":      { homestead: 1.7712, nonHomestead: 2.16 },
  "santa rosa":    { homestead: 0.9594, nonHomestead: 1.17 },
  "sarasota":      { homestead: 1.0500, nonHomestead: 1.28 },
  "seminole":      { homestead: 1.2546, nonHomestead: 1.53 },
  "sumter":        { homestead: 0.9184, nonHomestead: 1.12 },
  "suwannee":      { homestead: 1.2874, nonHomestead: 1.57 },
  "taylor":        { homestead: 1.2628, nonHomestead: 1.54 },
  "union":         { homestead: 1.3694, nonHomestead: 1.67 },
  "volusia":       { homestead: 1.4268, nonHomestead: 1.74 },
  "wakulla":       { homestead: 1.0988, nonHomestead: 1.34 },
  "walton":        { homestead: 0.7544, nonHomestead: 0.92 },
  "washington":    { homestead: 1.2300, nonHomestead: 1.50 },
};

// Major Florida city → county mapping for address parsing
const CITY_TO_COUNTY: Record<string, string> = {
  // Alachua
  "gainesville": "alachua", "newberry": "alachua", "hawthorne": "alachua",
  // Bay
  "panama city": "bay", "lynn haven": "bay", "panama city beach": "bay", "callaway": "bay",
  // Brevard
  "melbourne": "brevard", "titusville": "brevard", "palm bay": "brevard", "cocoa": "brevard",
  "cocoa beach": "brevard", "viera": "brevard", "merritt island": "brevard",
  // Broward
  "fort lauderdale": "broward", "hollywood": "broward", "pompano beach": "broward",
  "coral springs": "broward", "miramar": "broward", "pembroke pines": "broward",
  "sunrise": "broward", "plantation": "broward", "lauderhill": "broward",
  "deerfield beach": "broward", "tamarac": "broward", "margate": "broward",
  "coconut creek": "broward", "weston": "broward", "davie": "broward",
  // Charlotte
  "port charlotte": "charlotte", "punta gorda": "charlotte", "englewood": "charlotte",
  // Citrus
  "crystal river": "citrus", "inverness": "citrus", "homosassa": "citrus",
  // Clay
  "orange park": "clay", "fleming island": "clay", "middleburg": "clay", "green cove springs": "clay",
  // Collier
  "naples": "collier", "marco island": "collier", "immokalee": "collier", "golden gate": "collier",
  // Columbia
  "lake city": "columbia",
  // Miami-Dade
  "miami": "miami-dade", "miami beach": "miami-dade", "hialeah": "miami-dade",
  "coral gables": "miami-dade", "homestead": "miami-dade", "kendall": "miami-dade",
  "doral": "miami-dade", "cutler bay": "miami-dade", "north miami": "miami-dade",
  "aventura": "miami-dade", "miami gardens": "miami-dade", "opa-locka": "miami-dade",
  // Duval
  "jacksonville": "duval", "jacksonville beach": "duval", "neptune beach": "duval",
  "atlantic beach": "duval",
  // Escambia
  "pensacola": "escambia", "pensacola beach": "escambia",
  // Flagler
  "palm coast": "flagler", "flagler beach": "flagler", "bunnell": "flagler",
  // Hernando
  "spring hill": "hernando", "brooksville": "hernando",
  // Highlands
  "sebring": "highlands", "avon park": "highlands",
  // Hillsborough
  "tampa": "hillsborough", "brandon": "hillsborough", "riverview": "hillsborough",
  "plant city": "hillsborough", "temple terrace": "hillsborough", "lutz": "hillsborough",
  "valrico": "hillsborough", "wesley chapel": "hillsborough", "wimauma": "hillsborough",
  "sun city center": "hillsborough", "gibsonton": "hillsborough", "ruskin": "hillsborough",
  "apollo beach": "hillsborough", "dover": "hillsborough",
  // Indian River
  "vero beach": "indian river", "sebastian": "indian river",
  // Lake
  "leesburg": "lake", "clermont": "lake", "tavares": "lake", "mount dora": "lake",
  "eustis": "lake", "fruitland park": "lake",
  // Lee
  "fort myers": "lee", "cape coral": "lee", "bonita springs": "lee",
  "estero": "lee", "sanibel": "lee", "lehigh acres": "lee",
  // Leon
  "tallahassee": "leon",
  // Manatee
  "bradenton": "manatee", "palmetto": "manatee", "anna maria": "manatee",
  "lakewood ranch": "manatee",
  // Marion
  "ocala": "marion", "belleview": "marion",
  // Martin
  "stuart": "martin", "hobe sound": "martin", "jensen beach": "martin",
  // Monroe
  "key west": "monroe", "key largo": "monroe", "marathon": "monroe",
  "islamorada": "monroe", "big pine key": "monroe",
  // Nassau
  "fernandina beach": "nassau", "yulee": "nassau", "callahan": "nassau",
  // Okaloosa
  "fort walton beach": "okaloosa", "destin": "okaloosa", "niceville": "okaloosa",
  "crestview": "okaloosa",
  // Orange
  "orlando": "orange", "winter park": "orange", "apopka": "orange",
  "ocoee": "orange", "windermere": "orange", "winter garden": "orange",
  "maitland": "orange", "edgewood": "orange",
  // Osceola
  "kissimmee": "osceola", "saint cloud": "osceola", "st cloud": "osceola",
  "celebration": "osceola", "poinciana": "osceola",
  // Palm Beach
  "west palm beach": "palm beach", "boca raton": "palm beach", "delray beach": "palm beach",
  "boynton beach": "palm beach", "wellington": "palm beach", "lake worth": "palm beach",
  "palm beach gardens": "palm beach", "jupiter": "palm beach", "greenacres": "palm beach",
  "royal palm beach": "palm beach", "north palm beach": "palm beach",
  // Pasco
  "new port richey": "pasco", "port richey": "pasco", "dade city": "pasco",
  "zephyrhills": "pasco", "land o lakes": "pasco", "holiday": "pasco", "hudson": "pasco",
  // Pinellas
  "st. petersburg": "pinellas", "st petersburg": "pinellas", "clearwater": "pinellas",
  "largo": "pinellas", "dunedin": "pinellas", "palm harbor": "pinellas",
  "safety harbor": "pinellas", "tarpon springs": "pinellas", "seminole": "pinellas",
  "pinellas park": "pinellas", "gulfport": "pinellas", "st pete beach": "pinellas",
  "treasure island": "pinellas", "belleair": "pinellas", "oldsmar": "pinellas",
  // Polk
  "lakeland": "polk", "winter haven": "polk", "bartow": "polk",
  "auburndale": "polk", "haines city": "polk", "davenport": "polk", "lake wales": "polk",
  // Putnam
  "palatka": "putnam",
  // St. Johns
  "st augustine": "st. johns", "saint augustine": "st. johns",
  "ponte vedra": "st. johns", "ponte vedra beach": "st. johns",
  "nocatee": "st. johns",
  // St. Lucie
  "port st lucie": "st. lucie", "port saint lucie": "st. lucie",
  "fort pierce": "st. lucie",
  // Santa Rosa
  "milton": "santa rosa", "gulf breeze": "santa rosa", "navarre": "santa rosa",
  // Sarasota
  "sarasota": "sarasota", "venice": "sarasota", "north port": "sarasota",
  "siesta key": "sarasota", "osprey": "sarasota",
  // Seminole
  "sanford": "seminole", "altamonte springs": "seminole", "casselberry": "seminole",
  "longwood": "seminole", "oviedo": "seminole", "lake mary": "seminole",
  "winter springs": "seminole",
  // Sumter
  "the villages": "sumter", "wildwood": "sumter", "bushnell": "sumter",
  // Volusia
  "daytona beach": "volusia", "deltona": "volusia", "port orange": "volusia",
  "new smyrna beach": "volusia", "ormond beach": "volusia", "deland": "volusia",
  "edgewater": "volusia", "holly hill": "volusia",
  // Walton
  "miramar beach": "walton", "santa rosa beach": "walton",
  "defuniak springs": "walton", "freeport": "walton",
};

// FL state default (average)
const FL_DEFAULT_RATES: CountyRates = { homestead: 1.30, nonHomestead: 1.60 };

/** Detect Florida county from a free-form address string */
export function getCountyFromAddress(address: string): CountyRates {
  const lower = address.toLowerCase();

  // 1. Direct county name mention (e.g. "Hillsborough County")
  for (const county of Object.keys(FL_COUNTY_RATES)) {
    if (lower.includes(county + " county") || lower.includes(county + "county")) {
      return FL_COUNTY_RATES[county];
    }
  }

  // 2. City name lookup
  for (const [city, county] of Object.entries(CITY_TO_COUNTY)) {
    if (lower.includes(city)) {
      return FL_COUNTY_RATES[county] ?? FL_DEFAULT_RATES;
    }
  }

  // 3. Plain county name (no "county" suffix)
  for (const county of Object.keys(FL_COUNTY_RATES)) {
    if (lower.includes(county)) {
      return FL_COUNTY_RATES[county];
    }
  }

  return FL_DEFAULT_RATES;
}

/**
 * Returns the estimated annual property tax for a Florida property.
 * @param address   Full address string
 * @param price     Purchase / assessed value
 * @param isPrimary true = primary residence (homestead rate), false = secondary or investment
 */
export function estimateAnnualTax(address: string, price: number, isPrimary: boolean): number {
  const rates = getCountyFromAddress(address);
  const ratePercent = isPrimary ? rates.homestead : rates.nonHomestead;
  return Math.round(price * (ratePercent / 100));
}

// ── County property tax lookup URLs ──────────────────────────────────────────

const COUNTY_TAX_LINKS: Record<string, { url: string; label: string }> = {
  "alachua":      { url: "https://www.acpafl.org/", label: "Alachua Property Appraiser" },
  "baker":        { url: "https://qpublic.net/fl/baker/", label: "Baker County Property Appraiser" },
  "bay":          { url: "https://www.baypa.net/", label: "Bay County Property Appraiser" },
  "bradford":     { url: "https://bradfordpa.com/", label: "Bradford County Property Appraiser" },
  "brevard":      { url: "https://www.bcpao.us/", label: "Brevard County Property Appraiser" },
  "broward":      { url: "https://bcpa.net/taxestimator/", label: "Broward Tax Estimator" },
  "calhoun":      { url: "https://qpublic.net/fl/calhoun/", label: "Calhoun County Property Appraiser" },
  "charlotte":    { url: "https://www.ccappraiser.com/", label: "Charlotte County Property Appraiser" },
  "citrus":       { url: "https://www.citruspa.org/", label: "Citrus County Property Appraiser" },
  "clay":         { url: "https://www.ccpao.com/", label: "Clay County Property Appraiser" },
  "collier":      { url: "https://www.collierappraiser.com/", label: "Collier County Property Appraiser" },
  "columbia":     { url: "https://qpublic.net/fl/columbia/", label: "Columbia County Property Appraiser" },
  "miami-dade":   { url: "https://www.miamidade.gov/pa/property_search.asp", label: "Miami-Dade Tax Estimator" },
  "desoto":       { url: "https://qpublic.net/fl/desoto/", label: "DeSoto County Property Appraiser" },
  "dixie":        { url: "https://dixiecountypa.com/", label: "Dixie County Property Appraiser" },
  "duval":        { url: "https://paopropertysearch.coj.net/", label: "Duval Property Search" },
  "escambia":     { url: "https://www.escpa.org/", label: "Escambia County Property Appraiser" },
  "flagler":      { url: "https://www.flaglerpa.com/", label: "Flagler County Property Appraiser" },
  "franklin":     { url: "https://qpublic.net/fl/franklin/", label: "Franklin County Property Appraiser" },
  "gadsden":      { url: "https://www.gadsdencountyappraiser.com/", label: "Gadsden County Property Appraiser" },
  "gilchrist":    { url: "https://qpublic.net/fl/gilchrist/", label: "Gilchrist County Property Appraiser" },
  "glades":       { url: "https://qpublic.net/fl/glades/", label: "Glades County Property Appraiser" },
  "gulf":         { url: "https://www.gulfpa.com/", label: "Gulf County Property Appraiser" },
  "hamilton":     { url: "https://qpublic.net/fl/hamilton/", label: "Hamilton County Property Appraiser" },
  "hardee":       { url: "https://qpublic.net/fl/hardee/", label: "Hardee County Property Appraiser" },
  "hendry":       { url: "https://www.hendryappraiser.com/", label: "Hendry County Property Appraiser" },
  "hernando":     { url: "https://www.hernandopa.com/", label: "Hernando County Property Appraiser" },
  "highlands":    { url: "https://www.hcpafl.org/", label: "Highlands County Property Appraiser" },
  "hillsborough": { url: "https://gis.hcpafl.org/TaxEstimator/", label: "Hillsborough Tax Estimator" },
  "holmes":       { url: "https://qpublic.net/fl/holmes/", label: "Holmes County Property Appraiser" },
  "indian river": { url: "https://www.ircpa.org/", label: "Indian River Property Appraiser" },
  "jackson":      { url: "https://qpublic.net/fl/jackson/", label: "Jackson County Property Appraiser" },
  "jefferson":    { url: "https://qpublic.net/fl/jefferson/", label: "Jefferson County Property Appraiser" },
  "lafayette":    { url: "https://qpublic.net/fl/lafayette/", label: "Lafayette County Property Appraiser" },
  "lake":         { url: "https://www.lakepa.org/taxestimator/", label: "Lake Tax Estimation Calculator" },
  "lee":          { url: "https://www.leepa.org/taxestimator/taxestimator.aspx", label: "Lee County Tax Estimator" },
  "leon":         { url: "https://www.leonpa.org/", label: "Leon County Property Appraiser" },
  "levy":         { url: "https://www.levypa.com/", label: "Levy County Property Appraiser" },
  "liberty":      { url: "https://qpublic.net/fl/liberty/", label: "Liberty County Property Appraiser" },
  "madison":      { url: "https://qpublic.net/fl/madison/", label: "Madison County Property Appraiser" },
  "manatee":      { url: "https://www.manateepao.com/", label: "Manatee County Property Appraiser" },
  "marion":       { url: "https://www.pa.marion.fl.us/", label: "Marion County Property Appraiser" },
  "martin":       { url: "https://www.pa.martin.fl.us/", label: "Martin County Property Appraiser" },
  "monroe":       { url: "https://www.mcpafl.org/", label: "Monroe County Property Appraiser" },
  "nassau":       { url: "https://www.nassauflpa.com/", label: "Nassau County Property Appraiser" },
  "okaloosa":     { url: "https://www.okaloosapafl.com/", label: "Okaloosa County Property Appraiser" },
  "okeechobee":   { url: "https://www.okeechobeepa.com/", label: "Okeechobee County Property Appraiser" },
  "orange":       { url: "https://www.ocpafl.org/taxestimator", label: "Orange County Tax Estimator" },
  "osceola":      { url: "https://www.property-appraiser.org/", label: "Osceola Tax Estimator" },
  "palm beach":   { url: "https://www.pbcgov.org/papa/", label: "Palm Beach Property Tax Calculator" },
  "pasco":        { url: "https://pascopa.com/", label: "Pasco County Property Appraiser" },
  "pinellas":     { url: "https://www.pcpao.gov/", label: "Pinellas Tax Estimator" },
  "polk":         { url: "https://www.polk-county.net/property-appraiser/", label: "Polk County Property Appraiser" },
  "putnam":       { url: "https://www.putnam-fl.com/pa/", label: "Putnam County Property Appraiser" },
  "santa rosa":   { url: "https://www.srcpa.org/", label: "Santa Rosa County Property Appraiser" },
  "sarasota":     { url: "https://www.sc-pa.com/propertysearch/", label: "Sarasota Tax Estimator" },
  "seminole":     { url: "https://www.scpafl.org/", label: "Seminole Tax Estimator" },
  "st. johns":    { url: "https://www.sjcpa.us/", label: "St. Johns County Property Appraiser" },
  "st johns":     { url: "https://www.sjcpa.us/", label: "St. Johns County Property Appraiser" },
  "st. lucie":    { url: "https://www.paslc.gov/", label: "St. Lucie Property Appraiser" },
  "st lucie":     { url: "https://www.paslc.gov/", label: "St. Lucie Property Appraiser" },
  "sumter":       { url: "https://www.sumterpa.com/", label: "Sumter County Property Appraiser" },
  "suwannee":     { url: "https://www.suwanneepa.com/", label: "Suwannee County Property Appraiser" },
  "taylor":       { url: "https://qpublic.net/fl/taylor/", label: "Taylor County Property Appraiser" },
  "union":        { url: "https://qpublic.net/fl/union/", label: "Union County Property Appraiser" },
  "volusia":      { url: "https://vcpa.vcgov.org/", label: "Volusia Estimate Taxes" },
  "wakulla":      { url: "https://www.wakullaappraiser.com/", label: "Wakulla County Property Appraiser" },
  "walton":       { url: "https://www.waltoncountypa.com/", label: "Walton County Property Appraiser" },
  "washington":   { url: "https://qpublic.net/fl/washington/", label: "Washington County Property Appraiser" },
};

/** Returns the county name detected from an address, or null if not found */
export function getCountyName(address: string): string | null {
  const lower = address.toLowerCase();

  for (const county of Object.keys(FL_COUNTY_RATES)) {
    if (lower.includes(county + " county") || lower.includes(county + "county")) {
      return county;
    }
  }
  for (const [city, county] of Object.entries(CITY_TO_COUNTY)) {
    if (lower.includes(city)) return county;
  }
  for (const county of Object.keys(FL_COUNTY_RATES)) {
    if (lower.includes(county)) return county;
  }
  return null;
}

/** Returns the tax lookup URL + label for the detected county, or null */
export function getCountyTaxLink(address: string): { url: string; label: string } | null {
  const county = getCountyName(address);
  if (!county) return null;
  return COUNTY_TAX_LINKS[county] ?? null;
}

// ── Legacy exports kept for backwards-compatibility ──────────────────────────

export interface PropertyTaxEstimate {
  estimatedAnnualTax: number;
  taxRate: number;
  county: string;
  adValoremTax: number;
  nonAdValoremTax: number;
  homesteadExemption: boolean;
  source: "county_website" | "estimated";
}

export interface CountyTaxRequest {
  address: string;
  salePrice: number;
  isPrimaryResidence: boolean;
}

export async function getPropertyTaxEstimate(request: CountyTaxRequest): Promise<PropertyTaxEstimate> {
  const annual = estimateAnnualTax(request.address, request.salePrice, request.isPrimaryResidence);
  return {
    estimatedAnnualTax: annual,
    taxRate: (annual / request.salePrice) * 100,
    county: "Florida",
    adValoremTax: annual * 0.85,
    nonAdValoremTax: annual * 0.15,
    homesteadExemption: request.isPrimaryResidence,
    source: "estimated",
  };
}
