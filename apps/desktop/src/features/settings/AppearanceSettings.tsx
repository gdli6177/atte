import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Button, ChoiceGroup, SettingsSection } from "../../ui/index.js";

export function AppearanceSettings({
  theme,
  onSave,
}: {
  theme: string;
  onSave: (theme: string) => void;
}) {
  const [draft, setDraft] = useState(theme);
  useEffect(() => setDraft(theme), [theme]);
  const dirty = draft !== theme;
  return (
    <SettingsSection
      icon={theme === "dark" ? <Moon /> : <Sun />}
      title="外观"
      description="选择深色或浅色，保存后应用到整个界面。"
    >
      <p className="settings-status">当前：{theme === "dark" ? "深色" : "浅色"}</p>
      <ChoiceGroup
        label="界面主题"
        value={draft}
        options={[{ value: "dark", label: "深色" }, { value: "light", label: "浅色" }]}
        onChange={setDraft}
      />
      <div className="ui-settings-card__actions">
        <Button size="sm" disabled={!dirty} onClick={() => onSave(draft)}>保存外观</Button>
        <span className="settings-status" role="status">{dirty ? "有未保存的更改" : "已保存"}</span>
      </div>
    </SettingsSection>
  );
}
