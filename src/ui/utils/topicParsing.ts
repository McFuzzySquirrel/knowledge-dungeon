export function parseTopicBatch(input: string): string[] {
  const seen = new Set<string>();
  const topics: string[] = [];

  for (const raw of input
    .split('\n')
    .flatMap((line) => line.split(','))
    .map((item) => item.trim())
    .filter(Boolean)) {
    const key = raw.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    topics.push(raw);
  }

  return topics;
}
