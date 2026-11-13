-- REVIEW ONLY: do not apply to the shared database without Christian's approval.
BEGIN;
CREATE TABLE public.rebuild_cost_rates (
 county_slug text PRIMARY KEY, county_name text NOT NULL, county_fips text NOT NULL UNIQUE,
 supported boolean NOT NULL DEFAULT false,
 frame_cost_per_sqft numeric CHECK(frame_cost_per_sqft>0),
 masonry_cost_per_sqft numeric CHECK(masonry_cost_per_sqft>0),
 source_note text, updated_by text, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.rebuild_cost_rates(county_slug,county_name,county_fips,supported)
SELECT lower(replace(name,' ','-')),name,'12'||fips,
 lower(name) IN ('hillsborough','pinellas','pasco','polk','sarasota','lee','collier','hernando','manatee')
FROM (VALUES
 ('001','Alachua'),('003','Baker'),('005','Bay'),('007','Bradford'),('009','Brevard'),('011','Broward'),('013','Calhoun'),
 ('015','Charlotte'),('017','Citrus'),('019','Clay'),('021','Collier'),('023','Columbia'),('027','DeSoto'),('029','Dixie'),
 ('031','Duval'),('033','Escambia'),('035','Flagler'),('037','Franklin'),('039','Gadsden'),('041','Gilchrist'),('043','Glades'),
 ('045','Gulf'),('047','Hamilton'),('049','Hardee'),('051','Hendry'),('053','Hernando'),('055','Highlands'),('057','Hillsborough'),
 ('059','Holmes'),('061','Indian River'),('063','Jackson'),('065','Jefferson'),('067','Lafayette'),('069','Lake'),('071','Lee'),
 ('073','Leon'),('075','Levy'),('077','Liberty'),('079','Madison'),('081','Manatee'),('083','Marion'),('085','Martin'),
 ('086','Miami-Dade'),('087','Monroe'),('089','Nassau'),('091','Okaloosa'),('093','Okeechobee'),('095','Orange'),('097','Osceola'),
 ('099','Palm Beach'),('101','Pasco'),('103','Pinellas'),('105','Polk'),('107','Putnam'),('109','St. Johns'),('111','St. Lucie'),
 ('113','Santa Rosa'),('115','Sarasota'),('117','Seminole'),('119','Sumter'),('121','Suwannee'),('123','Taylor'),('125','Union'),
 ('127','Volusia'),('129','Wakulla'),('131','Walton'),('133','Washington')
) counties(fips,name);
CREATE TABLE public.rebuild_cost_rate_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 county_slug text NOT NULL REFERENCES public.rebuild_cost_rates(county_slug),
 field text NOT NULL, old_value jsonb, new_value jsonb, changed_by text NOT NULL,
 changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION public.audit_rebuild_rate_change() RETURNS trigger LANGUAGE plpgsql
SET search_path=public,pg_temp AS $$
DECLARE key text;
BEGIN
 IF NEW.updated_by IS NULL THEN RAISE EXCEPTION 'An authenticated administrator is required'; END IF;
 NEW.updated_at=now();
 FOREACH key IN ARRAY ARRAY['frame_cost_per_sqft','masonry_cost_per_sqft','source_note'] LOOP
  IF to_jsonb(OLD)->key IS DISTINCT FROM to_jsonb(NEW)->key THEN
   INSERT INTO public.rebuild_cost_rate_audit(county_slug,field,old_value,new_value,changed_by)
   VALUES(NEW.county_slug,key,to_jsonb(OLD)->key,to_jsonb(NEW)->key,NEW.updated_by);
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER rebuild_rate_audit BEFORE UPDATE ON public.rebuild_cost_rates
FOR EACH ROW EXECUTE FUNCTION public.audit_rebuild_rate_change();
ALTER TABLE public.rebuild_cost_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rebuild_cost_rate_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rebuild_cost_rates,public.rebuild_cost_rate_audit FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.rebuild_cost_rates,public.rebuild_cost_rate_audit TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.rebuild_cost_rate_audit_id_seq TO service_role;
ALTER TABLE public.property_characteristics_cache ADD COLUMN field_sources jsonb NOT NULL DEFAULT '{}',
 ADD COLUMN roof_permits jsonb NOT NULL DEFAULT '[]';
COMMIT;
