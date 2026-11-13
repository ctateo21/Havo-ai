/** Never let empty profile columns mask sign-up metadata. Never invent names. */
export function insuranceContact(profile:Record<string,unknown>|null, metadata:Record<string,unknown>, email?:string) {
  const first=(...values:unknown[])=>values.find(v=>typeof v==="string"&&v.trim()) as string|undefined;
  const name=first(...[profile?.name,metadata.name,metadata.full_name,
    [metadata.first_name,metadata.last_name].filter(Boolean).join(" ")].filter(v=>typeof v==="string"&&!v.includes("@")))?.trim()??"";
  const parts=name.split(/\s+/).filter(Boolean);
  const phone=first(profile?.phone,metadata.phone,metadata.phone_number)?.trim()??"";
  return {name,firstName:parts[0]??"",lastName:parts.slice(1).join(" "),phone,
    email:first(profile?.email,email)??"",valid:parts.length>=2&&!name.includes("@")&&phone.replace(/\D/g,"").length>=10};
}
