import { SeededRng } from "./rng";
import type { BotPersonality, BotViewState } from "./types";

export interface BotLinePlan {
  pressure: number;
  trap: number;
  polarization: number;
  carriedAggression: boolean;
  aggressiveStreets: number;
  coherentBluffMultiplier: number;
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Produces a stable intention for one bot and one hand. The plan never sees another
 * player's cards or the future deck; it only makes later actions tell a coherent story.
 */
export function buildBotLinePlan(view: BotViewState, personality: BotPersonality): BotLinePlan {
  const rng = new SeededRng(`${view.handId}-${view.viewerId}-line-plan`);
  const priorAggressiveStreets = new Set(
    view.actionLog
      .filter((action) => action.playerId === view.viewerId
        && action.street !== "preflop"
        && action.street !== view.street
        && ["bet", "raise", "all-in"].includes(action.type))
      .map((action) => action.street),
  );
  const carriedAggression = priorAggressiveStreets.size > 0;
  const checkedTo = view.legalActions.toCall === 0 && view.actionLog.some((action) => action.street === view.street
    && action.playerId !== view.viewerId
    && action.type === "check");
  const pressure = clamp(personality.aggression * 0.46 + personality.bluff * 0.28 + personality.risk * 0.12 + rng.between(-0.12, 0.12));
  const trap = clamp(personality.trapping * 0.68 + (1 - personality.aggression) * 0.14 + rng.between(-0.10, 0.10));
  const polarization = clamp(personality.bluff * 0.42 + personality.sizing * 0.28 + pressure * 0.22 + rng.between(-0.10, 0.10));
  const storyBonus = carriedAggression ? 0.20 + Math.min(0.18, priorAggressiveStreets.size * 0.09) : 0;
  const stabBonus = checkedTo ? 0.12 : 0;
  const coherentBluffMultiplier = clamp(0.66 + pressure * 0.38 + storyBonus + stabBonus, 0.62, 1.38);

  return {
    pressure,
    trap,
    polarization,
    carriedAggression,
    aggressiveStreets: priorAggressiveStreets.size,
    coherentBluffMultiplier,
  };
}