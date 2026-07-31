import { Component } from "react";
import { I18nContext } from "../i18n.jsx";

export class AppErrorBoundary extends Component {
  static contextType = I18nContext;

  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("DeepFaceLab WebUI render failed", error, errorInfo);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const { t } = this.context;

    return (
      <main className="app-error-boundary" role="alert">
        <div className="app-error-card">
          <span className="app-error-kicker">{t("界面恢复模式")}</span>
          <h1>{t("页面渲染遇到异常")}</h1>
          <p>
            {t("后台任务不会因此停止。可以重新加载界面；若问题持续出现，请保留下面的错误信息。")}
          </p>
          <code>{this.state.error?.message ?? t("未知渲染错误")}</code>
          <button type="button" onClick={() => window.location.reload()}>
            {t("重新加载界面")}
          </button>
        </div>
      </main>
    );
  }
}
