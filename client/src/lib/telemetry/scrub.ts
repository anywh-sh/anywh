/** The `$` keys allowed to leave: the ingestion needs the first four, and
 * `$geoip_disable` is what stops the server from deriving a location from the
 * request's IP. Every other `$` key the SDK adds on its own is dropped. */
const KEEP = new Set(["token", "distinct_id", "$process_person_profile", "$lib", "$lib_version", "$geoip_disable"]);

export function scrubEvent<E extends { properties: Record<string, unknown> }>(event: E): E {
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event.properties)) if (KEEP.has(key) || !key.startsWith("$")) properties[key] = value;
  return { ...event, properties, $set: undefined, $set_once: undefined };
}
