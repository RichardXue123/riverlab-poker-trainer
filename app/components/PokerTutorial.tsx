"use client";

import React, { useState } from "react";

type TutorialCategory = "all" | "rankings" | "rules" | "tips";

interface MiniCardDef {
  rank: string;
  suit: "s" | "h" | "d" | "c";
}

interface HandRankItem {
  rank: number;
  name: string;
  en: string;
  badge?: string;
  description: string;
  tiebreaker: string;
  cards: MiniCardDef[];
}

const HAND_RANKS: HandRankItem[] = [
  {
    rank: 1,
    name: "皇家同花顺",
    en: "Royal Flush",
    badge: "绝世神牌",
    description: "同一花色的 A、K、Q、J、10，德州扑克中最顶级的无敌成牌。",
    tiebreaker: "同花色中最大的连续牌，出现即锁定绝对胜利。若公共牌出现则所有在场玩家平分底池。",
    cards: [
      { rank: "10", suit: "s" },
      { rank: "J", suit: "s" },
      { rank: "Q", suit: "s" },
      { rank: "K", suit: "s" },
      { rank: "A", suit: "s" },
    ],
  },
  {
    rank: 2,
    name: "同花顺",
    en: "Straight Flush",
    badge: "顶级牌型",
    description: "同一花色的任意五张连续牌（非 A-K-Q-J-10）。",
    tiebreaker: "多位玩家同成同花顺时，比较最大单张（如 9-8-7-6-5 大于 8-7-6-5-4；A-2-3-4-5 为最小同花顺）。",
    cards: [
      { rank: "9", suit: "h" },
      { rank: "8", suit: "h" },
      { rank: "7", suit: "h" },
      { rank: "6", suit: "h" },
      { rank: "5", suit: "h" },
    ],
  },
  {
    rank: 3,
    name: "四条 / 金刚",
    en: "Four of a Kind",
    badge: "强力强牌",
    description: "四张点数完全相同的牌，加上任意一张单牌。",
    tiebreaker: "先比四张相同牌的点数（如 4个K 大于 4个Q）；若公共牌为四条，比第 5 张踢脚单牌大小。",
    cards: [
      { rank: "K", suit: "s" },
      { rank: "K", suit: "h" },
      { rank: "K", suit: "d" },
      { rank: "K", suit: "c" },
      { rank: "9", suit: "s" },
    ],
  },
  {
    rank: 4,
    name: "葫芦 / 满堂红",
    en: "Full House",
    badge: "强力强牌",
    description: "三张同点数的牌 + 一对同点数的牌组合而成。",
    tiebreaker: "先比较三条的点数（如 J-J-J-8-8 大于 10-10-10-A-A）；若三条点数相同，再比对子的点数。",
    cards: [
      { rank: "J", suit: "s" },
      { rank: "J", suit: "h" },
      { rank: "J", suit: "d" },
      { rank: "8", suit: "c" },
      { rank: "8", suit: "d" },
    ],
  },
  {
    rank: 5,
    name: "同花",
    en: "Flush",
    description: "五张花色相同但点数不连续的牌。",
    tiebreaker: "由大到小依次比较单张点数（先比最大单牌，若相同再比第二大，以此类推）。注意：花色不分大小！",
    cards: [
      { rank: "A", suit: "d" },
      { rank: "J", suit: "d" },
      { rank: "8", suit: "d" },
      { rank: "6", suit: "d" },
      { rank: "3", suit: "d" },
    ],
  },
  {
    rank: 6,
    name: "顺子",
    en: "Straight",
    description: "五张点数连续但花色不完全相同的牌。",
    tiebreaker: "比较最高单张点数。A 既可作顶张（10-J-Q-K-A 为最大顺），也可作底张（A-2-3-4-5 为5高顺子）。",
    cards: [
      { rank: "9", suit: "c" },
      { rank: "8", suit: "s" },
      { rank: "7", suit: "d" },
      { rank: "6", suit: "h" },
      { rank: "5", suit: "s" },
    ],
  },
  {
    rank: 7,
    name: "三条 / 暗三 / 明三",
    en: "Three of a Kind",
    description: "三张点数相同的牌，加上两张不成对的单牌。",
    tiebreaker: "先比三条的点数（如 Q-Q-Q 大于 J-J-J）；点数相同则依次比第 1 张和第 2 张踢脚牌。",
    cards: [
      { rank: "Q", suit: "s" },
      { rank: "Q", suit: "h" },
      { rank: "Q", suit: "d" },
      { rank: "7", suit: "c" },
      { rank: "4", suit: "s" },
    ],
  },
  {
    rank: 8,
    name: "两对",
    en: "Two Pair",
    description: "包含两个不同点数的对子，加上一张单牌。",
    tiebreaker: "先比大对子（AA-88 胜 KK-QQ）；若大对相同比小对子；若两对都相同，比第 5 张踢脚牌。",
    cards: [
      { rank: "A", suit: "s" },
      { rank: "A", suit: "d" },
      { rank: "8", suit: "c" },
      { rank: "8", suit: "h" },
      { rank: "K", suit: "s" },
    ],
  },
  {
    rank: 9,
    name: "一对",
    en: "One Pair",
    description: "两张点数相同的牌，加上三张不成对的单牌。",
    tiebreaker: "先比对子大小（10-10 大于 9-9）；对子相同则依次比较第 1、第 2、第 3 张踢脚牌。",
    cards: [
      { rank: "10", suit: "s" },
      { rank: "10", suit: "h" },
      { rank: "K", suit: "d" },
      { rank: "8", suit: "c" },
      { rank: "4", suit: "s" },
    ],
  },
  {
    rank: 10,
    name: "高牌",
    en: "High Card",
    description: "五张牌无法组成上述任何成牌，全为散牌。",
    tiebreaker: "从最大单牌开始依次比大小（A > K > Q > J > 10...），直到分出胜负。",
    cards: [
      { rank: "A", suit: "s" },
      { rank: "Q", suit: "d" },
      { rank: "9", suit: "c" },
      { rank: "7", suit: "h" },
      { rank: "2", suit: "s" },
    ],
  },
];

const SUIT_UNICODE: Record<string, string> = {
  s: "♠",
  h: "♥",
  d: "♦",
  c: "♣",
};

function MiniCard({ rank, suit }: MiniCardDef) {
  const isRed = suit === "h" || suit === "d";
  return (
    <span className={`tutorial-card ${isRed ? "card-red" : "card-black"}`}>
      <span className="tc-rank">{rank}</span>
      <span className="tc-suit">{SUIT_UNICODE[suit]}</span>
    </span>
  );
}

export function PokerTutorial() {
  const [category, setCategory] = useState<TutorialCategory>("all");

  return (
    <div className="tutorial-panel">
      <div className="tutorial-header">
        <h3>德州扑克上手指南</h3>
        <p>规则简明透彻 · 牌型从大到小全览</p>
      </div>

      <div className="tutorial-filters">
        <button
          type="button"
          className={category === "all" ? "active" : ""}
          onClick={() => setCategory("all")}
        >
          全部
        </button>
        <button
          type="button"
          className={category === "rankings" ? "active" : ""}
          onClick={() => setCategory("rankings")}
        >
          🏆 牌型大小
        </button>
        <button
          type="button"
          className={category === "rules" ? "active" : ""}
          onClick={() => setCategory("rules")}
        >
          📖 核心规则
        </button>
        <button
          type="button"
          className={category === "tips" ? "active" : ""}
          onClick={() => setCategory("tips")}
        >
          ⚖️ 比牌铁律
        </button>
      </div>

      <div className="tutorial-body">
        {/* 牌型大小从强到弱 */}
        {(category === "all" || category === "rankings") && (
          <section className="tutorial-section">
            <div className="section-title">
              <h4>🏆 牌型从强到弱排行 (10大成牌)</h4>
              <span className="section-hint">序号越小牌型越强 · #1 为最强</span>
            </div>
            <div className="hand-ranks-list">
              {HAND_RANKS.map((item) => (
                <div
                  key={item.rank}
                  className={`hand-rank-card ${item.rank <= 3 ? "rank-top" : ""}`}
                >
                  <div className="hr-header">
                    <span className={`hr-rank-pill rank-${item.rank}`}>#{item.rank}</span>
                    <div className="hr-names">
                      <strong>{item.name}</strong>
                      <small>{item.en}</small>
                    </div>
                    {item.badge && <span className="hr-badge">{item.badge}</span>}
                  </div>

                  <div className="hr-cards">
                    {item.cards.map((c, i) => (
                      <MiniCard key={i} rank={c.rank} suit={c.suit} />
                    ))}
                  </div>

                  <p className="hr-desc">{item.description}</p>
                  <div className="hr-tiebreaker">
                    <em>比牌要点：</em>
                    <span>{item.tiebreaker}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* 核心规则 */}
        {(category === "all" || category === "rules") && (
          <section className="tutorial-section">
            <div className="section-title">
              <h4>📖 德州扑克核心玩法与流程</h4>
            </div>

            <article className="tutorial-card-block">
              <header>
                <span className="block-icon">🎯</span>
                <strong>游戏目标：赢取底池</strong>
              </header>
              <p>
                每位玩家的目标是通过让所有对手弃牌 (Fold)，或者在最后的摊牌 (Showdown)
                中亮出比所有对手更强的 5 张牌组合，赢取底池中的全部筹码。
              </p>
            </article>

            <article className="tutorial-card-block">
              <header>
                <span className="block-icon">🎴</span>
                <strong>手牌构成：7 选 5 最佳法则</strong>
              </header>
              <p>
                每局每位玩家分得 <b>2 张私密底牌</b> (仅自己可见)。牌桌中央陆续翻出 <b>5 张公开公共牌</b>。
              </p>
              <div className="rule-badge-group">
                <span>2底牌 + 3公共牌</span>
                <span>1底牌 + 4公共牌</span>
                <span>0底牌 + 5公共牌(走板)</span>
              </div>
              <small>
                玩家可从这 7 张牌中自由任意取 5 张组成最强牌型，与对手比拼。
              </small>
            </article>

            <article className="tutorial-card-block">
              <header>
                <span className="block-icon">🔄</span>
                <strong>四个下注轮次</strong>
              </header>
              <ul className="street-flow">
                <li>
                  <b>1. 翻牌前 (Preflop)</b>
                  <p>发 2 张底牌，大小盲注强制投入，从大盲注左侧 (UTG) 顺时针开始轮流表态。</p>
                </li>
                <li>
                  <b>2. 翻牌圈 (Flop)</b>
                  <p>发出前 3 张公共牌，开启第二轮下注，从小盲位/在场最左侧玩家开始行动。</p>
                </li>
                <li>
                  <b>3. 转牌圈 (Turn)</b>
                  <p>发出第 4 张公共牌，开启第三轮下注。</p>
                </li>
                <li>
                  <b>4. 河牌圈 (River)</b>
                  <p>发出第 5 张最后公共牌，开启终局下注。</p>
                </li>
                <li>
                  <b>5. 摊牌比牌 (Showdown)</b>
                  <p>河牌下注后仍有 2 位或更多玩家未弃牌时，亮牌决出赢家。</p>
                </li>
              </ul>
            </article>

            <article className="tutorial-card-block">
              <header>
                <span className="block-icon">⚡</span>
                <strong>玩家行动选项 (Actions)</strong>
              </header>
              <div className="action-guide-grid">
                <div>
                  <b className="act-fold">弃牌 Fold</b>
                  <span>放弃底牌与已投筹码，退出该手。</span>
                </div>
                <div>
                  <b className="act-check">过牌 Check</b>
                  <span>当前无人下注时，不投筹码让给下家。</span>
                </div>
                <div>
                  <b className="act-call">跟注 Call</b>
                  <span>匹配当前最高下注额，继续留局。</span>
                </div>
                <div>
                  <b className="act-bet">下注 Bet</b>
                  <span>本轮此前无人下注时，率先放入筹码。</span>
                </div>
                <div>
                  <b className="act-raise">加注 Raise</b>
                  <span>前面有人下注时，投入更多筹码抬高下注。</span>
                </div>
                <div>
                  <b className="act-allin">全下 All-In</b>
                  <span>押上全部剩余筹码，决一死战。</span>
                </div>
              </div>
            </article>
          </section>
        )}

        {/* 比牌铁律与新手常犯误区 */}
        {(category === "all" || category === "tips") && (
          <section className="tutorial-section">
            <div className="section-title">
              <h4>⚖️ 德州比牌四大铁律</h4>
              <span className="section-hint">新手必记避免踩坑</span>
            </div>

            <article className="iron-rule-card">
              <div className="ir-title">
                <span className="ir-num">1</span>
                <strong>花色完全平权，绝无大小之分</strong>
              </div>
              <p>
                德州扑克中 <b>♠ 黑桃、♥ 红桃、♣ 梅花、♦ 方块</b> 地位完全一致，绝不存在
                “黑桃大过红桃”。若成牌点数完全一样，<b>必须平分底池 (Split Pot)</b>。
              </p>
            </article>

            <article className="iron-rule-card">
              <div className="ir-title">
                <span className="ir-num">2</span>
                <strong>永远只看最强 5 张牌</strong>
              </div>
              <p>
                第 6 张、第 7 张多余的牌完全不参与比牌！比如两人都是四条 K，桌面单牌为 A，
                两人成牌都是 K-K-K-K-A，即使你手握一张 Q 也无济于事，依然平分底池。
              </p>
            </article>

            <article className="iron-rule-card">
              <div className="ir-title">
                <span className="ir-num">3</span>
                <strong>踢脚牌 (Kickers) 决定胜负</strong>
              </div>
              <p>
                当核心成牌点数相同时（例如双方都是一对 A），由剩余未配对单牌中最大的牌决定胜负。
                如 A-A-K-9-4 胜过 A-A-Q-J-10（K 踢脚大于 Q 踢脚）。
              </p>
            </article>

            <article className="iron-rule-card">
              <div className="ir-title">
                <span className="ir-num">4</span>
                <strong>位置就是力量 (Position is Power)</strong>
              </div>
              <p>
                按钮位 (庄家/BTN) 在翻牌后永远最后行动，能看到前面所有人的决策后再做选择；
                小盲/大盲位翻牌后率先行动，信息最少劣势最大。学会利用位置优势施压！
              </p>
            </article>
          </section>
        )}
      </div>
    </div>
  );
}
