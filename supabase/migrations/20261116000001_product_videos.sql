-- Short silent clips of a product (a tap running, a shower head on), played on its card and page.
-- Links to MP4 or WebM files, kept in the public product-videos bucket (next migration) under videos/.
alter table public.products
  add column videos text[] not null default '{}' check (cardinality(videos) <= 3);
comment on column public.products.videos is 'Up to 3 short silent product clips (MP4/WebM links), shown before the photos.';
