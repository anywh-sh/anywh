import { sanitizeExceptionList } from "@/lib/telemetry/exceptions";

/** The `$` keys allowed to leave: the ingestion needs the first four,
 * `$geoip_disable` is what stops the server from deriving a location from the
 * request's IP, and `$exception_level` goes with an exception report (whose
 * `$exception_list` is kept only as `sanitizeExceptionList` cuts it). Every
 * other `$` key the SDK adds on its own is dropped. */
const KEEP = new Set(["token", "distinct_id", "$process_person_profile", "$lib", "$lib_version", "$geoip_disable", "$exception_level"]);

export function scrubEvent<E extends { properties: Record<string, unknown> }>(event: E): E {
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event.properties)) if (KEEP.has(key) || !key.startsWith("$")) properties[key] = value;
  // An exception report keeps its list, cut back to what it may carry.
  const exceptions = sanitizeExceptionList(event.properties.$exception_list);
  if (exceptions !== undefined) properties.$exception_list = exceptions;
  return { ...event, properties, $set: undefined, $set_once: undefined };
}
