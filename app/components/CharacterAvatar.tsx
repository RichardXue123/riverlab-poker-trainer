"use client";

import { useState } from "react";
import { DEFAULT_AVATAR_PLACEHOLDER } from "@/lib/poker/chaos-avatars";

export interface CharacterAvatarProps {
  src?: string;
  name?: string;
  fallbackText?: string;
  themeColor?: string;
  size?: "xs" | "sm" | "md" | "lg" | "xl" | "2xl";
  shape?: "circle" | "rounded";
  showBorder?: boolean;
  glow?: boolean;
  className?: string;
  title?: string;
}

const SIZE_MAP = {
  xs: { size: 28, fontSize: 13 },
  sm: { size: 44, fontSize: 16 },
  md: { size: 54, fontSize: 20 },
  lg: { size: 72, fontSize: 26 },
  xl: { size: 116, fontSize: 40 },
  "2xl": { size: 144, fontSize: 48 },
};

export default function CharacterAvatar({
  src,
  name = "角色",
  fallbackText,
  themeColor = "#38bdf8",
  size = "md",
  shape = "circle",
  showBorder = true,
  glow = true,
  className = "",
  title,
}: CharacterAvatarProps) {
  const [loadError, setLoadError] = useState(false);
  const dim = SIZE_MAP[size] || SIZE_MAP.md;
  const initialLetter = fallbackText || name.slice(0, 1) || "侠";
  const avatarSrc = src || DEFAULT_AVATAR_PLACEHOLDER;

  const containerStyle: React.CSSProperties = {
    width: `${dim.size}px`,
    height: `${dim.size}px`,
    borderRadius: shape === "circle" ? "50%" : "12px",
    borderColor: showBorder ? themeColor : "transparent",
    boxShadow: glow && showBorder ? `0 0 12px ${themeColor}66, 0 4px 10px rgba(0,0,0,0.5)` : undefined,
  };

  return (
    <div
      className={`char-avatar-wrapper size-${size} ${shape} ${className}`}
      style={containerStyle}
      title={title || name}
    >
      {!loadError && avatarSrc ? (
        <img
          src={avatarSrc}
          alt={name}
          className="char-avatar-image"
          onError={() => setLoadError(true)}
        />
      ) : (
        <div
          className="char-avatar-fallback-placeholder"
          style={{
            background: `radial-gradient(circle at 35% 35%, ${themeColor}cc 0%, #0f172a 90%)`,
            fontSize: `${dim.fontSize}px`,
          }}
        >
          <span className="char-fallback-letter">{initialLetter}</span>
        </div>
      )}
    </div>
  );
}
