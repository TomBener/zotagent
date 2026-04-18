// Uses the compact t→cn subpath bundle (~69 KB) instead of the 1 MB full bundle,
// since we only need traditional → simplified folding for search normalization.
import { Converter } from "opencc-js/t2cn";

const HAN_RE = /\p{Script=Han}/u;

let converter: ((text: string) => string) | null = null;

function getConverter(): (text: string) => string {
  if (converter === null) {
    converter = Converter({ from: "t", to: "cn" });
  }
  return converter;
}

export function toSimplified(text: string): string {
  if (text.length === 0 || !HAN_RE.test(text)) return text;
  return getConverter()(text);
}
