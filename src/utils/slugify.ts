// Turkish → Latin transliteration map (handles sephora.com.tr product names)
const TR_MAP: Record<string, string> = {
  ğ: "g", Ğ: "g",
  ş: "s", Ş: "s",
  ı: "i", İ: "i",
  ö: "o", Ö: "o",
  ü: "u", Ü: "u",
  ç: "c", Ç: "c",
  â: "a", Â: "a",
  î: "i", Î: "i",
  û: "u", Û: "u",
};

function transliterate(text: string): string {
  return text.replace(/[ğĞşŞıİöÖüÜçÇâÂîÎûÛ]/g, (ch) => TR_MAP[ch] ?? ch);
}

export function slugify(text: string): string {
  return transliterate(text)
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

export function uniqueSlug(base: string, id: string): string {
  return `${slugify(base)}-${id.slice(0, 8)}`;
}
