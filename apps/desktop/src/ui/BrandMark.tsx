const mascot = new URL("../../assets/brand/atte-mascot-baseline-512.png", import.meta.url).href;
const icon = new URL("../../assets/brand/atte-icon-baseline-128.png", import.meta.url).href;

export function BrandMark({
  variant = "mascot",
  decorative = false,
}: {
  variant?: "mascot" | "icon";
  decorative?: boolean;
}) {
  return <img src={variant === "mascot" ? mascot : icon} alt={decorative ? "" : "Atte"} />;
}
