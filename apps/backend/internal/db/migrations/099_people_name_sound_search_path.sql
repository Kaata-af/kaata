-- An empty database could apply the original 098 without evaluating the
-- function. Pin its path too so those installations can later rebuild the
-- index safely, even if their stored function body is still unqualified.
ALTER FUNCTION public.people_name_sound_keys(TEXT, BOOLEAN)
  SET search_path = pg_catalog, public, pg_temp;
