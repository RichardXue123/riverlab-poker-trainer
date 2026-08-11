import type { Metadata } from "next";
import PokerTrainer from "./components/PokerTrainer";

export const metadata: Metadata = {
  title: "RiverLab 德扑训练室",
  description: "完全离线的八人桌德州扑克训练器，包含第一视角教学、赛后复盘与个性化 AI。",
};

export default function Home() {
  return <PokerTrainer />;
}
