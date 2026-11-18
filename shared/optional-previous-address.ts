import { z } from "zod";
export const previousAddressSchema=z.object({
  Address:z.string().trim().min(3).max(200),City:z.string().trim().min(2).max(100),
  State:z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/),Zip:z.string().trim().regex(/^\d{5}(?:-\d{4})?$/),
});
export function completePreviousAddress(value:unknown){
  const result=previousAddressSchema.safeParse(value);
  return result.success?result.data:undefined;
}
