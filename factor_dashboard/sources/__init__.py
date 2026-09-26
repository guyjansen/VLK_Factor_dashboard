"""Fetchers for each public data source. Every fetcher returns pandas objects
indexed by date and raises on failure; the build step decides on fallbacks."""
