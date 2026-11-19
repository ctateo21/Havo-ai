/** Calendar date only: keep dates independent of browser time-of-day. */
export function insuranceEffectiveDate(now = new Date()): string {
  const date = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + 14));
  return date.toISOString().slice(0, 10);
}
export const ROOF_MATERIALS = ["Architectural Shingles", "Metal", "Tile", "Tar and Gravel", "Rubber", "Rolled Roofing"] as const;
export function reportRoofMaterial(raw?:string):typeof ROOF_MATERIALS[number]|undefined {
  const value=raw?.trim().toLowerCase();
  if(!value)return undefined;
  const aliases:Record<string,typeof ROOF_MATERIALS[number]>={
    shingle:"Architectural Shingles",shingles:"Architectural Shingles","architectural shingles":"Architectural Shingles",
    tile:"Tile",metal:"Metal","built up":"Tar and Gravel","built-up":"Tar and Gravel","tar and gravel":"Tar and Gravel",
    membrane:"Rubber",rubber:"Rubber","rolled roofing":"Rolled Roofing",
  };
  return aliases[value];
}
