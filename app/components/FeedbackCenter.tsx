"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { FeedbackKind, FeedbackListResponse, FeedbackRecord, FeedbackRuntimeInfo, FeedbackStatus } from "../../lib/feedback/types";

const STATUS_LABELS: Record<FeedbackStatus, string> = {
  pending: "未处理",
  processing: "处理中",
  resolved: "已处理",
};

function formatBeijingTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value)).replaceAll("/", "-");
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `请求失败（${response.status}）`);
  return body;
}

export default function FeedbackCenter() {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<FeedbackKind>("player");
  const [developerKey, setDeveloperKey] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [items, setItems] = useState<FeedbackRecord[]>([]);
  const [runtime, setRuntime] = useState<FeedbackRuntimeInfo>();
  const [playerName, setPlayerName] = useState(() => {
    if (typeof window === "undefined") return "玩家";
    return window.localStorage.getItem("riverlab_mp_name")?.trim().slice(0, 24) || "玩家";
  });
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const authHeaders = useMemo(() => developerKey ? { "x-developer-key": developerKey } : undefined, [developerKey]);

  const load = useCallback(async (targetKind: FeedbackKind, key = developerKey) => {
    if (targetKind === "developer" && !key) return;
    setBusy(true);
    setMessage("");
    try {
      const headers = key ? { "x-developer-key": key } : undefined;
      const result = await requestJson<FeedbackListResponse>(`/api/feedback?kind=${targetKind}`, { headers });
      setItems(result.items);
      if (key) {
        const info = await requestJson<FeedbackRuntimeInfo>("/api/feedback/runtime", { headers });
        setRuntime(info);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "读取反馈失败");
      if (targetKind === "developer") setDeveloperKey("");
    } finally {
      setBusy(false);
    }
  }, [developerKey]);

  useEffect(() => {
    if (!open || (kind === "developer" && !developerKey)) return;
    const timer = window.setTimeout(() => void load(kind), 0);
    return () => window.clearTimeout(timer);
  }, [open, kind, developerKey, load]);

  const selectKind = (next: FeedbackKind) => {
    setKind(next);
    setItems([]);
    setMessage("");
  };

  const unlockDeveloper = async (event: FormEvent) => {
    event.preventDefault();
    if (!/^\d+$/.test(keyInput)) {
      setMessage("开发者密钥只能包含数字");
      return;
    }
    setBusy(true);
    try {
      await requestJson<FeedbackListResponse>("/api/feedback?kind=developer", { headers: { "x-developer-key": keyInput } });
      setDeveloperKey(keyInput);
      setKeyInput("");
      setMessage("开发者模式已解锁");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "开发者密钥不正确");
    } finally {
      setBusy(false);
    }
  };

  const submitFeedback = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      await requestJson("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders || {}) },
        body: JSON.stringify({ kind, playerName, content }),
      });
      setContent("");
      setMessage("反馈已提交");
      await load(kind);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "提交反馈失败");
    } finally {
      setBusy(false);
    }
  };

  const updateStatus = async (id: string, status: FeedbackStatus) => {
    if (!developerKey) return;
    setBusy(true);
    try {
      await requestJson(`/api/feedback/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-developer-key": developerKey },
        body: JSON.stringify({ status }),
      });
      await load(kind);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "更新状态失败");
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    if (!developerKey) return;
    setBusy(true);
    try {
      await requestJson("/api/feedback/run", { method: "POST", headers: { "x-developer-key": developerKey } });
      setMessage("已启动一轮自动修复；运行期间可以关闭此窗口");
      window.setTimeout(() => void load("developer"), 1200);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "启动自动修复失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className="feedback-fab" onClick={() => setOpen(true)} aria-label="打开反馈中心">
        <span>✦</span> 反馈
      </button>
      {open && (
        <div className="feedback-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
          <section className="feedback-dialog" role="dialog" aria-modal="true" aria-labelledby="feedback-title">
            <header className="feedback-header">
              <div><span className="feedback-eyebrow">RIVERLAB</span><h2 id="feedback-title">反馈中心</h2></div>
              <button type="button" className="feedback-close" onClick={() => setOpen(false)} aria-label="关闭">×</button>
            </header>

            <nav className="feedback-tabs" aria-label="反馈类型">
              <button type="button" className={kind === "player" ? "active" : ""} onClick={() => selectKind("player")}>玩家反馈</button>
              <button type="button" className={kind === "developer" ? "active" : ""} onClick={() => selectKind("developer")}>开发者反馈</button>
            </nav>

            {kind === "developer" && !developerKey ? (
              <form className="feedback-unlock" onSubmit={unlockDeveloper}>
                <span className="feedback-lock">⌁</span>
                <h3>开发者队列</h3>
                <p>输入纯数字密钥后，才可查看和提交开发者反馈。</p>
                <input aria-label="开发者密钥" inputMode="numeric" pattern="[0-9]*" type="password" value={keyInput} onChange={(event) => setKeyInput(event.target.value.replace(/\D/g, ""))} placeholder="开发者密钥" maxLength={32} autoFocus />
                <button type="submit" disabled={busy || !keyInput}>验证并进入</button>
                {message && <p className="feedback-message">{message}</p>}
              </form>
            ) : (
              <div className="feedback-body">
                <form className="feedback-compose" onSubmit={submitFeedback}>
                  <div className="feedback-compose-title">
                    <div><h3>提交{kind === "player" ? "玩家" : "开发者"}反馈</h3><p>{kind === "developer" ? "问题会进入本机自动修复队列" : "告诉我们哪里可以做得更好"}</p></div>
                    {kind === "developer" && <span className="feedback-private-badge">已验证</span>}
                  </div>
                  <label>玩家名字<input value={playerName} onChange={(event) => setPlayerName(event.target.value)} maxLength={24} required /></label>
                  <label>反馈内容<textarea value={content} onChange={(event) => setContent(event.target.value)} minLength={2} maxLength={4000} rows={4} placeholder={kind === "developer" ? "请写明复现步骤、实际结果和预期结果……" : "请输入你的建议或遇到的问题……"} required /></label>
                  <div className="feedback-compose-footer"><span>{content.length}/4000</span><button type="submit" disabled={busy || content.trim().length < 2}>提交反馈</button></div>
                </form>

                <div className="feedback-queue-heading">
                  <div><h3>{kind === "player" ? "玩家反馈队列" : "开发者反馈队列"}</h3><p>最新提交排在前面 · 北京时间</p></div>
                  <div className="feedback-queue-actions">
                    {kind === "developer" && <button type="button" onClick={runNow} disabled={busy || runtime?.running}>{runtime?.running ? "修复运行中" : "立即尝试修复"}</button>}
                    <button type="button" onClick={() => void load(kind)} disabled={busy}>刷新</button>
                  </div>
                </div>

                {kind === "developer" && runtime && (
                  <div className="feedback-runtime">
                    <span>AI：{runtime.provider}</span><span>{runtime.running ? "正在运行" : "等待调度"}</span>
                    {runtime.nextSweepAt && <span>下次：{formatBeijingTime(runtime.nextSweepAt)}</span>}
                  </div>
                )}
                {message && <p className="feedback-message">{message}</p>}
                {busy && items.length === 0 ? <div className="feedback-empty">正在读取……</div> : items.length === 0 ? <div className="feedback-empty">暂无反馈</div> : (
                  <div className="feedback-list">
                    {items.map((item) => (
                      <article className="feedback-card" key={item.id}>
                        <div className="feedback-card-top"><strong>{item.playerName}</strong><span className={`feedback-status ${item.status}`}>{STATUS_LABELS[item.status]}</span></div>
                        <p className="feedback-content">{item.content}</p>
                        <div className="feedback-meta"><span>{item.id}</span><time dateTime={item.createdAt}>{formatBeijingTime(item.createdAt)}</time></div>
                        <p className="feedback-detail">{item.statusDetail}</p>
                        {item.branchName && <div className="feedback-result"><b>分支</b><code>{item.branchName}</code>{item.commitHash && <code>{item.commitHash.slice(0, 10)}</code>}</div>}
                        {item.aiSummary && <details><summary>查看 AI 处理摘要</summary><p>{item.aiSummary}</p></details>}
                        {item.lastError && <details className="feedback-error"><summary>查看最近错误</summary><pre>{item.lastError}</pre></details>}
                        {developerKey && (
                          <div className="feedback-admin-actions">
                            {item.status === "pending" && <button type="button" onClick={() => void updateStatus(item.id, "processing")}>开始人工处理</button>}
                            {item.status !== "resolved" && <button type="button" className="resolve" onClick={() => void updateStatus(item.id, "resolved")}>标记已处理</button>}
                            {item.status === "resolved" && <button type="button" onClick={() => void updateStatus(item.id, "pending")}>重新打开</button>}
                          </div>
                        )}
                      </article>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
