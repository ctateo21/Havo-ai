-- APPROVAL REQUIRED. Do not apply to shared or managed databases.
BEGIN;
CREATE TABLE public.county_tax_rate_districts(
 county text NOT NULL,tax_year integer NOT NULL,district_code text NOT NULL,district_name text NOT NULL,
 city_default text,school_mills numeric NOT NULL CHECK(school_mills>=0),non_school_mills numeric NOT NULL CHECK(non_school_mills>=0),
 levies jsonb NOT NULL DEFAULT '[]',source_name text NOT NULL,source_url text NOT NULL,
 fetched_at timestamptz NOT NULL DEFAULT now(),verified_against text,updated_by text,
 PRIMARY KEY(county,tax_year,district_code));
CREATE TABLE public.county_tax_estimate_params(
 county text NOT NULL,tax_year integer NOT NULL,just_value_ratio numeric NOT NULL CHECK(just_value_ratio>0 AND just_value_ratio<=1),
 uses_greater_of_current_just boolean NOT NULL DEFAULT false,school_hx_exemption numeric NOT NULL DEFAULT 25000,
 non_school_additional_hx numeric NOT NULL, cpi_indexed boolean NOT NULL DEFAULT false,
 rounding text NOT NULL CHECK(rounding IN('cents','whole_dollar_per_levy')),
 estimator_url text NOT NULL,verified boolean NOT NULL DEFAULT false,verified_case text,notes text,updated_by text,
 PRIMARY KEY(county,tax_year));
CREATE TABLE public.collier_parcel_millage(
 parcel_id text NOT NULL,tax_year integer NOT NULL,millage_area text NOT NULL,source_url text NOT NULL,
 fetched_at timestamptz NOT NULL DEFAULT now(),updated_by text,PRIMARY KEY(parcel_id,tax_year));
CREATE TABLE public.county_tax_rates_audit(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,table_name text NOT NULL,old_row jsonb,new_row jsonb,
 changed_by text,changed_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION public.audit_county_tax_rates() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 INSERT INTO county_tax_rates_audit(table_name,old_row,new_row,changed_by)
 VALUES(TG_TABLE_NAME,CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,to_jsonb(NEW),NEW.updated_by);
 RETURN NEW;
END $$;
CREATE TRIGGER tax_district_audit AFTER INSERT OR UPDATE ON public.county_tax_rate_districts FOR EACH ROW EXECUTE FUNCTION public.audit_county_tax_rates();
CREATE TRIGGER tax_params_audit AFTER INSERT OR UPDATE ON public.county_tax_estimate_params FOR EACH ROW EXECUTE FUNCTION public.audit_county_tax_rates();
CREATE TRIGGER collier_map_audit AFTER INSERT OR UPDATE ON public.collier_parcel_millage FOR EACH ROW EXECUTE FUNCTION public.audit_county_tax_rates();
ALTER TABLE public.county_tax_rate_districts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.county_tax_estimate_params ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collier_parcel_millage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.county_tax_rates_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.county_tax_rate_districts,public.county_tax_estimate_params,public.collier_parcel_millage,public.county_tax_rates_audit FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.county_tax_rate_districts,public.county_tax_estimate_params,public.collier_parcel_millage,public.county_tax_rates_audit TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.county_tax_rates_audit_id_seq TO service_role;
INSERT INTO public.county_tax_estimate_params(county,tax_year,just_value_ratio,uses_greater_of_current_just,non_school_additional_hx,cpi_indexed,rounding,estimator_url,verified,verified_case,notes) VALUES
('hillsborough',2026,.85,false,25000,false,'cents','https://gis.hcpafl.org/',true,'719400 primary; school 6.334 / non-school 13.4013; AV 11239.52','HCPA low end'),
('pinellas',2026,.85,true,26411,true,'whole_dollar_per_levy','https://www.pcpao.gov/tax_estimatorout',true,'400000 primary SP; AV 5890','2026 Final'),
('sarasota',2026,.89,true,25722,true,'whole_dollar_per_levy','https://www.sarasotapropertyappraiser.gov/TaxEstimator/',true,'400000 primary M0500; AV 4601','2026 TRIM'),
('lee',2026,.9,false,25000,false,'cents','https://www.leepa.org/taxestimator/',true,'400000 primary; AV 4274.09','Flat exemptions, prior-year millage warning retained'),
('manatee',2026,1,false,25000,false,'cents','https://www.manateepao.gov/',true,'313498 primary; AV 4034.33','No official purchase-price estimator'),
('collier',2026,1,false,25000,false,'cents','https://www.collierappraiser.com/',true,'750000 primary; official floors AV to 6370','Quick result is a cents estimate; official estimator floors dollars'),
('pasco',2026,1,false,125000,false,'cents','https://search.pascopa.com/estimate-taxes.aspx',true,'Live Nov 13 UTC: 400000 primary AV 4988.48, no HX 6726.76; school taxable 375000, non-school taxable 250000','Published tool uses 150000 total non-school exemption; retain 2026 bill discrepancy warning'),
('polk',2026,1,false,0,false,'cents','https://www.polkflpa.gov/TaxEstimatorIntro.aspx',false,NULL,'Approved rough formula: price times sourced mills; no exemptions'),
('hernando',2026,1,false,0,false,'cents','https://taxestimator.hernandocountypa-florida.us/taxestimator',false,NULL,'Approved rough formula: price times sourced mills; no exemptions');
-- Supplied November 12 captures: fetched_at records seed import time, not a
-- newly performed county request. verified_against identifies their origin.
INSERT INTO public.county_tax_rate_districts(county,tax_year,district_code,district_name,city_default,school_mills,non_school_mills,levies,source_name,source_url,fetched_at,verified_against) VALUES
('hillsborough',2026,'city:tampa','Tampa planning default','TAMPA',6.334,13.4013,'[]',
'Hillsborough County Property Appraiser supplied rates; imported city default','https://gis.hcpafl.org/PropertySearch/TaxEstimator.aspx',now(),'User-supplied Nov 12 capture, 3102 W Nassau; fetched_at is import time; not a parcel district assignment'),
('pinellas',2026,'SP','St. Petersburg','ST PETERSBURG',6.273,13.5615,
'[{"name":"School discretionary","mills":3.025,"school":true},{"name":"School required","mills":3.248,"school":true},{"name":"County","mills":4.4989,"school":false},{"name":"Authority 2","mills":0.0713,"school":false},{"name":"Authority 3","mills":0.0171,"school":false},{"name":"Authority 4","mills":0.805,"school":false},{"name":"Municipal","mills":6.4525,"school":false},{"name":"Authority 6","mills":0.1831,"school":false},{"name":"Authority 7","mills":0.8168,"school":false},{"name":"Authority 8","mills":0.7168,"school":false}]',
'Pinellas County Property Appraiser supplied 2026 Final rates','https://www.pcpao.gov/tax_estimatorout',now(),'User-supplied Nov 12 capture, 7400 36th Ave N; AV 5890; fetched_at is import time; numbered levy names are placeholders pending capture'),
('sarasota',2026,'M0500','North Port','NORTH PORT',6.131,8.4246,
'[{"name":"School discretionary","mills":2.883,"school":true},{"name":"School required","mills":3.248,"school":true},{"name":"Non-school aggregate","mills":8.4246,"school":false}]',
'Sarasota County Property Appraiser supplied 2026 TRIM rates','https://www.sarasotapropertyappraiser.gov/TaxEstimator/',now(),'User-supplied Nov 12 capture, 1182 S Salford; AV 4601; fetched_at is import time'),
('collier',2026,'city:marco-island','Marco Island planning default','MARCO ISLAND',4.147,4.8052,'[]',
'Collier County Property Appraiser supplied rates; imported city default','https://www.collierappraiser.com/',now(),'User-supplied Nov 12 capture, 940 Montego Ct; fetched_at is import time; not a parcel district assignment');
-- Mark only this migration's provisional seeds so the research migration can
-- replace them without touching live-estimator or administrator rows.
UPDATE public.county_tax_rate_districts SET updated_by='legacy-preview-seed' WHERE updated_by IS NULL;
UPDATE public.county_tax_estimate_params SET updated_by='legacy-preview-seed' WHERE updated_by IS NULL;
CREATE FUNCTION public.import_collier_tax_rates(p_parcels jsonb,p_rates jsonb,p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r jsonb;
BEGIN
 IF p_actor IS NULL OR length(p_actor)=0 THEN RAISE EXCEPTION 'Actor required'; END IF;
 FOR r IN SELECT * FROM jsonb_array_elements(p_parcels) LOOP
  INSERT INTO collier_parcel_millage(parcel_id,tax_year,millage_area,source_url,updated_by)
  VALUES(r->>'parcel_id',(r->>'tax_year')::int,r->>'millage_area',r->>'source_url',p_actor)
  ON CONFLICT(parcel_id,tax_year) DO UPDATE SET millage_area=EXCLUDED.millage_area,source_url=EXCLUDED.source_url,updated_by=p_actor,fetched_at=now();
 END LOOP;
 FOR r IN SELECT * FROM jsonb_array_elements(p_rates) LOOP
  INSERT INTO county_tax_rate_districts(county,tax_year,district_code,district_name,school_mills,non_school_mills,levies,source_name,source_url,updated_by)
  VALUES('collier',(r->>'tax_year')::int,r->>'district_code',r->>'district_name',(r->>'school_mills')::numeric,(r->>'non_school_mills')::numeric,coalesce(r->'levies','[]'),r->>'source_name',r->>'source_url',p_actor)
  ON CONFLICT(county,tax_year,district_code) DO UPDATE SET school_mills=EXCLUDED.school_mills,non_school_mills=EXCLUDED.non_school_mills,source_name=EXCLUDED.source_name,source_url=EXCLUDED.source_url,updated_by=p_actor,fetched_at=now();
 END LOOP;
 RETURN jsonb_build_object('parcels',jsonb_array_length(p_parcels),'districts',jsonb_array_length(p_rates));
END $$;
REVOKE ALL ON FUNCTION public.import_collier_tax_rates(jsonb,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.import_collier_tax_rates(jsonb,jsonb,text) TO service_role;
COMMIT;
