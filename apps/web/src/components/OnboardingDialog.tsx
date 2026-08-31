import { Check, ChevronLeft, ChevronRight, CircleAlert, LoaderCircle, Play, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useAppStore } from "../store/useAppStore";
import type { AppLanguage, AppSection, ConnectionDiagnosticDTO } from "../types";
import { Button, Modal } from "./ui";

const STORAGE_KEY = "star-companion:onboarding:v1";
export const OPEN_ONBOARDING_EVENT = "star-companion:open-onboarding";
export const ONBOARDING_COMPLETED_EVENT = "star-companion:onboarding-completed";

type SavedOnboarding = { dismissed?: boolean; completed?: boolean; lastStep?: number };

const readSaved = (): SavedOnboarding => {
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}") as SavedOnboarding;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
};

const save = (value: SavedOnboarding) => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Onboarding persistence is optional when storage is unavailable.
  }
};

export const reopenOnboarding = () => {
  const saved = readSaved();
  save({ ...saved, dismissed: false, lastStep: saved.lastStep ?? 0 });
  window.dispatchEvent(new Event(OPEN_ONBOARDING_EVENT));
};
export const markOnboardingCompleted = () => {
  save({ completed: true, dismissed: true, lastStep: 4 });
  window.dispatchEvent(new Event(ONBOARDING_COMPLETED_EVENT));
};

type Props = {
  language: AppLanguage;
  onNavigate: (section: AppSection) => void;
  onNewChat: () => void;
};

export function OnboardingDialog({ language, onNavigate, onNewChat }: Props) {
  const { activeSection, readiness, readinessLoading, refreshReadiness } = useAppStore();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(() => Math.min(4, Math.max(0, readSaved().lastStep ?? 0)));
  const [testing, setTesting] = useState(false);
  const [activeTestId, setActiveTestId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ConnectionDiagnosticDTO | null>(null);
  const zh = language === "zh-CN";

  useEffect(() => {
    if (!readiness || readinessLoading || !readiness.serverReachable) return;
    const saved = readSaved();
    if (!saved.completed && !saved.dismissed && activeSection === "chat" && !readiness.hasCharacter && !readiness.hasChat) setOpen(true);
  }, [activeSection, readiness, readinessLoading]);

  useEffect(() => {
    const saved = readSaved();
    if (saved.dismissed === false && saved.lastStep !== undefined) setOpen(true);
  }, []);

  useEffect(() => {
    const handleOpen = () => {
      const saved = readSaved();
      save({ ...saved, dismissed: false });
      setStep(Math.min(4, Math.max(0, saved.lastStep ?? 0)));
      setOpen(true);
    };
    const handleCompleted = () => setOpen(false);
    window.addEventListener(OPEN_ONBOARDING_EVENT, handleOpen);
    window.addEventListener(ONBOARDING_COMPLETED_EVENT, handleCompleted);
    return () => {
      window.removeEventListener(OPEN_ONBOARDING_EVENT, handleOpen);
      window.removeEventListener(ONBOARDING_COMPLETED_EVENT, handleCompleted);
    };
  }, []);

  const steps = useMemo(() => [
    {
      title: zh ? "欢迎使用 Star Companion" : "Welcome to Star Companion",
      detail: zh
        ? "数据默认保存在本机，API Key 只由后端本地加密保存，网页不会读取明文密钥。只有你主动使用模型功能时，请求才会发送给你自行配置的第三方供应商。本项目不提供云端账号或免费模型额度。引导可随时关闭，并从设置或应用内文档重新打开。"
        : "Your data stays local by default. API keys are encrypted locally by the backend and never read in plaintext by the web app. Requests go to your configured third-party provider only when you use a model feature. This project includes no cloud account or free model quota. Close this guide anytime and reopen it from Settings or in-app docs.",
      done: true
    },
    {
      title: zh ? "准备一个角色" : "Prepare a character",
      detail: readiness?.hasAvailableCharacter
        ? (zh ? `已有 ${readiness.characterCount} 个可用角色，可继续下一步。` : `${readiness.characterCount} character(s) are available. Continue when ready.`)
        : (zh ? "创建原创角色或导入你拥有的角色卡。应用不会自动添加默认角色。" : "Create an original character or import a character card you own. The app does not add default characters automatically."),
      done: Boolean(readiness?.hasAvailableCharacter)
    },
    {
      title: zh ? "配置供应商与聊天模型" : "Configure provider and chat model",
      detail: readiness?.configurationValid
        ? (zh ? "已保存的聊天模型配置通过静态检查。" : "The saved chat model configuration passed static checks.")
        : (zh ? "在设置中填写供应商、Base URL、密钥与模型，并为聊天模型声明文本能力。密钥不会显示在诊断结果中。" : "In Settings, save a provider, base URL, key, and model, then declare text capability for the chat model. Diagnostics never display your key."),
      done: Boolean(readiness?.configurationValid)
    },
    {
      title: zh ? "安全检查连接" : "Check the connection safely",
      detail: readiness?.connectionStatus.status === "succeeded"
        ? (zh ? "供应商元数据已验证，未调用模型推理。" : "Provider metadata was verified without model inference.")
        : (zh ? "默认只读取供应商模型元数据，不发送角色或聊天内容，通常不会产生推理费用。可选的最小推理测试会另行确认。" : "The default check reads provider model metadata only. It sends no character or chat content and normally incurs no inference cost. An optional minimal inference test requires separate confirmation."),
      done: readiness?.connectionStatus.status === "succeeded"
    },
    {
      title: zh ? "开始第一次聊天" : "Start your first chat",
      detail: readiness?.hasChat
        ? (zh ? "已有聊天可继续。发送第一条消息并收到流式回复后，引导会自动完成。" : "A chat is ready. The guide completes after you send a message and receive the first streamed reply.")
        : (zh ? "选择角色创建聊天。只有你主动发送消息才会调用模型；浏览引导不会产生费用。" : "Choose a character to create a chat. The model is called only after you send a message; browsing this guide is free."),
      done: Boolean(readiness?.hasChat)
    }
  ], [readiness, zh]);

  const close = () => {
    save({ ...readSaved(), dismissed: true, lastStep: step });
    setOpen(false);
  };

  const go = (section: AppSection) => {
    save({ ...readSaved(), dismissed: true, lastStep: step });
    setOpen(false);
    onNavigate(section);
  };

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    const timer = window.setTimeout(() => {
      void refreshReadiness().then((current) => setActiveTestId(current.connectionStatus.testId));
    }, 120);
    try {
      const result = await api.readiness.testConnection("metadata");
      setTestResult(result);
      await refreshReadiness();
    } catch {
      await refreshReadiness();
    } finally {
      window.clearTimeout(timer);
      setTesting(false);
      setActiveTestId(null);
    }
  };

  const cancelTest = async () => {
    if (!activeTestId) return;
    await api.readiness.cancelConnectionTest(activeTestId).catch(() => undefined);
  };

  if (!open || !readiness) return null;
  const current = steps[step];

  return (
    <Modal title={zh ? "首次使用引导" : "First-use guide"} onClose={close} panelClassName="sm:max-w-xl">
      <div data-testid="onboarding-dialog">
        <div className="mb-5 flex items-center gap-2" aria-label={zh ? "引导进度" : "Guide progress"}>
          {steps.map((item, index) => (
            <button
              aria-current={index === step ? "step" : undefined}
              aria-label={`${index + 1}. ${item.title}`}
              className={`grid h-9 min-w-9 flex-1 place-items-center rounded-md border text-xs font-semibold ${index === step ? "border-ember-400 bg-ember-500 text-accentForeground" : item.done ? "border-emerald-400/35 bg-emerald-500/10 text-emerald-200" : "border-white/10 bg-ink-950 text-ink-400"}`}
              key={item.title}
              type="button"
              onClick={() => setStep(index)}
            >
              {item.done && index !== step ? <Check size={15} /> : index + 1}
            </button>
          ))}
        </div>

        <div className="rounded-lg border border-white/10 bg-ink-950/45 p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <div className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full ${current.done ? "bg-emerald-500/10 text-emerald-300" : "bg-amber-500/10 text-amber-200"}`}>
              {current.done ? <ShieldCheck size={18} /> : <CircleAlert size={18} />}
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">{zh ? `第 ${step + 1} 步，共 5 步` : `Step ${step + 1} of 5`}</p>
              <h4 className="mt-1 text-base font-semibold text-ink-50">{current.title}</h4>
              <p className="mt-2 text-sm leading-6 text-ink-300">{current.detail}</p>
            </div>
          </div>

          {step === 1 ? (
            <div className="mt-4 flex flex-wrap gap-2">
              <Button onClick={() => go("characters")}>{readiness.hasAvailableCharacter ? (zh ? "管理角色" : "Manage characters") : (zh ? "创建或导入角色" : "Create or import")}</Button>
            </div>
          ) : null}
          {step === 2 ? (
            <div className="mt-4 flex flex-wrap gap-2">
              <Button onClick={() => go("settings")}>{zh ? "打开模型设置" : "Open model settings"}</Button>
            </div>
          ) : null}
          {step === 3 ? (
            <div className="mt-4 space-y-3">
              {testResult?.status === "failed" ? <p className="text-sm text-rose-200" role="alert">{zh ? `连接未通过：${testResult.errorCode ?? "connection_failed"}。请按诊断标识排查，不要粘贴密钥或服务商原始响应。` : `Connection failed: ${testResult.errorCode ?? "connection_failed"}. Use the diagnostic ID when troubleshooting; do not paste keys or raw provider responses.`}</p> : null}
              <div className="flex flex-wrap gap-2">
                <Button disabled={testing || !readiness.configurationValid} onClick={() => void testConnection()}>
                  {testing ? <LoaderCircle className="animate-spin" size={16} /> : <Play size={16} />}
                  {zh ? "运行无推理测试" : "Run no-inference test"}
                </Button>
                {testing && activeTestId ? <Button variant="secondary" onClick={() => void cancelTest()}><X size={16} />{zh ? "取消" : "Cancel"}</Button> : null}
                {!readiness.configurationValid ? <Button variant="secondary" onClick={() => go("settings")}>{zh ? "先修复配置" : "Fix configuration first"}</Button> : null}
              </div>
            </div>
          ) : null}
          {step === 4 ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {readiness.hasChat ? <Button onClick={() => go("chat")}>{zh ? "继续聊天" : "Continue chat"}</Button> : <Button disabled={!readiness.hasAvailableCharacter} onClick={() => { close(); onNewChat(); }}>{zh ? "创建聊天" : "Create chat"}</Button>}
              {!readiness.hasAvailableCharacter ? <Button variant="secondary" onClick={() => go("characters")}>{zh ? "先准备角色" : "Prepare a character"}</Button> : null}
            </div>
          ) : null}
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <Button variant="ghost" onClick={close}>{zh ? "稍后继续" : "Continue later"}</Button>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={step === 0} onClick={() => setStep((value) => Math.max(0, value - 1))}><ChevronLeft size={16} />{zh ? "上一步" : "Back"}</Button>
            {step < 4 ? <Button onClick={() => setStep((value) => Math.min(4, value + 1))}>{zh ? "下一步" : "Next"}<ChevronRight size={16} /></Button> : null}
          </div>
        </div>
      </div>
    </Modal>
  );
}
