export function purchaseHomestead(use: unknown): boolean | null {
  if(use==="primary") return true;
  if(use==="secondary" || use==="investment") return false;
  return null;
}
export function purchaseTaxVariantKey(price:number, homestead:boolean):string {
  return `${price}:${homestead}`;
}
