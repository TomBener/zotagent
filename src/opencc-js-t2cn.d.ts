declare module "opencc-js/t2cn" {
  export type Locale = "cn" | "tw" | "twp" | "hk" | "jp" | "t";
  export function Converter(options: { from?: Locale; to?: Locale }): (text: string) => string;
}
