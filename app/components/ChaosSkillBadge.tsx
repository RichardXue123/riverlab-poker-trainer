"use client";

import type { ChaosSkill, PlayerSkillStatus } from "@/lib/poker/chaos-types";

export interface ChaosSkillBadgeProps {
  skill: ChaosSkill;
  status?: PlayerSkillStatus;
  interactive?: boolean;
  size?: "sm" | "md" | "lg";
  onTrigger?: (skill: ChaosSkill) => void;
  className?: string;
}

export default function ChaosSkillBadge({
  skill,
  status,
  interactive = false,
  size = "md",
  onTrigger,
  className = "",
}: ChaosSkillBadgeProps) {
  const isUsed = Boolean(status?.used);
  const isAvailable = Boolean(status?.available) && !isUsed;
  const isLocked = skill.type === "locked";
  const isLimited = skill.type === "limited";

  const isHandLimited = skill.frequency === "hand";
  const typeConfig = isLocked
    ? { label: "锁定技", icon: "🔒", color: "#10b981", bg: "rgba(16, 185, 129, 0.15)" }
    : isLimited
    ? { label: "限定技", icon: "🔥", color: "#f59e0b", bg: "rgba(245, 158, 11, 0.15)" }
    : { label: isHandLimited ? "每手一次" : "主动技", icon: "⚡", color: "#38bdf8", bg: "rgba(56, 189, 248, 0.15)" };

  const canClick = interactive && isAvailable && !isLocked && !isUsed;

  const handleClick = () => {
    if (canClick && onTrigger) {
      onTrigger(skill);
    }
  };

  return (
    <div
      className={`chaos-skill-badge-card size-${size} type-${skill.type} ${
        isUsed ? "skill-exhausted" : ""
      } ${isAvailable && !isLocked ? "skill-trigger-ready" : ""} ${className}`}
      onClick={canClick ? handleClick : undefined}
      title={`${skill.name}（${typeConfig.label}）\n时机：${skill.timingDescription}\n效果：${skill.description}`}
      role={canClick ? "button" : undefined}
      tabIndex={canClick ? 0 : undefined}
    >
      {/* Exhausted Stamp for Limited/Used Skills */}
      {isUsed && (
        <div className="skill-exhausted-stamp">
          <span>{isHandLimited ? "本手已用" : "已发动"}</span>
        </div>
      )}

      <div className="skill-badge-head">
        <span
          className="skill-type-pill"
          style={{ color: typeConfig.color, background: typeConfig.bg, borderColor: `${typeConfig.color}40` }}
        >
          {typeConfig.icon} {typeConfig.label}
        </span>
        <strong className="skill-badge-title">{skill.name}</strong>
        {skill.icon && <span className="skill-badge-icon">{skill.icon}</span>}
      </div>

      <p className="skill-badge-timing">{skill.timingDescription}</p>

      {size !== "sm" && <p className="skill-badge-desc">{skill.description}</p>}

      {/* Interactive Trigger Button when active in Hero Cockpit */}
      {interactive && !isLocked && (
        <div className="skill-badge-action-bar">
          {isUsed ? (
            <span className="skill-status-tag exhausted">
              {isHandLimited ? "✕ 本手已使用" : "✕ 本局已耗尽"}
            </span>
          ) : isAvailable ? (
            <button
              type="button"
              className="skill-trigger-btn"
              onClick={(e) => {
                e.stopPropagation();
                onTrigger?.(skill);
              }}
            >
              ⚡ 立即发动
            </button>
          ) : (
            <span className="skill-status-tag pending">待发动时机</span>
          )}
        </div>
      )}
    </div>
  );
}
