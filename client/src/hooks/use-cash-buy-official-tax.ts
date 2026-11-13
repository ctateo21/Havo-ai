import {useQuickPropertyTax} from "@/hooks/use-quick-property-tax";
import type {CashBuyScenario} from "@/lib/auth";

export function useCashBuyOfficialTax(s:CashBuyScenario) {
  const useSelected=s.occupancyTypeSource==="manual"&&["primary","secondary","investment"].includes(s.occupancyType??"");
  const manual=s.propertyTaxesSource==="manual"&&Number.isFinite(s.propertyTaxes)&&s.propertyTaxes!>=0;
  const quick=useQuickPropertyTax({
    scenarioId:s.id,address:s.address,purchasePrice:s.purchasePrice??0,
    isPrimaryResidence:s.occupancyType==="primary",propertyUseSelected:useSelected,
    manualOverride:manual,
  });
  return {
    ...quick,
    annualTax:!useSelected?null:manual?s.propertyTaxes!:quick.result?.annualTax??null,
    breakdown:quick.result?.breakdown,manual,
  };
}
