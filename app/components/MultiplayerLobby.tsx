"use client";

import { useEffect, useState } from "react";
import type { MultiplayerTableState, RoomConfig, RoomSummary } from "@/server/multiplayer-types";

interface MultiplayerLobbyProps {
  state: MultiplayerTableState | null;
  connected: boolean;
  lanIps: string[];
  port: number;
  playerName: string;
  roomList: RoomSummary[];
  onSetName: (name: string) => void;
  onCreateRoom: (config?: Partial<RoomConfig>) => void;
  onJoinRoom: (code: string, asSpectator?: boolean) => void;
  onLeaveRoom: () => void;
  onTakeSeat: (index: number) => void;
  onStandUp: () => void;
  onToggleReady: () => void;
  onStartGame: () => void;
  onRefreshRooms: () => void;
  initialRoomCode?: string;
}

export default function MultiplayerLobby({
  state,
  connected,
  lanIps,
  port,
  playerName,
  roomList,
  onSetName,
  onCreateRoom,
  onJoinRoom,
  onLeaveRoom,
  onTakeSeat,
  onStandUp,
  onToggleReady,
  onStartGame,
  onRefreshRooms,
  initialRoomCode,
}: MultiplayerLobbyProps) {
  const [inputCode, setInputCode] = useState(initialRoomCode ?? "");
  const [asSpectator, setAsSpectator] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameVal, setNameVal] = useState(playerName);
  const [copySuccess, setCopySuccess] = useState(false);

  // Room config state for creation
  const [smallBlind, setSmallBlind] = useState(5);
  const [bigBlind, setBigBlind] = useState(10);
  const [startingStack, setStartingStack] = useState(1000);
  const [minPlayers, setMinPlayers] = useState(4);
  const [regularTurnSeconds, setRegularTurnSeconds] = useState(20);
  const [initialTimeBankCards, setInitialTimeBankCards] = useState(2);

  useEffect(() => {
    setNameVal(playerName);
  }, [playerName]);

  useEffect(() => {
    if (initialRoomCode) {
      setInputCode(initialRoomCode);
    }
  }, [initialRoomCode]);

  const saveName = () => {
    const trimmed = nameVal.trim().slice(0, 16);
    if (trimmed && trimmed !== playerName) {
      onSetName(trimmed);
    }
    setEditingName(false);
  };

  const copyInviteLink = (code: string) => {
    const hostIp = lanIps[0] ?? (typeof window !== "undefined" ? window.location.hostname : "localhost");
    const portStr = port ? `:${port}` : "";
    const url = `http://${hostIp}${portStr}?room=${code}`;
    void navigator.clipboard.writeText(url).then(() => {
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2500);
    });
  };

  const handleCreateRoomClick = () => {
    const trimmed = nameVal.trim().slice(0, 16);
    if (trimmed && trimmed !== playerName) {
      onSetName(trimmed);
      setEditingName(false);
    }
    onCreateRoom({
      smallBlind,
      bigBlind,
      startingStack,
      minPlayers,
      regularTurnSeconds,
      initialTimeBankCards,
      timeBankExtensionSeconds: regularTurnSeconds,
    });
  };

  const handleJoinRoomClick = () => {
    if (!inputCode.trim()) return;
    const trimmed = nameVal.trim().slice(0, 16);
    if (trimmed && trimmed !== playerName) {
      onSetName(trimmed);
      setEditingName(false);
    }
    onJoinRoom(inputCode.trim().toUpperCase(), asSpectator);
  };

  // If in a room waiting in lobby
  if (state && state.status === "lobby") {
    const mySeat = state.seats.find((s) => s.id === state.myId);
    const seatedCount = state.seats.filter((s) => s.id && !s.id.startsWith("empty-")).length;
    const readyCount = state.seats.filter((s) => s.id && !s.id.startsWith("empty-") && (s.isHost || s.isReady)).length;

    return (
      <div className="mp-lobby-container">
        <header className="mp-header">
          <div className="mp-header-left">
            <span className="mp-badge">房间号</span>
            <strong className="mp-room-code">{state.roomCode}</strong>
            <span className="mp-tag">{state.smallBlind}/{state.bigBlind} 盲注</span>
            <span className="mp-tag">筹码 {state.config.startingStack}</span>
            <span className="mp-tag">⏱️ 思考 {state.config.regularTurnSeconds}s / 步</span>
            <span className="mp-tag">⏳ 延时卡 {state.config.initialTimeBankCards} 张 (+30s)</span>
          </div>
          <div className="mp-header-right">
            <button
              type="button"
              className="mp-btn mp-btn-secondary"
              onClick={() => copyInviteLink(state.roomCode)}
            >
              {copySuccess ? "✓ 已复制邀请链接" : "📋 复制局域网邀请链接"}
            </button>
            <button type="button" className="mp-btn mp-btn-danger" onClick={onLeaveRoom}>
              离开房间
            </button>
          </div>
        </header>

        <section className="mp-room-status-bar">
          <div className="mp-status-pill">
            <span>在座玩家</span>
            <b>{seatedCount} / 8 人</b>
          </div>
          <div className="mp-status-pill">
            <span>准备状态</span>
            <b>{readyCount} / {seatedCount} 就绪</b>
          </div>
          <div className="mp-status-pill">
            <span>观战人数</span>
            <b>{state.spectators.length} 人</b>
          </div>
        </section>

        {/* Start Game eligibility prompt */}
        {!state.canStartGame && (
          <div className="mp-alert-box mp-alert-warning">
            <span className="mp-alert-icon">⚠️</span>
            <div>
              <strong>开局条件未达成</strong>
              <p>{state.cannotStartReason || "需要至少 4 名玩家且全部准备就绪。"}</p>
            </div>
          </div>
        )}

        {state.canStartGame && (
          <div className="mp-alert-box mp-alert-success">
            <span className="mp-alert-icon">🎉</span>
            <div>
              <strong>全员准备完毕！</strong>
              <p>所有在座玩家已准备好，等待房主开启牌局。</p>
            </div>
          </div>
        )}

        {/* Seated players list */}
        <section className="mp-seats-grid">
          {state.seats.map((seat, index) => {
            const isEmpty = !seat.id || seat.id.startsWith("empty-");
            const isMe = seat.id === state.myId;

            if (isEmpty) {
              return (
                <div key={index} className="mp-seat-card mp-seat-empty">
                  <div className="mp-seat-num">座位 {index + 1}</div>
                  <div className="mp-empty-label">空位</div>
                  {state.isSpectator && (
                    <button
                      type="button"
                      className="mp-btn mp-btn-sm mp-btn-primary"
                      onClick={() => onTakeSeat(index)}
                    >
                      入座此位
                    </button>
                  )}
                </div>
              );
            }

            return (
              <div
                key={index}
                className={`mp-seat-card ${isMe ? "mp-seat-me" : ""} ${seat.isHost ? "mp-seat-host" : ""}`}
              >
                <div className="mp-seat-header">
                  <span className="mp-seat-num">#{index + 1}</span>
                  {seat.isHost ? (
                    <span className="mp-role-badge mp-role-host">👑 房主</span>
                  ) : seat.isReady ? (
                    <span className="mp-role-badge mp-role-ready">✓ 已准备</span>
                  ) : (
                    <span className="mp-role-badge mp-role-waiting">⏳ 未准备</span>
                  )}
                </div>
                <strong className="mp-seat-name">{seat.name} {isMe && "(我)"}</strong>
                <div className="mp-seat-chips">💰 {seat.stack} 筹码</div>
                <div className="mp-seat-timebank">⏱️ 延时卡: {seat.timeBankCards} 张</div>
                {isMe && !seat.isHost && (
                  <button
                    type="button"
                    className="mp-btn mp-btn-sm mp-btn-secondary mp-btn-stand"
                    onClick={onStandUp}
                  >
                    离座观战
                  </button>
                )}
              </div>
            );
          })}
        </section>

        {/* Action bar for user */}
        <footer className="mp-action-footer">
          {state.isHost ? (
            <div className="mp-host-controls">
              <button
                type="button"
                className={`mp-btn mp-btn-lg mp-btn-start ${state.canStartGame ? "mp-btn-glowing" : "mp-btn-disabled"}`}
                disabled={!state.canStartGame}
                onClick={onStartGame}
              >
                {state.canStartGame ? "🚀 开启牌局 (全员就绪)" : "⏳ 等待全员准备就绪..."}
              </button>
            </div>
          ) : mySeat ? (
            <div className="mp-player-controls">
              <button
                type="button"
                className={`mp-btn mp-btn-lg ${mySeat.isReady ? "mp-btn-cancel-ready" : "mp-btn-ready"}`}
                onClick={onToggleReady}
              >
                {mySeat.isReady ? "✕ 取消准备" : "✓ 准备就绪"}
              </button>
            </div>
          ) : (
            <div className="mp-spectator-controls">
              <span className="mp-spectator-note">👀 你当前是旁观者，点击上方任意「入座此位」即可加入对局</span>
            </div>
          )}
        </footer>

        {/* Spectator list */}
        {state.spectators.length > 0 && (
          <section className="mp-spectator-list">
            <h4>旁观席 ({state.spectators.length})</h4>
            <div className="mp-spectator-tags">
              {state.spectators.map((s) => (
                <span key={s.id} className="mp-spectator-tag">
                  {s.name} {s.id === state.myId && "(我)"}
                </span>
              ))}
            </div>
          </section>
        )}
      </div>
    );
  }

  // Not in a room: Lobby view (create room / join room / room list)
  return (
    <div className="mp-lobby-container">
      <header className="mp-lobby-hero">
        <div className="brand-lockup">
          <span className="brand-mark">🌐</span>
          <div>
            <strong>RiverLab</strong>
            <span>局域网多人对战大厅</span>
          </div>
        </div>
        <div className="mp-lan-status">
          <span className={`mp-status-dot ${connected ? "online" : "offline"}`} />
          <span>{connected ? "局域网服务在线" : "正在连接局域网服务..."}</span>
        </div>
      </header>

      {/* LAN IP & Player Name Card */}
      <section className="mp-profile-strip">
        <div className="mp-name-box">
          <span>当前昵称：</span>
          {editingName ? (
            <div className="mp-inline-edit">
              <input
                type="text"
                value={nameVal}
                maxLength={16}
                onChange={(e) => setNameVal(e.target.value)}
                onBlur={saveName}
                onKeyDown={(e) => e.key === "Enter" && saveName()}
                placeholder="输入你的昵称"
                autoFocus
              />
              <button type="button" className="mp-btn mp-btn-sm mp-btn-primary" onClick={saveName}>
                确定
              </button>
            </div>
          ) : (
            <div className="mp-inline-name">
              <strong>{playerName}</strong>
              <button
                type="button"
                className="mp-btn-link"
                onClick={() => {
                  setNameVal(playerName);
                  setEditingName(true);
                }}
              >
                ✏️ 修改
              </button>
            </div>
          )}
        </div>

        <div className="mp-lan-ip-box">
          <span>局域网联机 IP：</span>
          <code>
            {lanIps.length > 0 ? `http://${lanIps[0]}:${port}` : `http://localhost:${port}`}
          </code>
          <button
            type="button"
            className="mp-btn-link"
            onClick={() => {
              const url = `http://${lanIps[0] || "localhost"}:${port}`;
              void navigator.clipboard.writeText(url);
              setCopySuccess(true);
              setTimeout(() => setCopySuccess(false), 2000);
            }}
          >
            {copySuccess ? "✓ 已复制" : "复制"}
          </button>
        </div>
      </section>

      <div className="mp-grid-cards">
        {/* Card 1: Create Room */}
        <div className="mp-card">
          <div className="mp-card-head">
            <span className="mp-icon">🏠</span>
            <div>
              <h3>创建新房间</h3>
              <p>你将成为房主，可配置盲注规则，4-8人全员准备即可开局</p>
            </div>
          </div>

          <div className="mp-form-group">
            <label>小盲 / 大盲注</label>
            <div className="mp-segmented">
              <button
                type="button"
                className={smallBlind === 5 ? "active" : ""}
                onClick={() => {
                  setSmallBlind(5);
                  setBigBlind(10);
                }}
              >
                5 / 10
              </button>
              <button
                type="button"
                className={smallBlind === 10 ? "active" : ""}
                onClick={() => {
                  setSmallBlind(10);
                  setBigBlind(20);
                }}
              >
                10 / 20
              </button>
              <button
                type="button"
                className={smallBlind === 25 ? "active" : ""}
                onClick={() => {
                  setSmallBlind(25);
                  setBigBlind(50);
                }}
              >
                25 / 50
              </button>
            </div>
          </div>

          <div className="mp-form-group">
            <label>初始比赛筹码</label>
            <div className="mp-segmented">
              <button
                type="button"
                className={startingStack === 1000 ? "active" : ""}
                onClick={() => setStartingStack(1000)}
              >
                1,000 (100BB)
              </button>
              <button
                type="button"
                className={startingStack === 2000 ? "active" : ""}
                onClick={() => setStartingStack(2000)}
              >
                2,000 (200BB)
              </button>
            </div>
          </div>

          <div className="mp-form-group">
            <label>起开人数要求</label>
            <div className="mp-segmented">
              <button
                type="button"
                className={minPlayers === 4 ? "active" : ""}
                onClick={() => setMinPlayers(4)}
              >
                标准 4 人起开 (推荐)
              </button>
              <button
                type="button"
                className={minPlayers === 2 ? "active" : ""}
                onClick={() => setMinPlayers(2)}
                title="便于快速测试联机"
              >
                双人快速对战 (测试)
              </button>
            </div>
          </div>

          <div className="mp-form-group">
            <label>每手单步常规思考时间 (超时自动弃牌)</label>
            <div className="mp-segmented">
              <button
                type="button"
                className={regularTurnSeconds === 15 ? "active" : ""}
                onClick={() => setRegularTurnSeconds(15)}
              >
                15 秒 (快节奏)
              </button>
              <button
                type="button"
                className={regularTurnSeconds === 20 ? "active" : ""}
                onClick={() => setRegularTurnSeconds(20)}
              >
                20 秒 (推荐)
              </button>
              <button
                type="button"
                className={regularTurnSeconds === 30 ? "active" : ""}
                onClick={() => setRegularTurnSeconds(30)}
              >
                30 秒 (宽松)
              </button>
            </div>
          </div>

          <div className="mp-form-group">
            <label>初始延时卡数量 (剩余 ≤5s 可延长 1 倍单次思考时间 +{regularTurnSeconds}s)</label>
            <div className="mp-segmented">
              <button
                type="button"
                className={initialTimeBankCards === 1 ? "active" : ""}
                onClick={() => setInitialTimeBankCards(1)}
              >
                1 张
              </button>
              <button
                type="button"
                className={initialTimeBankCards === 2 ? "active" : ""}
                onClick={() => setInitialTimeBankCards(2)}
              >
                2 张 (推荐)
              </button>
              <button
                type="button"
                className={initialTimeBankCards === 3 ? "active" : ""}
                onClick={() => setInitialTimeBankCards(3)}
              >
                3 张
              </button>
              <button
                type="button"
                className={initialTimeBankCards === 5 ? "active" : ""}
                onClick={() => setInitialTimeBankCards(5)}
              >
                5 张
              </button>
            </div>
          </div>

          <button
            type="button"
            className="mp-btn mp-btn-lg mp-btn-primary"
            onClick={handleCreateRoomClick}
          >
            立即创建房间
          </button>
        </div>

        {/* Card 2: Join Room */}
        <div className="mp-card">
          <div className="mp-card-head">
            <span className="mp-icon">🔑</span>
            <div>
              <h3>加入已有房间</h3>
              <p>输入朋友分享的 4 位房间号，直接入座或以旁观者身份观战</p>
            </div>
          </div>

          <div className="mp-form-group">
            <label>房间号</label>
            <input
              type="text"
              className="mp-input mp-input-lg"
              placeholder="例如：6888"
              maxLength={6}
              value={inputCode}
              onChange={(e) => setInputCode(e.target.value.toUpperCase())}
            />
          </div>

          <div className="mp-form-group mp-checkbox-group">
            <label>
              <input
                type="checkbox"
                checked={asSpectator}
                onChange={(e) => setAsSpectator(e.target.checked)}
              />
              <span>以旁观者（观战席）身份进入</span>
            </label>
          </div>

          <button
            type="button"
            className="mp-btn mp-btn-lg mp-btn-primary"
            disabled={!inputCode.trim()}
            onClick={handleJoinRoomClick}
          >
            进入房间
          </button>
        </div>
      </div>

      {/* Active Room List */}
      <section className="mp-room-list-section">
        <div className="mp-room-list-header">
          <h3>当前活跃房间 ({roomList.length})</h3>
          <button type="button" className="mp-btn-link" onClick={onRefreshRooms}>
            🔄 刷新列表
          </button>
        </div>

        {roomList.length === 0 ? (
          <div className="mp-empty-room-box">
            <span>暂无活跃房间，你可以点击上方「创建新房间」发起一局！</span>
          </div>
        ) : (
          <div className="mp-room-cards-grid">
            {roomList.map((room) => (
              <div key={room.code} className="mp-room-item-card">
                <div className="mp-room-item-head">
                  <span className="mp-room-code-tag">{room.code}</span>
                  <span className={`mp-room-status-badge ${room.status === "playing" ? "playing" : "waiting"}`}>
                    {room.status === "playing" ? "牌局进行中" : "等待准备"}
                  </span>
                </div>
                <div className="mp-room-item-body">
                  <div>房主：<b>{room.hostName}</b></div>
                  <div>盲注：<b>{room.blinds}</b></div>
                  <div>玩家：<b>{room.playerCount} / 8 人</b> （{room.spectatorCount} 人旁观）</div>
                </div>
                <div className="mp-room-item-foot">
                  <button
                    type="button"
                    className="mp-btn mp-btn-sm mp-btn-primary"
                    onClick={() => onJoinRoom(room.code, false)}
                  >
                    入座加入
                  </button>
                  <button
                    type="button"
                    className="mp-btn mp-btn-sm mp-btn-secondary"
                    onClick={() => onJoinRoom(room.code, true)}
                  >
                    观战
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
