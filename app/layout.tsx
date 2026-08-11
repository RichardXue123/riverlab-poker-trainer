import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("http://localhost:4311"),
  title: "RiverLab 德扑训练室",
  description: "本地离线、无真钱、无作弊的八人桌德州扑克训练器。",
  openGraph: {
    title: "RiverLab 德扑训练室",
    description: "八人桌 · 个性 AI · 第一视角教学 · 完全离线",
    images: [{ url: "/og.png", width: 1738, height: 907, alt: "RiverLab 八人桌德扑训练器" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "RiverLab 德扑训练室",
    description: "八人桌 · 个性 AI · 第一视角教学 · 完全离线",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
