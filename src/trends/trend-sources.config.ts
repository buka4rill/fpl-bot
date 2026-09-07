// Explicit, curated whitelist of consensus / rank-tracker sources.
// Deliberately not open-ended scraping — add sources here one at a time,
// and TrendsService should degrade gracefully if one is unreachable.
export interface TrendSource {
  name: string;
  url: string;
}

export const TREND_SOURCES: TrendSource[] = [
  // TODO: populate with agreed-upon sources.
];
