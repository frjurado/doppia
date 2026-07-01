/**
 * Strip a work's catalogue number from the tail of its title when the title
 * already embeds it (the DCML corpus-prep convention: e.g. title
 * "Piano Sonata No. 11 in A major, K. 331" with catalogue_number "K. 331").
 *
 * Browse surfaces render the catalogue number as its own field/badge
 * alongside the title; without stripping, the catalogue appears twice
 * (Component 9 issue J2). Titles that don't embed the catalogue number are
 * returned unchanged.
 */
export function stripEmbeddedCatalogue(
  title: string,
  catalogueNumber: string | null | undefined
): string {
  if (!catalogueNumber) return title;
  for (const suffix of [`, ${catalogueNumber}`, ` ${catalogueNumber}`]) {
    if (title.endsWith(suffix)) return title.slice(0, -suffix.length);
  }
  return title;
}
