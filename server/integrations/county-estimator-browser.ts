import { interactTaxPage, paceCollier } from "./firecrawl-tax";
import { browserOutput } from "./official-county-bills";
import { moneyCents } from "./county-tax-http";
import { streetAddressMatches } from "./hillsborough-tax";
import type { EstimatorInput, EstimatorOutput } from "./county-estimator-direct";
export async function browserEstimator(input: EstimatorInput): Promise<EstimatorOutput> {
  const {county,parcelId,purchasePrice,homestead} = input;
  const flag = county==="collier" ? "COLLIER_BROWSER_ESTIMATOR" : "HERNANDO_BROWSER_ESTIMATOR";
  if (process.env[flag]!=="on") throw new Error(`${county==="collier"?"Collier":"Hernando"} estimator requires browser automation (disabled)`);
  const url = county==="collier" ? "https://www.collierappraiser.com/Main_Search/search_rp.html?TaxEst=1" : "https://taxestimator.hernandocountypa-florida.us/taxestimator";
  const code = county==="collier" ? `
    const p = ${JSON.stringify(input)};
    let frame = page.frame({name:'rbottom'});
    if (!frame) throw new Error('Collier content frame unavailable');
    const agreement=frame.getByText('I Agree',{exact:true});
    if(await agreement.isVisible()) await agreement.click();
    await page.waitForTimeout(1500);
    const nav = page.frames().find(f=>f.url().includes('Buttons.html'));
    if (!nav) throw new Error('Collier navigation unavailable');
    await nav.locator('a[href*="search_rp.html?TaxEst=1"]').click();
    await page.waitForTimeout(3000);
    frame = page.frame({name:'rbottom'});
    await frame.getByText('Site Address',{exact:true}).click();
    const entry = frame.locator('#SiteStreetAddress');
    if(!p.address) throw new Error('Collier site address unavailable');
    await entry.fill(p.address.split(',')[0]);
    await frame.locator('#SearchFullAddress').click();
    await frame.waitForURL('**/TaxEstimator.html?**');
    const resolvedParcel=new URL(frame.url()).searchParams.get('FolioID');
    if (!resolvedParcel || (p.parcelId && resolvedParcel!==p.parcelId)) throw new Error('Estimator parcel mismatch');
    await frame.locator('#txtPurchasePrice').fill(String(p.purchasePrice));
    await frame.locator('#txtPurchasePrice').press('Enter');
    await frame.locator(p.homestead?'#rbHXYes':'#rbHXNo').check();
    if(p.homestead) await frame.locator('#rbPortNo').check();
    await page.waitForTimeout(1500);
    const hidden = {};
    for(const id of ['hdnRatio','hdnRatioNonSchoolBoard','hdnRatioSchoolBoard','hdnTotalNAdvTaxes']) hidden[id] = await frame.locator('#'+id).inputValue();
    const text = await frame.locator('body').innerText();
    console.log(JSON.stringify({text,hidden,parcelId:resolvedParcel}));
  ` : `
    const p = ${JSON.stringify(input)};
    await page.getByRole('button',{name:'I Understand & Continue'}).click();
    await page.getByRole('textbox').first().waitFor({state:'visible',timeout:30000});
    await page.getByRole('textbox').first().fill(p.parcelId || p.address);
    await page.getByRole('button',{name:/Locate/i}).click();
    await page.getByLabel(/Market Value/i).fill(String(p.purchasePrice));
    await page.getByLabel(/Portability/i).fill('0');
    if (!p.taxDistrict) throw new Error('Hernando tax district unavailable');
    const district=page.getByLabel(/Tax District/i);
    const choices=await district.locator('option').evaluateAll(es=>es.map(e=>({value:e.value,text:e.textContent||''})));
    const matching=choices.filter(o=>o.value===p.taxDistrict || o.text.toUpperCase().split(/[^A-Z0-9]+/).includes(p.taxDistrict.toUpperCase()));
    if(matching.length!==1) throw new Error('Hernando tax district could not be matched');
    await district.selectOption(matching[0].value);
    await page.getByLabel('Homestead ($50,000)',{exact:true}).setChecked(p.homestead);
    await page.getByRole('button',{name:'Calculate',exact:true}).click();
    await page.getByText(/Total Estimated Taxes/i).first().waitFor({state:'visible',timeout:30000});
    await page.waitForTimeout(1500);
    console.log(JSON.stringify({text:await page.locator('body').innerText()}));
  `;
  const execute = () => interactTaxPage(url,code);
  const data = browserOutput(await (county==="collier" ? paceCollier(execute) : execute()));
  if(county==="collier") {
    const situsAddress=/Site Address\s+([^\n]+)/i.exec(String(data.text))?.[1]?.trim();
    if(!situsAddress || !streetAddressMatches(input.address,situsAddress)) throw new Error("Collier estimator site address does not match");
    if(!/^\d{11}$/.test(String(data.parcelId))) throw new Error("Collier estimator parcel identifier missing");
    data.situsAddress=situsAddress;
  }
  return parseBrowserEstimatorPage(county,data,url);
}
export function parseBrowserEstimatorPage(county:string,data:any,url:string):EstimatorOutput {
  const text = String(data.text || "");
  const label = county==="collier" ? /Approximate Ad Valorem Taxes\s*\(\$\)\s*:?\s*([\d,.]+)/i : /Total Estimated Taxes\s*:?\s*\$?\s*([\d,.]+)/i;
  const amount = label.exec(text);
  if (!amount) throw new Error("Official browser estimator amount missing");
  const nav = /Approximate Non-Ad Valorem Assessments\s*\(\$\)\s*([\d,.]+)/i.exec(text);
  const output: EstimatorOutput = {adValoremCents:moneyCents(amount[1]),estimatorNavCents:nav?moneyCents(nav[1]):null,url,fetchedAt:new Date().toISOString(),snapshot:text.slice(0,12000),parcelId:data.parcelId,situsAddress:data.situsAddress};
  if (county==="collier") {
    const nonSchool = Number(data.hidden?.hdnRatioNonSchoolBoard), school = Number(data.hidden?.hdnRatioSchoolBoard), total = Number(data.hidden?.hdnRatio);
    if (!(school>0 && nonSchool>0) || Math.abs(school+nonSchool-total)>1e-8) throw new Error("Collier hidden ratios missing or inconsistent");
    output.schoolMills = school*1000; output.nonSchoolMills = nonSchool*1000;
    output.assessmentRatio = 1; output.exemptionSchedule = {homestead_school:25000,homestead_non_school:50000};
    // Retain fractional NAV, although the estimator displays whole dollars.
    output.estimatorNavCents = moneyCents(String(data.hidden.hdnTotalNAdvTaxes));
  }
  return output;
}
