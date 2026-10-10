DROP FUNCTION IF EXISTS public.confirm_cctv_vehicle_attributes(uuid, text, text, text, text);

COMMENT ON FUNCTION public.confirm_cctv_vehicle_attributes(
  uuid, text, text, text, text, text, text, text, integer
) IS
  'The sole human authority for CCTV-derived make, model, colour, body type and year. The legacy make/model-only overload was removed so every caller uses this governed contract.';