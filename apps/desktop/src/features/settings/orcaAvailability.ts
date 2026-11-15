import type { BackendControlStatus } from "../../api.js";

export function orcaAvailability(detection: BackendControlStatus["orca"]["detection"]) {
  switch (detection.status) {
    case "compatible":
      return { available: true, label: "可切换", detail: "已通过本版兼容检测。" };
    case "missing":
      return {
        available: false,
        label: "先安装",
        detail: "未找到 Orca，请先在下方安装或选择已有应用。",
      };
    case "unverified":
      return {
        available: false,
        label: "已安装 · 待验证",
        detail: `Orca ${detection.version ?? "当前版本"} 已安装，尚未通过本版兼容验证。请在下方重新检测，或选择已验证版本。`,
      };
    case "incompatible":
      return {
        available: false,
        label: "安装需修复",
        detail: `Orca 安装需要修复。${detection.detail ?? "请在下方重新检测或选择已有应用。"}`,
      };
  }
}
