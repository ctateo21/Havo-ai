/** Trim at the environment boundary; blank preferred names allow legacy fallback. */
export function quoteRushEnv(env:NodeJS.ProcessEnv=process.env){
  return {
    webId:env.QUOTERUSH_WEBID?.trim()||"",
    webPassword:env.QUOTERUSH_WEBID_PASSWORD?.trim()||env.QUOTERUSH_WEBPASSWORD?.trim()||"",
    endpointKey:env.QUOTERUSH_ENDPOINT_KEY?.trim()||"",
    agency:env.QUOTERUSH_AGENCY_ID?.trim()||env.QUOTERUSH_AGENCY?.trim()||"",
    assignedEmail:env.QUOTERUSH_ASSIGNED_EMAIL?.trim()||"christian@tateoco.com",
  };
}
