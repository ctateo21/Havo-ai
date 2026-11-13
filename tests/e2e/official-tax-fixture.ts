/** Synthetic transport fixture for NON-tax browser tests. Not county evidence. */
export function officialTaxFixture(purchasePrice = 400000, homestead = true) {
  const source = {name:"Synthetic browser-test county source",url:"https://gis.hcpafl.org/PropertySearch/TaxEstimator.aspx",fetchedAt:"2026-11-12T14:00:00Z",taxYear:2026,parcelId:"SYNTHETIC-TEST-FIXTURE",purchasePrice,homestead};
  return {key:`synthetic-${purchasePrice}-${homestead}`,status:"official",officialState:"complete",
    taxYear:2026,ratesYear:2026,district:"SYNTHETIC",sourceName:source.name,sourceUrl:source.url,label:"Synthetic county purchase-estimator",
    annualTax:5100,monthlyTax:425,adValorem:5000,nav:100,navPending:false,
    adValoremTax:5000,nonAdValoremTax:100,source:"hillsborough-county-estimator",nonAdValoremPending:false,
    breakdown:{adValorem:{cents:500000,source},nonAdValorem:{cents:10000,source,lines:[{name:"Synthetic assessment",amount:100}]},total:{cents:510000},warnings:[]}};
}
