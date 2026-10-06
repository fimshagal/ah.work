/**
 * Create a monotonic id generator with a given prefix.
 * Each runtime/pool uses its own generator so ids are unique per instance.
 */
export function createIdGenerator(prefix: string): () => string {
  let counter = 0;
  return () => `${prefix}_${++counter}`;
}
