BEGIN;
CREATE TABLE public.insurance_flood_rechecks (
 address_normalized text PRIMARY KEY, address_display text NOT NULL,
 county text NOT NULL, latitude double precision NOT NULL, longitude double precision NOT NULL,
 state text NOT NULL DEFAULT 'checking' CHECK(state IN ('checking','available','unavailable')),
 started_at timestamptz NOT NULL DEFAULT now(), next_attempt_at timestamptz NOT NULL DEFAULT now(),
 attempts integer NOT NULL DEFAULT 0, lease_token text, result jsonb,
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.insurance_flood_rechecks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.insurance_flood_rechecks FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.insurance_flood_rechecks TO service_role;
CREATE FUNCTION public.record_insurance_flood_result(p_key text,p_display text,p_county text,p_lat double precision,p_lng double precision,p_result jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 INSERT INTO public.property_characteristics_cache(address_normalized,address_display,county,latitude,longitude,
 flood_zone,flood_zone_subtype,sfha,static_bfe,flood_data_source,queried_at,expires_at,field_sources)
 VALUES(p_key,p_display,p_county,p_lat,p_lng,p_result->>'floodZone',p_result->>'floodZoneSubtype',
 (p_result->>'sfha')::boolean,(p_result->>'staticBfe')::numeric,p_result->>'source',
 (p_result->>'queriedAt')::timestamptz,(p_result->>'queriedAt')::timestamptz+interval '1 year',
 jsonb_build_object('floodZone',jsonb_build_object('value',p_result->>'floodZone','source',p_result->>'sourceLabel','sourceUrl',p_result->>'source','fetchedAt',p_result->>'queriedAt')))
 ON CONFLICT(address_normalized) DO UPDATE SET
 flood_zone=excluded.flood_zone,flood_zone_subtype=excluded.flood_zone_subtype,sfha=excluded.sfha,
 static_bfe=excluded.static_bfe,flood_data_source=excluded.flood_data_source,
 field_sources=property_characteristics_cache.field_sources||excluded.field_sources
 WHERE coalesce(property_characteristics_cache.flood_data_source,'') !~* 'manual|confirmed';
$$;
REVOKE ALL ON FUNCTION public.record_insurance_flood_result(text,text,text,double precision,double precision,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_insurance_flood_result(text,text,text,double precision,double precision,jsonb) TO service_role;
COMMIT;
