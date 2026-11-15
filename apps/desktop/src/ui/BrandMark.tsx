const mark = new URL("../../assets/brand/atte-mark.svg", import.meta.url).href;
const markReversed = new URL("../../assets/brand/atte-mark-reversed.svg", import.meta.url).href;
const mascot = new URL("../../assets/brand/atte-mascot-armored.png", import.meta.url).href;
const icon = new URL("../../assets/brand/atte-app-icon-128.png", import.meta.url).href;

export function BrandMark({
  variant = "mark",
  decorative = false,
}: {
  variant?: "mark" | "mascot" | "icon";
  decorative?: boolean;
}) {
  const alt = decorative ? "" : "Atte";
  if (variant === "mascot") return <img className="brand-mascot" src={mascot} alt={alt} />;
  if (variant === "icon") return <img src={icon} alt={alt} />;
  return (
    <span className="brand-mark">
      <img className="brand-mark-on-light" src={mark} alt={alt} />
      <img className="brand-mark-on-dark" src={markReversed} alt={alt} />
    </span>
  );
}
