import type { BackendControlStatus } from "../../api.js";

export function orcaAvailability(detection: BackendControlStatus["orca"]["detection"]) {
  switch (detection.status) {
    case "compatible":
      return { available: true, label: "可切换", detail: detection.detail ?? "应用与接口检查通过。" };
    case "missing":
      return {
        available: false,
        label: "先安装",
        detail: "未找到 Orca，请先在下方安装或选择已有应用。",
      };
    case "unverified":
      return {
        available: false,
        label: "已安装 · 待检测",
        detail: detection.detail ?? "Orca 已安装，尚未完成命令行接口检测，请点击“重新检测”后重试。",
      };
    case "incompatible":
      return {
        available: false,
        label: "检测未通过",
        detail: detection.detail ?? "Orca 应用或接口检查未通过，请重新检测或选择其他官方应用。",
      };
  }
}
